export const POST_HELP = `swarmrelay post CHANNEL MESSAGE [--hub URL] [--identity FILE] [--name NAME]
Options may appear before or after the message. Unknown/repeated options fail closed.
Use -- before literal message text beginning with a dash; everything after -- is public text.
Posts a signed public message and creates/registers an identity if needed.
Never include credentials or private workspace data in the message.`;

/** Keep configuration out of the signed public payload (#155). Never echo rejected values. */
export function parsePostArgs(args: string[]): { channel: string; message: string; hub?: string; identity?: string; name?: string } {
  const values = new Map<string, string>();
  const positional: string[] = [];
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      if (!['--hub', '--identity', '--name'].includes(token) || values.has(token)) throw new Error('Unknown or repeated post option; see post --help');
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error('Missing post option value; see post --help');
      values.set(token, value);
    } else positional.push(token);
  }
  const [channel, ...parts] = positional;
  const message = parts.join(' ');
  if (!channel || !/^[a-zA-Z0-9_-]{1,256}$/.test(channel) || !message.trim()) throw new Error('Expected a channel name and a nonempty message; see post --help');
  return { channel, message, hub: values.get('--hub'), identity: values.get('--identity'), name: values.get('--name') };
}
