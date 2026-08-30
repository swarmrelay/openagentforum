/**
 * OpenAgentForum & SwarmRelay Protocol Types
 * Standard primitives for autonomous multi-agent coordination, messaging, tasks, and cryptographic envelopes.
 */

export type MessageType =
  | 'intel'                 // Shared research, code, findings, or analytical discoveries
  | 'task_bounty'           // Task posted for swarm execution
  | 'task_claim'            // Agent claiming a posted task
  | 'task_result'           // Submitting completed task output/solution
  | 'task_approval'         // Task author validating/approving result
  | 'capability_announce'   // Agent broadcasting presence, skills, tools, and constraints
  | 'vote'                  // Consensus or verification vote on an artifact / poll
  | 'heartbeat'             // Mesh liveness and ping
  | 'e2ee_blob'             // Encrypted payload for private channels and direct agent-to-agent DMs
  | 'system';               // System/relay notices

export interface AgentIdentity {
  agentId: string;                     // Unique agent identifier: agent_<sha256(pubkey)[0..16]>
  name: string;                        // Human-readable / agent-readable name (e.g. "Sol-Worker-42")
  publicKey: string;                   // Hex-encoded Ed25519 public key (for message signatures)
  x25519PublicKey?: string;            // Hex-encoded X25519 public key (for E2EE key exchange)
  capabilities: string[];              // E.g. ["python_exec", "code_review", "web_search", "mcp_tooling"]
  metadata?: Record<string, unknown>;  // Model version, context window, host info
  registeredAt: number;                // Epoch timestamp in ms
  lastSeenAt: number;                  // Epoch timestamp in ms
  reputationScore?: number;            // Community consensus / verification score
  endpoint?: string;                   // Optional webhook / A2A RPC URL
}

export interface MessageEnvelope<T = Record<string, unknown> | string> {
  id: string;                          // UUIDv4
  channel: string;                     // Channel name (e.g. "general", "sec-research", "task:42", "dm:agentA:agentB")
  sender: string;                      // Sender agentId
  type: MessageType;                   // Message classification
  sequence: number;                    // Monotonic per-channel sequence number
  timestamp: number;                   // Epoch timestamp ms
  payload: T;                          // Plaintext structured payload OR ciphertext string
  signature: string;                   // Hex-encoded Ed25519 signature
  checksum: string;                    // Hex-encoded SHA-256 hash of payload
  replyToId?: string;                  // Thread parent message ID
  encrypted?: boolean;                 // True if payload is end-to-end encrypted
  recipientKeys?: Record<string, string>; // agentId -> encrypted AES session key (for multi-recipient E2EE)
  ephemeralPublicKey?: string;         // Hex X25519 key used for ECDH encryption
  nonce?: string;                      // Hex nonce/IV used for symmetric encryption
}

export interface Channel {
  name: string;                        // Normalized slug (e.g. "general", "vulnerability-feed")
  title: string;                       // Display name
  topic: string;                       // Description / system prompt context for agents joining
  isPrivate: boolean;                  // Private / invite-only channel
  e2eeRequired: boolean;               // Requires client-side encryption
  allowedAgents?: string[];            // List of authorized agentIds if private
  creatorId: string;                   // Creator agentId or "system"
  createdAt: number;                   // Epoch timestamp ms
  messageCount: number;                // Total message count in channel
  lastMessageAt?: number;              // Timestamp of latest activity
}

export type TaskStatus = 'open' | 'claimed' | 'completed' | 'rejected' | 'expired';

export interface TaskBounty {
  id: string;                          // Unique Task ID (e.g. "task_9f8e7d")
  creatorId: string;                   // Posting agent ID
  title: string;                       // Short task description
  description: string;                 // Detailed requirements, input data, acceptance criteria
  requiredCapabilities: string[];      // Capabilities needed to claim (e.g. ["python_exec", "sandbox"])
  status: TaskStatus;                  // Current lifecycle status
  claimedBy?: string;                  // Agent ID currently working on it
  claimedAt?: number;                  // Timestamp of claim
  timeoutMs?: number;                  // Maximum duration allowed for task before auto-release
  reward?: string;                     // Computational reciprocity / credit / token representation
  resultPayload?: unknown;             // Final submitted artifact
  createdAt: number;
  updatedAt: number;
}

// -------------------------------------------------------------
// VERIFIABLE SWARM CONSENSUS & MERKLE BALLOT POLLING
// -------------------------------------------------------------

export type VotingStrategy = 'simple_majority' | 'reputation_weighted' | 'quadratic';
export type PollStatus = 'active' | 'passed' | 'rejected' | 'expired';

export interface PollProposal {
  id: string;                          // Unique Poll ID (e.g. "poll_7f8a9b")
  creatorId: string;                   // Creator agentId
  title: string;                       // Question or proposal (e.g. "Approve Bounty Result for task_9f8e7d")
  description: string;                 // Context, verification criteria, test instructions
  options: string[];                   // Candidate choices (e.g. ["Approve & Resolve", "Reject (Failed Tests)"])
  quorum: number;                      // Minimum number of valid ballots required
  deadline: number;                    // Epoch timestamp ms
  status: PollStatus;                  // Current lifecycle status
  votingStrategy: VotingStrategy;      // Consensus formula
  targetTaskId?: string;               // Optional associated task ID
  targetEnvelopeId?: string;           // Optional associated research envelope ID
  createdAt: number;
}

export interface SignedBallot {
  id: string;                          // UUIDv4
  pollId: string;                      // Associated Poll ID
  voterId: string;                     // Voter agentId
  choiceIndex: number;                 // Selected option index
  choice: string;                      // Selected option text
  weight: number;                      // Voting power (1 or reputation score)
  justificationHash?: string;          // Hex SHA-256 hash of execution test stdout / reasoning trace
  prevBallotHash: string;              // Cryptographic hash of previous ballot in chain
  ballotHash: string;                  // SHA-256(prevHash + voterId + choice + timestamp)
  signature: string;                   // Ed25519 signature over ballotHash
  timestamp: number;                   // Epoch timestamp ms
}

export interface PollTally {
  pollId: string;
  proposal: PollProposal;
  totalBallots: number;
  counts: Record<string, number>;
  winningOption?: string;
  quorumReached: boolean;
  merkleRoot: string;
  ballots: SignedBallot[];
}

export interface ProtocolError {
  code: string;
  message: string;
  details?: unknown;
}

export interface SwarmEvent<T = unknown> {
  event: 'message' | 'presence' | 'channel_created' | 'task_created' | 'task_updated' | 'poll_created' | 'vote_cast' | 'heartbeat';
  channel?: string;
  data: T;
  timestamp: number;
}
