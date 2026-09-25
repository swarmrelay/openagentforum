/** Bounded, fixed-path forum transport. No room mutations or implicit registration. */
import { deriveAgentId } from '@openagentforum/protocol';
import { roomDeadline, roomWithSignal, readRoomBody, cancelRoomBody } from './http-contract.js';
import { invitationFailure, invitationHex, invitationScope, ROOM_INVITATION_LIMITS, type RoomInvitationScope } from './invitation-wire.js';

export class RoomInvitationHttp {
  readonly scope: Readonly<RoomInvitationScope>;
  readonly #fetch: typeof fetch;
  #busy = false;
  constructor(scope: RoomInvitationScope, fetchImpl: typeof fetch = fetch) {
    this.scope = invitationScope(scope); this.#fetch = fetchImpl;
  }
  async #request(path: string, body?: string): Promise<any> {
    if (this.#busy || (body !== undefined && Buffer.byteLength(body) > ROOM_INVITATION_LIMITS.envelopeBytes)) invitationFailure();
    this.#busy = true;
    const deadline = roomDeadline(5000); let response: Response | undefined;
    const url = this.scope.hub + path;
    try {
      response = await roomWithSignal<Response>(this.#fetch(url, { method: body === undefined ? 'GET' : 'POST', body,
        signal: deadline.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      }).then(result => { if (deadline.signal.aborted) cancelRoomBody(result.body); return result; }), deadline.signal);
      if (!response.ok || response.redirected || (response.url && response.url !== url)
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) invitationFailure();
      return JSON.parse(await readRoomBody(response.body, 262144, deadline.signal));
    } catch { return invitationFailure(); }
    finally { deadline.close(); if (response) cancelRoomBody(response.body); this.#busy = false; }
  }
  /** Candidate only: selecting this full key remains the caller's explicit decision. */
  async discover(agentId: string): Promise<string> {
    if (!/^agent_[0-9a-f]{16}$/.test(agentId)) invitationFailure();
    const key = (await this.#request(`/v1/agents/${agentId}`))?.agent?.publicKey;
    if (!invitationHex(key, 64) || await deriveAgentId(key) !== agentId) invitationFailure(); return key;
  }
  async records(): Promise<unknown[]> {
    const result = await this.#request(`/v1/channels/${this.scope.channel}/messages?after=0&limit=100`);
    if (!Array.isArray(result?.messages) || result.messages.length >= 100) invitationFailure();
    return result.messages;
  }
  submit(wire: string): Promise<any> { return this.#request(`/v1/channels/${this.scope.channel}/messages`, wire); }
}
