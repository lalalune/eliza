/** Unit tests for the workbench-todos route handler against an in-memory task-backed runtime (deterministic). */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AgentRuntime, Task, UUID } from '@elizaos/core';
import {
  handleWorkbenchTodosRoutes,
  type WorkbenchTodoView,
} from '../../../src/routes/workbench-todos';

// ---------------------------------------------------------------------------
// In-memory task-backed runtime — mirrors the AgentRuntime task surface the
// workbench-todos handler depends on (getTasks / getTask / createTask /
// updateTask / deleteTask), backed by a Map so the CRUD round-trips for real.
// ---------------------------------------------------------------------------

interface TaskStore {
  runtime: AgentRuntime;
  tasks: Map<string, Task>;
  emittedEvents: Array<{
    runId: string;
    stream: string;
    data: Record<string, unknown>;
    agentId?: string;
  }>;
  seed: (task: Partial<Task> & { id: string }) => void;
}

function createTaskRuntime(): TaskStore {
  const tasks = new Map<string, Task>();
  const emittedEvents: TaskStore['emittedEvents'] = [];
  let counter = 0;

  const runtime = {
    agentId: 'agent-test',
    getService(serviceType: string) {
      if (serviceType !== 'agent_event' && serviceType !== 'AGENT_EVENT') {
        return null;
      }
      return {
        emit(event: TaskStore['emittedEvents'][number]) {
          emittedEvents.push(event);
        },
      };
    },
    async getTasks(_params: Record<string, unknown>): Promise<Task[]> {
      return [...tasks.values()];
    },
    async getTask(id: UUID): Promise<Task | null> {
      return tasks.get(id) ?? null;
    },
    async createTask(task: Partial<Task>): Promise<UUID> {
      counter += 1;
      const id = `task-${counter}` as UUID;
      tasks.set(id, { ...(task as Task), id });
      return id;
    },
    async updateTask(id: UUID, patch: Partial<Task>): Promise<void> {
      const existing = tasks.get(id);
      if (!existing) throw new Error(`task ${id} not found`);
      tasks.set(id, { ...existing, ...patch, id });
    },
    async deleteTask(id: UUID): Promise<void> {
      tasks.delete(id);
    },
  } as unknown as AgentRuntime;

  return {
    runtime,
    tasks,
    emittedEvents,
    seed: (task) => tasks.set(task.id, task as Task),
  };
}

// ---------------------------------------------------------------------------
// Minimal node http req/res doubles (the handler runs on the rawPath surface).
// ---------------------------------------------------------------------------

function createRes(): {
  res: import('node:http').ServerResponse;
  result: () => { status: number; body: unknown };
} {
  let status = 200;
  let ended = '';
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk?: string) {
      status = this.statusCode;
      if (typeof chunk === 'string') ended = chunk;
    },
  } as unknown as import('node:http').ServerResponse;
  return {
    res,
    result: () => ({
      status,
      body: ended ? JSON.parse(ended) : undefined,
    }),
  };
}

function createReq(body?: unknown): import('node:http').IncomingMessage {
  return { body } as unknown as import('node:http').IncomingMessage;
}

async function call(
  runtime: AgentRuntime,
  method: string,
  pathname: string,
  body?: unknown,
  principalId?: string
): Promise<{ handled: boolean; status: number; body: unknown }> {
  const { res, result } = createRes();
  const handled = await handleWorkbenchTodosRoutes({
    req: createReq(body),
    res,
    method,
    pathname,
    runtime,
    ...(principalId ? { principalId } : {}),
  });
  return { handled, ...result() };
}

describe('workbench todos CRUD route', () => {
  let store: TaskStore;
  const initialCloudProvisioned = process.env.ELIZA_CLOUD_PROVISIONED;

  beforeEach(() => {
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    store = createTaskRuntime();
  });

  afterEach(() => {
    if (initialCloudProvisioned === undefined) delete process.env.ELIZA_CLOUD_PROVISIONED;
    else process.env.ELIZA_CLOUD_PROVISIONED = initialCloudProvisioned;
  });

  test('POST creates a todo and returns the exact DTO shape', async () => {
    const created = await call(store.runtime, 'POST', '/api/workbench/todos', {
      name: '  Buy milk  ',
      description: 'from the store',
      priority: '2',
      isUrgent: true,
      type: 'errand',
    });

    expect(created.handled).toBe(true);
    expect(created.status).toBe(201);
    const todo = (created.body as { todo: Record<string, unknown> }).todo;
    // name is trimmed by the schema transform
    expect(todo.name).toBe('Buy milk');
    expect(todo.description).toBe('from the store');
    expect(todo.priority).toBe(2);
    expect(todo.isUrgent).toBe(true);
    expect(todo.isCompleted).toBe(false);
    expect(todo.type).toBe('errand');
    // Exactly the 7 DTO fields — no tags/createdAt/updatedAt leak.
    expect(Object.keys(todo).sort()).toEqual([
      'description',
      'id',
      'isCompleted',
      'isUrgent',
      'name',
      'priority',
      'type',
    ]);

    // Tag convention preserved: stored task carries both workbench item tags.
    const stored = store.tasks.get(todo.id as string);
    expect(stored?.tags).toEqual(['workbench-todo', 'todo']);
  });

  test('POST rejects a blank name with 400 "name is required"', async () => {
    const res = await call(store.runtime, 'POST', '/api/workbench/todos', {
      name: '   ',
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('name is required');
  });

  test('POST rejects caller-controlled ownership fields', async () => {
    const response = await call(
      store.runtime,
      'POST',
      '/api/workbench/todos',
      {
        name: 'Spoofed todo',
        entityId: 'owner-b',
        metadata: { ownership: { ownerId: 'owner-b' } },
      },
      'owner-a'
    );

    expect(response.status).toBe(400);
    expect(store.tasks.size).toBe(0);
  });

  test('GET lists only workbench todos, sorted by name', async () => {
    await call(store.runtime, 'POST', '/api/workbench/todos', { name: 'Zebra' });
    await call(store.runtime, 'POST', '/api/workbench/todos', { name: 'Apple' });
    // A plain workbench task must be excluded from the listing.
    store.seed({
      id: 'plain-1',
      name: 'not a todo',
      tags: ['workbench-task'],
    });

    const res = await call(store.runtime, 'GET', '/api/workbench/todos');
    expect(res.status).toBe(200);
    const todos = (res.body as { todos: Array<{ name: string }> }).todos;
    expect(todos.map((t) => t.name)).toEqual(['Apple', 'Zebra']);
  });

  test('principal-scoped CRUD stamps ownership and isolates two users', async () => {
    const ownerA = 'owner-a';
    const ownerB = 'owner-b';
    const createdA = await call(
      store.runtime,
      'POST',
      '/api/workbench/todos',
      { name: 'Owner A todo' },
      ownerA
    );
    const createdB = await call(
      store.runtime,
      'POST',
      '/api/workbench/todos',
      { name: 'Owner B todo' },
      ownerB
    );
    const idA = (createdA.body as { todo: { id: string } }).todo.id;
    const idB = (createdB.body as { todo: { id: string } }).todo.id;

    expect(store.tasks.get(idA)).toMatchObject({
      entityId: ownerA,
      metadata: { ownership: { ownerId: ownerA } },
    });
    expect(store.tasks.get(idB)).toMatchObject({
      entityId: ownerB,
      metadata: { ownership: { ownerId: ownerB } },
    });

    const listA = await call(store.runtime, 'GET', '/api/workbench/todos', undefined, ownerA);
    const listB = await call(store.runtime, 'GET', '/api/workbench/todos', undefined, ownerB);
    expect((listA.body as { todos: WorkbenchTodoView[] }).todos).toEqual([
      expect.objectContaining({ id: idA, name: 'Owner A todo' }),
    ]);
    expect((listB.body as { todos: WorkbenchTodoView[] }).todos).toEqual([
      expect.objectContaining({ id: idB, name: 'Owner B todo' }),
    ]);

    // The local single-user route remains unscoped for existing installations.
    const localList = await call(store.runtime, 'GET', '/api/workbench/todos');
    expect((localList.body as { todos: WorkbenchTodoView[] }).todos).toHaveLength(2);
  });

  test('foreign principals receive the same 404 for every item operation', async () => {
    const created = await call(
      store.runtime,
      'POST',
      '/api/workbench/todos',
      { name: 'Private todo' },
      'owner-a'
    );
    const id = (created.body as { todo: { id: string } }).todo.id;

    const attempts = await Promise.all([
      call(store.runtime, 'GET', `/api/workbench/todos/${id}`, undefined, 'owner-b'),
      call(store.runtime, 'PUT', `/api/workbench/todos/${id}`, { name: 'Stolen' }, 'owner-b'),
      call(
        store.runtime,
        'POST',
        `/api/workbench/todos/${id}/complete`,
        { isCompleted: true },
        'owner-b'
      ),
      call(store.runtime, 'DELETE', `/api/workbench/todos/${id}`, undefined, 'owner-b'),
    ]);

    for (const attempt of attempts) {
      expect(attempt.status).toBe(404);
      expect(attempt.body).toMatchObject({ error: 'Todo not found' });
    }
    expect(store.tasks.get(id)).toMatchObject({
      name: 'Private todo',
      metadata: { isCompleted: false },
    });
  });

  test('scoped reads fail closed for unowned or conflicting ownership markers', async () => {
    store.seed({
      id: 'unowned',
      name: 'Legacy local todo',
      tags: ['workbench-todo'],
    });
    store.seed({
      id: 'conflicting',
      name: 'Corrupt todo',
      tags: ['workbench-todo'],
      entityId: 'owner-a' as UUID,
      metadata: { ownership: { ownerId: 'owner-b' } },
    });

    const scoped = await call(store.runtime, 'GET', '/api/workbench/todos', undefined, 'owner-a');
    expect((scoped.body as { todos: WorkbenchTodoView[] }).todos).toEqual([]);
    const local = await call(store.runtime, 'GET', '/api/workbench/todos');
    expect((local.body as { todos: WorkbenchTodoView[] }).todos).toHaveLength(2);
  });

  test('managed Cloud direct dispatch requires a principal', async () => {
    process.env.ELIZA_CLOUD_PROVISIONED = '1';
    const response = await call(store.runtime, 'GET', '/api/workbench/todos');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      success: false,
      code: 'workflow_principal_required',
    });
  });

  test('GET :id returns the todo, 404 for unknown', async () => {
    const created = await call(store.runtime, 'POST', '/api/workbench/todos', {
      name: 'Read book',
    });
    const id = (created.body as { todo: { id: string } }).todo.id;

    const found = await call(store.runtime, 'GET', `/api/workbench/todos/${id}`);
    expect(found.status).toBe(200);
    expect((found.body as { todo: { name: string } }).todo.name).toBe('Read book');

    const missing = await call(store.runtime, 'GET', '/api/workbench/todos/does-not-exist');
    expect(missing.status).toBe(404);
    expect((missing.body as { error: string }).error).toBe('Todo not found');
  });

  test('PUT updates fields and rejects an empty name', async () => {
    const created = await call(store.runtime, 'POST', '/api/workbench/todos', {
      name: 'Original',
      priority: 1,
    });
    const id = (created.body as { todo: { id: string } }).todo.id;

    const updated = await call(store.runtime, 'PUT', `/api/workbench/todos/${id}`, {
      name: 'Renamed',
      priority: 5,
      isUrgent: true,
    });
    expect(updated.status).toBe(200);
    const todo = (updated.body as { todo: Record<string, unknown> }).todo;
    expect(todo.name).toBe('Renamed');
    expect(todo.priority).toBe(5);
    expect(todo.isUrgent).toBe(true);

    const blank = await call(store.runtime, 'PUT', `/api/workbench/todos/${id}`, { name: '   ' });
    expect(blank.status).toBe(400);
    expect((blank.body as { error: string }).error).toBe('name cannot be empty');
  });

  test('POST :id/complete marks the todo completed', async () => {
    const created = await call(store.runtime, 'POST', '/api/workbench/todos', {
      name: 'Finish report',
    });
    const id = (created.body as { todo: { id: string } }).todo.id;

    const done = await call(store.runtime, 'POST', `/api/workbench/todos/${id}/complete`, {
      isCompleted: true,
    });
    expect(done.status).toBe(200);
    expect((done.body as { ok: boolean }).ok).toBe(true);

    const after = await call(store.runtime, 'GET', `/api/workbench/todos/${id}`);
    expect((after.body as { todo: { isCompleted: boolean } }).todo.isCompleted).toBe(true);

    const missing = await call(store.runtime, 'POST', '/api/workbench/todos/nope/complete', {
      isCompleted: true,
    });
    expect(missing.status).toBe(404);
  });

  test('DELETE removes the todo, 404 for unknown', async () => {
    const created = await call(store.runtime, 'POST', '/api/workbench/todos', {
      name: 'Temporary',
    });
    const id = (created.body as { todo: { id: string } }).todo.id;

    const del = await call(store.runtime, 'DELETE', `/api/workbench/todos/${id}`);
    expect(del.status).toBe(200);
    expect((del.body as { ok: boolean }).ok).toBe(true);
    expect(store.tasks.has(id)).toBe(false);

    const again = await call(store.runtime, 'DELETE', `/api/workbench/todos/${id}`);
    expect(again.status).toBe(404);
  });

  test('mutations emit workbench todo change events for live clients', async () => {
    const created = await call(store.runtime, 'POST', '/api/workbench/todos', {
      name: 'Track live updates',
    });
    const id = (created.body as { todo: { id: string } }).todo.id;

    await call(store.runtime, 'PUT', `/api/workbench/todos/${id}`, {
      name: 'Track live update events',
    });
    await call(store.runtime, 'POST', `/api/workbench/todos/${id}/complete`, {
      isCompleted: true,
    });
    await call(store.runtime, 'DELETE', `/api/workbench/todos/${id}`);

    expect(store.emittedEvents.map((event) => event.stream)).toEqual([
      'workbench',
      'workbench',
      'workbench',
      'workbench',
    ]);
    expect(store.emittedEvents.map((event) => event.data.operation)).toEqual([
      'created',
      'updated',
      'completed',
      'deleted',
    ]);
    expect(store.emittedEvents.map((event) => event.data.type)).toEqual([
      'workbench.todo.changed',
      'workbench.todo.changed',
      'workbench.todo.changed',
      'workbench.todo.changed',
    ]);
    expect(store.emittedEvents.map((event) => event.data.todoId)).toEqual([id, id, id, id]);
    expect(store.emittedEvents[0]?.data.todo).toMatchObject({ id, name: 'Track live updates' });
    expect(store.emittedEvents[3]?.data.todo).toBeUndefined();
  });

  test('returns 503 when the runtime is unavailable', async () => {
    const { res, result } = createRes();
    const handled = await handleWorkbenchTodosRoutes({
      req: createReq(),
      res,
      method: 'GET',
      pathname: '/api/workbench/todos',
      runtime: null,
    });
    expect(handled).toBe(true);
    expect(result().status).toBe(503);
  });

  test('declines paths outside the todos surface', async () => {
    const res = await call(store.runtime, 'GET', '/api/workbench/overview');
    expect(res.handled).toBe(false);
  });
});
