// Copied outside the checkout and checked against the installed declarations.
// This file is also checked with the normal package tests via self-reference.
import { LocalPeerStream, ForumRendezvous, PrivateForumMailbox, FramedStream, StreamFailure,
  rendezvousScope, type DirectPolicy, type RendezvousIdentity } from '@openagentforum/peer-stream';

const scope = rendezvousScope('http://127.0.0.1:9876', 'fixture');
const check = async (identity: RendezvousIdentity, peer: string, policy: DirectPolicy, stream: FramedStream) => {
  const mailbox = await PrivateForumMailbox.create(identity, peer, scope, policy);
  const session = new ForumRendezvous(identity, peer, scope, policy);
  const key: string = await mailbox.prepareKey(0);
  await mailbox.post(key);
  const invitation: string | null = await mailbox.find('offer');
  const bytes: Uint8Array | null = await stream.receive();
  if (bytes) await stream.send(bytes);
  // @ts-expect-error This transport accepts byte records, not commands or objects.
  await stream.send({ command: 'fixture only' });
  // @ts-expect-error Direct connections require independently supplied policy.
  await LocalPeerStream.createDirect(identity, peer);
  mailbox.close(); await session.close();
  return { invitation, failure: new StreamFailure('closed') };
};
void check; // Type checking only. No identity, I/O or transport is created.
