/** Explicit local operator policy, never authority supplied by an invitation. */
import { isIP } from 'node:net';
import { classifyAddress } from '@openagentforum/protocol';
import { StreamFailure } from './framing.js';

export type DirectPolicy = Readonly<
  { role: 'listen'; localIp: string; peerIp: string; port: number }
  | { role: 'dial'; peerIp: string; port: number }
>;

function publicV4(ip: unknown): ip is string {
  // No DNS, mapped IPv6, alternate numeric encodings, private/metadata targets,
  // or IANA special-purpose anycast ranges. This is deliberately IPv4-only.
  // https://www.iana.org/assignments/iana-ipv4-special-registry/
  return typeof ip === 'string' && isIP(ip) === 4 && classifyAddress(ip) === 'public'
    && !/^192\.(?:31\.196|52\.193|88\.99|175\.48)\./.test(ip);
}

export function directPolicy(input: DirectPolicy): DirectPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
      || Object.values(Object.getOwnPropertyDescriptors(input)).some(field => !('value' in field))) throw new StreamFailure('invalid_input');
  const role = input.role;
  const fields = role === 'listen' ? ['localIp', 'peerIp', 'port', 'role'] : ['peerIp', 'port', 'role'];
  if ((role !== 'listen' && role !== 'dial') || Reflect.ownKeys(input).length !== fields.length
      || !fields.every(field => Object.getOwnPropertyDescriptor(input, field)?.get === undefined
        && Object.prototype.hasOwnProperty.call(input, field))
      || Object.keys(input).sort().join(',') !== fields.join(',')
      || !publicV4(input.peerIp) || !Number.isSafeInteger(input.port) || input.port < 1024 || input.port > 65535
      || (role === 'listen' && (!publicV4(input.localIp) || input.localIp === input.peerIp))) {
    throw new StreamFailure('invalid_input');
  }
  return Object.freeze(role === 'listen'
    ? { role, localIp: input.localIp, peerIp: input.peerIp, port: input.port }
    : { role, peerIp: input.peerIp, port: input.port });
}

export function directOfferAddress(policy: DirectPolicy, peerId: string): string {
  const ip = policy.role === 'listen' ? policy.localIp : policy.peerIp;
  return `/ip4/${ip}/tcp/${policy.port}/p2p/${peerId}`;
}

export function directDialAllowed(policy: DirectPolicy, address: string, peerId: string): boolean {
  return policy.role === 'dial' && address === directOfferAddress(policy, peerId);
}

export function directInboundAllowed(policy: DirectPolicy, address: string): boolean {
  if (policy.role !== 'listen') return false;
  const match = /^\/ip4\/([^/]+)\/tcp\/([1-9][0-9]{0,4})$/.exec(address);
  return !!match && match[1] === policy.peerIp && Number(match[2]) <= 65535;
}
