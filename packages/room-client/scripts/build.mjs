/** Package the existing client, not a fork or a second protocol implementation. */
import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, '../room-admission/src'), declarations = resolve(root, '../room-admission/dist');
const output = join(root, 'dist');
const allowed = new Set(['client-entry', 'room-client', 'local-state', 'local-files', 'invitation-wire', 'invitation-http',
  'invitation-mailbox', 'session-client', 'http-client', 'http-contract', 'control', 'key-bindings', 'handshake',
  'noise-driver', 'recovery', 'state-read', 'storage-contract', 'storage-types', 'packet-storage-contract', 'packet-wire']);
const result = await build({ entryPoints: [join(source, 'client-entry.ts')], bundle: true, write: false,
  format: 'esm', platform: 'node', target: 'node22.13', metafile: true, sourcemap: false,
  external: ['@openagentforum/protocol', 'noise-handshake', 'noise-handshake/*'] });
const inputs = Object.keys(result.metafile.inputs);
for (const file of inputs) {
  const absolute = resolve(file);
  if (!absolute.startsWith(source + '/') || !allowed.has(basename(absolute, '.ts'))) throw new Error('Unexpected room client runtime input');
}
const code = result.outputFiles[0].text;
if (/room_lab_|RoomAdmissionStore|D1Room|BudgetedRoomStore|private-room-http/.test(code)) throw new Error('Hub implementation entered client bundle');
// Copy only the declaration closure, using the TypeScript parser (including import() types).
const types = new Map();
async function declaration(name) {
  if (types.has(name)) return;
  if (types.size >= 32 || !allowed.has(name)) throw new Error('Unexpected room client declaration input');
  const text = await readFile(join(declarations, name + '.d.ts'), 'utf8'); types.set(name, text);
  const refs = ts.preProcessFile(text, true, true);
  if (refs.referencedFiles.length || refs.typeReferenceDirectives.length || refs.libReferenceDirectives.length) throw new Error('Unexpected declaration directive');
  for (const { fileName } of refs.importedFiles) {
    if (fileName.startsWith('node:') || fileName === '@openagentforum/protocol') continue;
    if (!/^\.\/[a-z-]+\.js$/.test(fileName)) throw new Error('Unexpected declaration import');
    await declaration(fileName.slice(2, -3));
  }
}
await declaration('client-entry');
const metadata = { schemaVersion: 1, runtime: inputs.map(f => basename(f)).sort(), declarations: [...types.keys()].sort(),
  runtimeSha256: createHash('sha256').update(code).digest('hex') };
// Only this package's generated output, never operator-selected state or source.
await rm(output, { recursive: true, force: true }); await mkdir(join(output, 'types'), { recursive: true });
await writeFile(join(output, 'index.js'), code);
for (const [name, text] of types) await writeFile(join(output, 'types', name + '.d.ts'), text);
await writeFile(join(output, 'build-manifest.json'), JSON.stringify(metadata, null, 2) + '\n');
await copyFile(resolve(root, '../../LICENSE'), join(output, 'LICENSE'));
console.log(`Room client candidate built: ${inputs.length} runtime inputs, ${types.size} declarations; no hub stores.`);
