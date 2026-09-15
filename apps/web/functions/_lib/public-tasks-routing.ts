import { InputError, type BrowseRepresentation } from './public-browse-routing.js';

// Unlike a bare $, this requires the actual end, not the position before a
// trailing newline. The same validators govern input and projected shortcuts.
export const TASK_ID = /^[a-zA-Z0-9_-]{1,128}$(?![\s\S])/;
export const TASK_CAPABILITY = /^[a-zA-Z0-9][a-zA-Z0-9_.:+-]{0,63}$(?![\s\S])/;
export const TASK_STATUSES = ['open', 'claimed', 'completed', 'all'] as const;
export type TaskStatusFilter = typeof TASK_STATUSES[number];
export interface TaskCursor { createdAt: number; id: string }
export type TaskRoute = { kind: 'task'; id: string }
  | { kind: 'tasks'; status: TaskStatusFilter; capability?: string; before?: TaskCursor };
export const taskPath = (id: string) => `/tasks/${encodeURIComponent(id)}/`;
export function taskCursorText(route: Extract<TaskRoute, { kind: 'tasks' }>, cursor: TaskCursor) {
  return btoa(JSON.stringify([1, route.status, route.capability ?? '', cursor.createdAt, cursor.id]))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function taskBrowsePath(route: TaskRoute, representation: BrowseRepresentation = 'html') {
  const base = route.kind === 'task' ? taskPath(route.id) : '/tasks/';
  const query = new URLSearchParams();
  if (route.kind === 'tasks') {
    if (route.status !== 'open') query.set('status', route.status);
    if (route.capability) query.set('capability', route.capability);
    if (route.before) query.set('before', taskCursorText(route, route.before));
  }
  return base + (representation === 'markdown' ? 'index.md' : '') + (query.size ? '?' + query : '');
}
export function parseTaskRoute(url: URL) {
  if (url.pathname.length > 512 || url.search.length > 768 || /%2f|%5c/i.test(url.pathname)) throw new InputError(400);
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { throw new InputError(400); }
  const representation: BrowseRepresentation = /\/index\.md\/?$/.test(path) ? 'markdown' : 'html';
  if (representation === 'markdown') path = path.replace(/index\.md\/?$/, '');
  let route: TaskRoute;
  const parts = path.replace(/\/$/, '').split('/');
  if (['/tasks', '/tasks/', '/tasks/index.html'].includes(path)) route = { kind: 'tasks', status: 'open' };
  else if (parts.length === 3 && parts[1] === 'tasks' && TASK_ID.test(parts[2])) route = { kind: 'task', id: parts[2] };
  else throw new InputError(404);
  const allowed = route.kind === 'tasks' ? ['status', 'capability', 'before'] : [];
  url.searchParams.forEach((_, key) => {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new InputError(400);
  });
  if (route.kind === 'tasks') {
    const status = url.searchParams.get('status');
    if (status !== null) {
      if (!TASK_STATUSES.some(value => value === status)) throw new InputError(400);
      route.status = status as TaskStatusFilter;
    }
    const capability = url.searchParams.get('capability');
    if (capability !== null) {
      if (!TASK_CAPABILITY.test(capability)) throw new InputError(400);
      route.capability = capability;
    }
    const before = url.searchParams.get('before');
    if (before !== null) {
      try {
        if (!/^[A-Za-z0-9_-]{1,384}$/.test(before)) throw new Error();
        const cursor: unknown = JSON.parse(atob(before.replace(/-/g, '+').replace(/_/g, '/')));
        if (!Array.isArray(cursor) || cursor.length !== 5 || cursor[0] !== 1 || cursor[1] !== route.status
          || cursor[2] !== (route.capability ?? '') || !Number.isSafeInteger(cursor[3]) || cursor[3] < 0
          || typeof cursor[4] !== 'string' || !TASK_ID.test(cursor[4])) throw new Error();
        route.before = { createdAt: cursor[3], id: cursor[4] };
        if (taskCursorText(route, route.before) !== before) throw new Error();
      } catch { throw new InputError(400); }
    }
  }
  return { route, representation, path: taskBrowsePath(route, representation), htmlPath: taskBrowsePath(route) };
}
