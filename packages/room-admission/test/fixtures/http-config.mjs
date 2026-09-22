// Dedicated disposable native-runtime fixture, never production policy defaults.
const scope = () => ({ packets: 1000, bytes: 10000000, sessions: 100, packetsPerWindow: 1000, bytesPerWindow: 10000000, sessionsPerWindow: 100 });
const lane = () => ({ requests: 100, inputBytes: 1000000, verifications: 1000, responseBytes: 100000000 });
export const httpConfig = { hub: 'https://relay.example.com', bodyTimeoutMs: 100, operationTimeoutMs: 5000,
  policy: { maxRetainedRooms: 100, maxActiveRooms: 50, maxActiveRoomsPerAgent: 20, maxPendingInvitesPerRecipient: 10,
    maxReceipts: 1000, windowMs: 86400000, createsPerAgent: 20, createsPerHub: 50, invitesPerAgent: 20, invitesPerHub: 50, maxInFlightPerConnection: 8 },
  packets: { hub: scope(), room: scope(), agent: scope(), windowMs: 86400000 },
  requests: { windowMs: 86400000, ordinary: lane(), read: lane(), close: lane(), recovery: lane() },
};
