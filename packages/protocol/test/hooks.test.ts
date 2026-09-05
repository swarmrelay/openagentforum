import { describe, it, expect } from 'vitest';
import {
  generateAgentKeyPair, validateHookUrl, classifyAddress, deriveHookId, signHookAction, verifyHookAction, validateHookSpec,
  hookMatches, shouldWake, hmacSha256Hex, verifyWakeSignature, signEnvelope,
} from '../src/index.js';

describe('wake hooks: URL and address rules (RFC 0002 §3)', () => {
  it('accepts only https on 443 to a public name', () => {
    expect(validateHookUrl('https://agent.example.net/oaf-wake').ok).toBe(true);
    for (const bad of ['http://agent.example.net/x', 'https://agent.example.net:8443/x', 'https://user:pw@agent.example.net/x', 'https://agent.example.net/x#frag',
      'https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest', 'https://metadata.google.internal/x', 'https://foo.internal/x', 'https://box.local/x', 'https://localhost/x', 'https://intranet/x']) {
      expect(validateHookUrl(bad).ok, bad).toBe(false);
    }
  });
  it('classifies every denylisted range, including IPv4-mapped and NAT64', () => {
    for (const ip of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.5', '172.31.255.255', '192.0.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
      '::', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a00:1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1',
      // (#101) 6to4 and IPv4-compatible embeddings of private / metadata addresses
      '2002:a00:1::1', '2002:a9fe:a9fe::', '2002:7f00:1::', '::10.0.0.1', '::169.254.169.254', '::a9fe:a9fe',
      // (#102) IPv4-translated ::ffff:0:v4
      '::ffff:0:10.0.0.1', '::ffff:0:a00:1', '::ffff:0:169.254.169.254',
      // Teredo is refused outright
      '2001:0:4136:e378:8000:63bf:3fff:fdd2']) {
      expect(classifyAddress(ip), ip).not.toBe('public');
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '104.16.0.1', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8', '2a00:1450:4001::1', '2002:808:808::1', '::ffff:0:8.8.8.8', '::8.8.8.8']) {
      expect(classifyAddress(ip), ip).toBe('public');
    }
    expect(classifyAddress('not-an-ip')).not.toBe('public');
    for (const ip of ['fec0::1', 'feff::1', '100::1', '100:0:0:1::1', '2001:2::1', '3fff::1', '5f00::1', '2606:4700::1111%eth0', '1:2:3:4:5:6:7:8::']) {
      expect(classifyAddress(ip), ip).not.toBe('public');
    }
  });
});

describe('wake hooks: proofs (RFC 0002 §2, #76, #97)', () => {
  it('binds a set proof to its normalized URL slot, even when a mismatched slot is correctly signed', async () => {
    const k = await generateAgentKeyPair();
    const hook = { url: 'https://AGENT.EXAMPLE.NET.:443/wake', channels: ['general'], secret: 's'.repeat(40) };
    const hookId = await deriveHookId(k.agentId, 'https://agent.example.net/wake');
    const proof = { action: 'set' as const, agentId: k.agentId, hookId, timestamp: Date.now(), hook };
    const signature = await signHookAction(proof, k.signingPrivateKey);
    expect((await verifyHookAction({ ...proof, signature }, k.signingPublicKey)).valid).toBe(true);
    const wrong = { ...proof, hookId: await deriveHookId(k.agentId, 'https://other.example.net/wake') };
    const wrongSignature = await signHookAction(wrong, k.signingPrivateKey);
    expect(await verifyHookAction({ ...wrong, signature: wrongSignature }, k.signingPublicKey)).toMatchObject({ valid: false, error: expect.stringContaining('normalized URL') });
    const malformed = { ...proof, hook: { ...hook, secret: 'short' } };
    expect((await verifyHookAction({ ...malformed, signature: await signHookAction(malformed, k.signingPrivateKey) }, k.signingPublicKey)).valid).toBe(false);
  });
  it('signs and verifies with freshness, canonical hex, and a stable proof digest across body formatting', async () => {
    const k = await generateAgentKeyPair();
    const hook = validateHookSpec({ url: 'https://agent.example.net/oaf-wake', channels: ['general'], secret: 's'.repeat(40) });
    expect(hook.ok).toBe(true);
    const hookId = await deriveHookId(k.agentId, 'https://agent.example.net/oaf-wake');
    expect(hookId).toMatch(/^hook_[0-9a-f]{16}$/);
    const ts = Date.now();
    const sig = await signHookAction({ action: 'set', agentId: k.agentId, hookId, timestamp: ts, hook: (hook as any).hook }, k.signingPrivateKey);
    const v = await verifyHookAction({ action: 'set', agentId: k.agentId, hookId, timestamp: ts, hook: (hook as any).hook, signature: sig }, k.signingPublicKey);
    expect(v.valid).toBe(true);
    // a reformatted body (key order) is the same proof: same digest
    const reordered = { coalesceSeconds: 10, secret: 's'.repeat(40), mentionsOnly: false, channels: ['general'], url: 'https://agent.example.net/oaf-wake' } as any;
    const v2 = await verifyHookAction({ action: 'set', agentId: k.agentId, hookId, timestamp: ts, hook: reordered, signature: sig }, k.signingPublicKey);
    expect(v2.valid && v.valid && v2.proofDigest === v.proofDigest).toBe(true);
    // stale, uppercase, wrong key
    expect((await verifyHookAction({ action: 'set', agentId: k.agentId, hookId, timestamp: ts - 10 * 60_000, hook: (hook as any).hook, signature: sig }, k.signingPublicKey)).valid).toBe(false);
    expect((await verifyHookAction({ action: 'set', agentId: k.agentId, hookId, timestamp: ts, hook: (hook as any).hook, signature: sig.toUpperCase() }, k.signingPublicKey)).valid).toBe(false);
    const other = await generateAgentKeyPair();
    expect((await verifyHookAction({ action: 'set', agentId: k.agentId, hookId, timestamp: ts, hook: (hook as any).hook, signature: sig }, other.signingPublicKey)).valid).toBe(false);
    // delete / renew / list strings verify with their own shapes
    for (const action of ['delete', 'renew', 'list'] as const) {
      const s2 = await signHookAction({ action, agentId: k.agentId, hookId, timestamp: ts }, k.signingPrivateKey);
      expect((await verifyHookAction({ action, agentId: k.agentId, hookId, timestamp: ts, signature: s2 }, k.signingPublicKey)).valid).toBe(true);
    }
  });
  it('validates hook specs', () => {
    const base = { url: 'https://a.example.net/w', channels: ['general'], secret: 'x'.repeat(32) };
    expect(validateHookSpec(base).ok).toBe(true);
    expect(validateHookSpec({ ...base, secret: 'short' }).ok).toBe(false);
    expect(validateHookSpec({ ...base, channels: [] }).ok).toBe(false);
    expect(validateHookSpec({ ...base, channels: ['Bad Name'] }).ok).toBe(false);
    expect(validateHookSpec({ ...base, coalesceSeconds: 1 }).ok).toBe(false);
    expect(validateHookSpec({ ...base, url: 'http://a.example.net/w' }).ok).toBe(false);
  });
});

describe('wake hooks: matching, coalescing, HMAC (RFC 0002 §4, §5)', () => {
  it('matches by channel, star (public only), type, mention, membership, and never for the agent itself', async () => {
    const me = await generateAgentKeyPair();
    const other = await generateAgentKeyPair();
    const env = await signEnvelope({ channel: 'general', sender: other.agentId, type: 'intel', sequence: 0, payload: { message: `hi ${me.agentId}` } }, other.signingPrivateKey);
    const pub = { agentId: me.agentId, channelIsPrivate: false, agentIsMember: false };
    expect(hookMatches({ channels: ['general'] }, env, pub)).toEqual({ mentioned: true });
    expect(hookMatches({ channels: ['*'] }, env, pub)).toEqual({ mentioned: true });
    expect(hookMatches({ channels: ['sec-research'] }, env, pub)).toBe(null);
    expect(hookMatches({ channels: ['general'], types: ['poll', 'vote'] }, env, pub)).toBe(null);
    expect(hookMatches({ channels: ['general'], mentionsOnly: true }, { ...env, payload: { message: 'no mention' } }, pub)).toBe(null);
    expect(hookMatches({ channels: ['general'] }, { ...env, sender: me.agentId }, pub)).toBe(null);
    const priv = { agentId: me.agentId, channelIsPrivate: true, agentIsMember: true };
    expect(hookMatches({ channels: ['*'] }, { ...env, channel: 'sec-private' }, priv)).toBe(null);
    expect(hookMatches({ channels: ['sec-private'], mentionsOnly: true }, { ...env, channel: 'sec-private', encrypted: true } as any, priv)).toEqual({ mentioned: false });
    expect(hookMatches({ channels: ['sec-private'] }, { ...env, channel: 'sec-private' }, { ...priv, agentIsMember: false })).toBe(null);
  });
  it('coalesces per channel and signs bodies with HMAC-SHA256 the receiver can verify', async () => {
    const state: any = {};
    expect(shouldWake(state, 'general', 10, 1000)).toBe(true);
    expect(shouldWake(state, 'general', 10, 5000)).toBe(false);
    expect(shouldWake(state, 'other', 10, 5000)).toBe(true);
    expect(shouldWake(state, 'general', 10, 11_001)).toBe(true);
    const body = JSON.stringify({ kind: 'wake', channel: 'general' });
    const sig = await hmacSha256Hex('secret'.repeat(6), body);
    expect(await verifyWakeSignature('secret'.repeat(6), body, `hmac-sha256=${sig}`)).toBe(true);
    expect(await verifyWakeSignature('secret'.repeat(6), body + ' ', `hmac-sha256=${sig}`)).toBe(false);
    expect(await verifyWakeSignature('wrong'.repeat(7), body, `hmac-sha256=${sig}`)).toBe(false);
    expect(await verifyWakeSignature('secret'.repeat(6), body, null)).toBe(false);
  });
});
