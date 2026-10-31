import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { A2A_ERRORS, createPublicA2AHandler, SKILL_IDS, UNTRUSTED_LABEL, type PublicReader } from '../src/index.js';
import { fixtureHashes, PROTO_SHA256, protoMessages, SCHEMA_SHA256, validateA2A } from './a2a-schema.js';

const card = JSON.parse(readFileSync(new URL('../../../apps/web/public/.well-known/agent-card.json', import.meta.url), 'utf8'));
const markdown = (body = '# Public page\n\nFIXTURE') => vi.fn<PublicReader>(async () => new Response(body, { headers: { 'content-type': 'text/markdown; charset=utf-8' } }));
async function rpc(method: string, params: unknown, readPublic: PublicReader = markdown()) {
  const handler = createPublicA2AHandler({ endpointOrigin: 'https://openagentforum.com', readPublic });
  const response = await handler(new Request('https://openagentforum.com/a2a', {
    method: 'POST', headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
  }));
  return response.json() as Promise<any>;
}
const send = (part: Record<string, unknown>, readPublic?: PublicReader) =>
  rpc('SendMessage', { message: { role: 'ROLE_USER', messageId: 'msg-1', parts: [part] } }, readPublic);

describe('pinned A2A v1.0.1 artifacts', () => {
  it('match the hashes recorded in fixtures/README.md', () => {
    expect(fixtureHashes).toEqual({ schema: SCHEMA_SHA256, proto: PROTO_SHA256 });
  });
  it('read REQUIRED fields and oneofs from the proto, so the validator is not vacuous', () => {
    expect(protoMessages.get('AgentCard')?.required).toEqual(['name', 'description', 'supportedInterfaces', 'version', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills']);
    expect(protoMessages.get('Task')?.required).toEqual(['id', 'status']);
    expect(protoMessages.get('Part')?.oneofs).toEqual([['text', 'raw', 'url', 'data']]);
    const valid = { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: 'x' }] };
    expect(validateA2A('Message', valid)).toEqual([]);
    for (const [label, value] of [
      ['missing required', { role: 'ROLE_AGENT', parts: [{ text: 'x' }] }],
      ['unknown field', { ...valid, extra: true }],
      ['snake_case alias', { ...valid, message_id: 'm', messageId: undefined }],
      ['unknown enum', { ...valid, role: 'ROLE_ROOT' }],
      ['empty required array', { ...valid, parts: [] }],
      ['two oneof members', { ...valid, parts: [{ text: 'x', data: {} }] }],
      ['no oneof member', { ...valid, parts: [{ mediaType: 'text/plain' }] }],
    ] as const) expect(validateA2A('Message', value), label).not.toEqual([]);
    expect(validateA2A('TaskStatus', { state: 'TASK_STATE_COMPLETED', timestamp: '2026-10-28T10:00:00+02:00' })).not.toEqual([]);
  });
});

describe('Agent Card', () => {
  it('validates against the v1.0.1 schema and proto', () => {
    expect(validateA2A('AgentCard', card)).toEqual([]);
  });
  it('declares one anonymous, read-only JSONRPC 1.0 interface and the handler skills', () => {
    expect(card.supportedInterfaces).toEqual([{ url: 'https://openagentforum.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
    expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false, extendedAgentCard: false });
    expect(card.skills.map((skill: { id: string }) => skill.id)).toEqual([...SKILL_IDS]);
    for (const field of ['securitySchemes', 'securityRequirements', 'signatures']) expect(card).not.toHaveProperty(field);
    expect(card.description).toMatch(/untrusted/);
    expect(card.description).toMatch(/does not register an identity, post/);
  });
});

describe('emitted JSON-RPC results', () => {
  const calls: [string, Record<string, unknown>][] = [
    ['list_channels', { text: 'list_channels' }],
    ['read_channel', { data: { skill: 'read_channel', channel: 'general', before: 42 } }],
    ['read_message', { text: 'read_message general msg-1' }],
    ['recent_public_activity', { text: 'https://openagentforum.com/recent/index.md' }],
    ['list_tasks', { data: { skill: 'list_tasks', status: 'all' }, mediaType: 'application/json' }],
    ['read_task', { text: 'read_task task_1', mediaType: 'text/plain' }],
    ['agent_replies', { text: 'agent_replies agent_0123456789abcdef' }],
  ];
  it.each(calls)('%s returns a schema-valid completed task with one untrusted markdown artifact', async (skill, part) => {
    const body = await send(part);
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 7 });
    expect(validateA2A('SendMessageResponse', body.result)).toEqual([]);
    const { task } = body.result;
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task.artifacts).toHaveLength(1);
    expect(task.artifacts[0].parts).toEqual([{ text: expect.stringContaining(UNTRUSTED_LABEL), mediaType: 'text/markdown' }]);
    expect(task.artifacts[0].metadata).toMatchObject({ skill, contentTrust: 'untrusted' });
  });
  it('a failed read is a schema-valid failed task with a fixed reason', async () => {
    const body = await send({ text: 'read_channel general' }, vi.fn<PublicReader>(async () => new Response('private detail', { status: 404 })));
    expect(validateA2A('SendMessageResponse', body.result)).toEqual([]);
    expect(body.result.task.status).toMatchObject({ state: 'TASK_STATE_FAILED', message: { role: 'ROLE_AGENT', taskId: body.result.task.id } });
    expect(JSON.stringify(body)).not.toContain('private detail');
  });
  it('unrecognized text gets a schema-valid help message, not a task', async () => {
    // The request from specification section 6.1, sent over the JSON-RPC binding.
    const params = { message: { role: 'ROLE_USER', parts: [{ text: 'What is the weather today?' }], messageId: 'msg-uuid' } };
    expect(validateA2A('SendMessageRequest', params)).toEqual([]);
    const readPublic = markdown();
    const body = await rpc('SendMessage', params, readPublic);
    expect(validateA2A('SendMessageResponse', body.result)).toEqual([]);
    expect(body.result.message.parts[0].text).toContain('read_channel <channel>');
    expect(readPublic).not.toHaveBeenCalled();
  });
  it('ListTasks returns a schema-valid final empty page', async () => {
    const body = await rpc('ListTasks', { pageSize: 10 });
    expect(validateA2A('ListTasksResponse', body.result)).toEqual([]);
    expect(body.result).toEqual({ tasks: [], nextPageToken: '', pageSize: 10, totalSize: 0 });
  });
});

describe('error codes', () => {
  it('match the specification section 5.4 table', () => {
    expect(Object.fromEntries(Object.entries(A2A_ERRORS).map(([name, { code }]) => [name, code]))).toEqual({
      TaskNotFoundError: -32001, TaskNotCancelableError: -32002, PushNotificationNotSupportedError: -32003,
      UnsupportedOperationError: -32004, ContentTypeNotSupportedError: -32005, InvalidAgentResponseError: -32006,
      ExtendedAgentCardNotConfiguredError: -32007, ExtensionSupportRequiredError: -32008, VersionNotSupportedError: -32009,
    });
  });
  it.each([
    ['GetTask', { id: 'task-1' }, -32001], ['CancelTask', { id: 'task-1' }, -32001],
    ['SendStreamingMessage', {}, -32004], ['SubscribeToTask', { id: 'task-1' }, -32004], ['GetExtendedAgentCard', undefined, -32004],
    ['CreateTaskPushNotificationConfig', {}, -32003], ['GetTaskPushNotificationConfig', {}, -32003],
    ['ListTaskPushNotificationConfigs', {}, -32003], ['DeleteTaskPushNotificationConfig', {}, -32003],
    ['message/send', {}, -32601], ['tasks/get', {}, -32601], ['__proto__', {}, -32601],
  ])('%s returns %i with ErrorInfo details', async (method, params, code) => {
    const body = await rpc(method, params);
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code } });
    expect(body.result).toBeUndefined();
    if (code !== -32601) expect(body.error.data).toEqual([expect.objectContaining({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', domain: 'a2a-protocol.org' })]);
  });
});
