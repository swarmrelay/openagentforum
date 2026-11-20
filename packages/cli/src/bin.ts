#!/usr/bin/env node

// Keep diagnostics reachable even when unrelated command dependencies cannot load.
// Builtins only until the command is selected; type-only imports disappear in JS.
import { writeSync } from 'node:fs';
import type { DoctorReport } from './doctor.js';

const args = process.argv.slice(2);
function writeDoctor(text: string): void {
  const bytes = Buffer.from(text + '\n');
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(1, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error();
      offset += written;
    }
  } catch {
    process.exitCode = 1;
    try { writeSync(2, 'SwarmRelay doctor: could not write diagnostic output.\n'); } catch { /* Exit status still signals failure. */ }
  }
}
function doctorFailure(code: 'startup_error' | 'unexpected_error'): void {
  const check = { id: 'doctor', status: 'error' as const, code,
    message: code === 'startup_error' ? 'Diagnostic could not load its required files or dependencies.'
      : 'Diagnostic failed; no private details were printed.',
    remedy: 'Use Node 22.13+ and a complete CLI installation. Capture stdout, stderr and the exit code. Do not share keys, tokens or private paths.' };
  const report: DoctorReport = { schemaVersion: 1, mode: args.includes('--offline') ? 'offline' : 'online',
    versions: {}, status: 'error', exitCode: 1, checks: [check] };
  process.exitCode = 1;
  writeDoctor(args.includes('--json') ? JSON.stringify(report, null, 2)
    : `SwarmRelay doctor: error (${report.mode}, read-only)\n[error] doctor (${code}): ${check.message}\n${check.remedy}`);
}
async function main(): Promise<void> {
  if (args[0] !== 'doctor') {
    let commands: typeof import('./commands.js');
    try { commands = await import('./commands.js'); }
    catch (error) { commandFailure(error); return; }
    await commands.main(); return;
  }
  let doctor: typeof import('./doctor.js');
  try { doctor = await import('./doctor.js'); }
  catch { doctorFailure('startup_error'); return; }
  try {
    if (args.length === 2 && args[1] === '--help') { writeDoctor(doctor.DOCTOR_HELP); return; }
    const report = await doctor.runDoctor(args.slice(1));
    process.exitCode = report.exitCode;
    writeDoctor(args.includes('--json') ? JSON.stringify(report, null, 2) : doctor.formatDoctorReport(report));
  } catch { doctorFailure('unexpected_error'); }
}
function redact(text: string): string {
  const origins: string[] = [];
  let out = text.replace(/\bhttps?:\/\/[^\s"']+/gi, match => {
    try { origins.push(new URL(match).origin); return `%%URL${origins.length - 1}%%`; }
    catch { return '[redacted-url]'; }
  });
  out = out
    .replace(/(?:[A-Za-z]:[\\/][^\s"']*|\\\\[^\s"']+\\[^\s"']*|(?<![\w.])\/[^\s"']+)/g, '[redacted-path]')
    .replace(/\b[a-fA-F0-9]{32,}\b/gi, '[redacted-hex]')
    .replace(/\b(?:sk|pk|token|secret|key)[-_:][A-Za-z0-9+/=_-]{8,}/gi, '[redacted-secret]')
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, '[redacted-blob]');
  return out
    .replace(/%%URL(\d+)%%/g, (_, index) => origins[Number(index)] || '[redacted-url]')
    .slice(0, 240);
}
function commandFailure(error: unknown): void {
  const detail = error instanceof Error ? redact(error.message) : '';
  const lines = [
    'SwarmRelay: command could not start (startup_error, read-only diagnostics).',
    detail ? `detail: ${detail}` : '',
    'Check the complete CLI installation and Node version. Capture stdout, stderr and the exit code.',
    'Never share keys, tokens or private paths.',
  ].filter(Boolean);
  try { writeSync(2, lines.join('\n') + '\n'); } catch { /* Exit status still signals failure. */ }
  process.exit(1);
}
function runtimeFailure(error: unknown): void {
  const detail = error instanceof Error ? redact(error.message) : '';
  const lines = [
    'SwarmRelay: command failed (read-only diagnostics).',
    detail ? `detail: ${detail}` : '',
    'Capture stdout, stderr and the exit code. Never share keys, tokens or private paths.',
  ].filter(Boolean);
  try { writeSync(2, lines.join('\n') + '\n'); } catch { /* Exit status still signals failure. */ }
  process.exit(1);
}
void main().catch(error => {
  if (args[0] === 'doctor') doctorFailure('unexpected_error');
  else runtimeFailure(error);
});
