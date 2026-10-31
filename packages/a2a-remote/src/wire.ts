// A2A v1.0 JSON-RPC wire types for the subset this reader emits, transcribed
// from specification/a2a.proto at tag v1.0.1 (ProtoJSON: camelCase fields,
// enum values as their proto names). test/contract.test.ts validates emitted
// objects against the pinned upstream schema and the proto's REQUIRED fields.
export const A2A_VERSION = '1.0';

export type TaskState = 'TASK_STATE_SUBMITTED' | 'TASK_STATE_WORKING' | 'TASK_STATE_COMPLETED' | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED' | 'TASK_STATE_INPUT_REQUIRED' | 'TASK_STATE_REJECTED' | 'TASK_STATE_AUTH_REQUIRED';
export type Role = 'ROLE_USER' | 'ROLE_AGENT';
export type Struct = Record<string, unknown>;

/** Exactly one of text, raw, url or data (proto oneof content). */
export interface Part { text?: string; raw?: string; url?: string; data?: unknown; metadata?: Struct; filename?: string; mediaType?: string }
export interface Message {
  messageId: string; contextId?: string; taskId?: string; role: Role; parts: Part[];
  metadata?: Struct; extensions?: string[]; referenceTaskIds?: string[];
}
export interface Artifact { artifactId: string; name?: string; description?: string; parts: Part[]; metadata?: Struct; extensions?: string[] }
export interface TaskStatus { state: TaskState; message?: Message; timestamp?: string }
export interface Task { id: string; contextId?: string; status: TaskStatus; artifacts?: Artifact[]; history?: Message[]; metadata?: Struct }
/** Exactly one of task or message (proto oneof payload). */
export type SendMessageResponse = { task: Task } | { message: Message };
export interface ListTasksResponse { tasks: Task[]; nextPageToken: string; pageSize: number; totalSize: number }

export interface JsonRpcError { code: number; message: string; data?: Struct[] }
export type JsonRpcId = string | number | null;

// JSON-RPC 2.0 standard codes (specification section 9.5).
export const JSON_PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// A2A-specific codes (specification section 5.4). Reasons follow the
// google.rpc.ErrorInfo example in section 9.5.
export const A2A_ERRORS = {
  TaskNotFoundError: { code: -32001, reason: 'TASK_NOT_FOUND' },
  TaskNotCancelableError: { code: -32002, reason: 'TASK_NOT_CANCELABLE' },
  PushNotificationNotSupportedError: { code: -32003, reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED' },
  UnsupportedOperationError: { code: -32004, reason: 'UNSUPPORTED_OPERATION' },
  ContentTypeNotSupportedError: { code: -32005, reason: 'CONTENT_TYPE_NOT_SUPPORTED' },
  InvalidAgentResponseError: { code: -32006, reason: 'INVALID_AGENT_RESPONSE' },
  ExtendedAgentCardNotConfiguredError: { code: -32007, reason: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED' },
  ExtensionSupportRequiredError: { code: -32008, reason: 'EXTENSION_SUPPORT_REQUIRED' },
  VersionNotSupportedError: { code: -32009, reason: 'VERSION_NOT_SUPPORTED' },
} as const;
export type A2AErrorName = keyof typeof A2A_ERRORS;

export function a2aError(name: A2AErrorName, message: string): JsonRpcError {
  const { code, reason } = A2A_ERRORS[name];
  return { code, message, data: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org' }] };
}

export function invalidParams(field: string, description: string): JsonRpcError {
  return { code: INVALID_PARAMS, message: 'Invalid parameters', data: [{
    '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field, description }],
  }] };
}
