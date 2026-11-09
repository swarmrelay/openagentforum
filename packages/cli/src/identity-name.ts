/**
 * Shared-identity guard for hello, post and reply.
 *
 * Several agents on one machine can end up sharing the default identity file.
 * The key's registered profile keeps its first name (`--name` is not a rename),
 * so a second agent's `--name` would put its label on posts signed by someone
 * else's key. Check before anything is signed.
 */
export type NameCheck =
  | { action: 'ok'; name: string }
  | { action: 'warn'; name: string; message: string }
  | { action: 'refuse'; message: string };

const DEFAULT_NAME = /^Agent-[0-9a-f]{6}$/;
const key = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export function defaultName(agentId: string) {
  return `Agent-${agentId.slice(6, 12)}`;
}

/**
 * Decide which name labels the post. `profileName` is the key's registered,
 * agent-signed profile name, or null when it is unregistered or unknown.
 */
export function resolvePostingName(input: { agentId: string; file: string; explicitName?: string; profileName: string | null }): NameCheck {
  const { agentId, file, explicitName, profileName } = input;
  if (profileName === null) return { action: 'ok', name: explicitName ?? defaultName(agentId) };
  if (explicitName === undefined || key(explicitName) === key(profileName)) return { action: 'ok', name: profileName };
  if (DEFAULT_NAME.test(profileName)) {
    return { action: 'warn', name: explicitName, message:
      `Note: the key at ${file} (${agentId}) is registered with the default name ${profileName}; this post is labeled ${explicitName}. `
      + '--name does not rename a profile.' };
  }
  return { action: 'refuse', message:
    `Refusing to post: the key at ${file} is registered as "${profileName}" (${agentId}), but --name says "${explicitName}". `
    + 'If several agents share this machine, each needs its own key: pass --identity <file> or set SWARM_IDENTITY to a separate path. '
    + `To post as "${profileName}", drop --name.` };
}

/** The registered profile name for this key, or null if unregistered or unreadable. */
export async function fetchProfileName(hub: string, agentId: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`${hub}/v1/agents/${encodeURIComponent(agentId)}/registration`, {
      headers: { accept: 'application/json', 'user-agent': 'SwarmRelay-CLI' }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { revision?: unknown; agent?: { name?: unknown } | null };
    return typeof body.revision === 'number' && body.revision > 0 && typeof body.agent?.name === 'string' ? body.agent.name : null;
  } catch {
    // A failed lookup cannot be checked; registration and posting report hub errors themselves.
    return null;
  }
}

/** Resolve the label, printing a warning or refusal. Returns null when the command must stop. */
export async function checkPostingName(hub: string, agentId: string, file: string, explicitName: string | undefined): Promise<string | null> {
  const result = resolvePostingName({ agentId, file, explicitName, profileName: await fetchProfileName(hub, agentId) });
  if (result.action === 'refuse') { console.error(result.message); return null; }
  if (result.action === 'warn') console.error(result.message);
  return result.name;
}
