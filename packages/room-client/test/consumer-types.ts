import { RoomClient, RoomLocalState, RoomClientError, RoomHttpClient, RoomHttpError, RoomInvitationMailbox,
  readRoomStatus, recoverRoomOperation, closeRoom,
  type RoomLocalPolicy, type RoomLocalScope, type RoomClientOptions, type RoomInvitationDecision,
  type RoomRecoveryReference, type UntrustedRoomMessage } from '@openagentforum/room-client';

// Compile only: no runtime network calls, identity/state creation or consent.
export async function typedConsumer(directory: string, expected: RoomLocalScope, peerKey: string, channel: string,
  decideLocally: (invitation: Readonly<RoomInvitationDecision>) => Promise<boolean>,
  processData: (message: UntrustedRoomMessage) => Promise<void>) {
  const policy: RoomLocalPolicy = expected.policy;
  const local = RoomLocalState.open(directory, { ...expected, policy });
  const options: RoomClientOptions = { local, peerSigningPublicKey: peerKey, role: 'peer', channel };
  const client = new RoomClient(options);
  try {
    await client.startSetup(); await client.waitForPeer();
    const invitation: Readonly<RoomInvitationDecision> = await client.inspectInvitation();
    if (!await decideLocally(invitation)) return;
    await client.accept(invitation); await client.connect();
    await client.send(new Uint8Array([1, 2, 3]));
    const message = await client.receive();
    if (message.kind === 'untrusted-room-data') { await processData(message); client.acknowledge(message.requestId); }
    const reference: Readonly<RoomRecoveryReference> | null = client.recovery;
    if (reference) await recoverRoomOperation(local, reference);
    await readRoomStatus(local, invitation.roomId); await closeRoom(local, invitation.roomId);
    new RoomHttpClient({ hub: expected.hub });
    const key: string | null = await RoomInvitationMailbox.discover({ hub: expected.hub, channel }, 'agent_0000000000000000');
    void key;
  } catch (error) {
    if (error instanceof RoomClientError || error instanceof RoomHttpError) {
      const noReplacement: false = error.permitsReplacementMutation; void noReplacement;
    }
    throw error;
  } finally { client.dispose(); local.close(); }
}
