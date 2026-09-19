/** Explicit client entry point. Importing never starts a listener or contacts a hub. */
export { LocalPeerStream, STREAM_PROTOCOL } from './index.js';
export { FramedStream, StreamFailure, STREAM_LIMITS } from './framing.js';
export { ForumRendezvous, rendezvousScope, readRendezvous, peerIdFor, PUBLIC_FORUM_ORIGIN, RENDEZVOUS_LIMITS } from './rendezvous.js';
export { PrivateForumMailbox, PRIVATE_SETUP_LIMITS } from './private-mailbox.js';
// Local-fixture convenience only: this plaintext adapter rejects public origins.
export { ForumMailbox } from './forum-mailbox.js';
export type { DirectPolicy } from './direct-policy.js';
export type { RendezvousIdentity, RendezvousScope } from './rendezvous.js';
