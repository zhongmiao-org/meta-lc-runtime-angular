import { describe, expect, it, vi } from 'vitest';
import {
  createBffDataSourceManager,
  createDefaultWebSocketManager,
  createSocketIoWebSocketManager,
  parseRuntimePageTopic,
  RuntimeSocketLike,
  RuntimeBffExecutionSnapshot,
} from './runtime-adapter';

function createDatasource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'orders-query-datasource',
    type: 'http',
    request: {
      params: {
        table: 'orders',
        fields: ['id', 'owner'],
        stateKeys: {
          tenantId: 'tenantId',
          userId: 'userId',
          roles: 'roles',
        },
      },
    },
    ...overrides,
  };
}

describe('createBffDataSourceManager', () => {
  it('maps query datasource to /query and returns rows', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ rows: [{ id: 'o-1' }] }), {
        status: 200,
        headers: {
          'x-request-id': 'server-1',
        },
      }),
    );
    const executions: RuntimeBffExecutionSnapshot[] = [];
    const manager = createBffDataSourceManager({
      baseUrl: 'http://localhost:6000',
      fetchImpl: fetchSpy,
      onExecution: (snapshot) => executions.push(snapshot),
    });

    const result = await manager.execute({
      datasource: createDatasource() as never,
      state: {
        tenantId: 'tenant-a',
        userId: 'u-a',
        roles: ['MANAGER'],
        filter_keyword: 'hello',
      },
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [endpoint, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('http://localhost:6000/query');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body.tenantId).toBe('tenant-a');
    expect(body.userId).toBe('u-a');
    expect(body.roles).toEqual(['MANAGER']);
    expect(body.filters.keyword).toBe('hello');
    expect(result).toEqual([{ id: 'o-1' }]);
    expect(executions[0]?.responseRequestId).toBe('server-1');
    expect(executions[0]?.status).toBe('success');
  });

  it('maps mutation datasource to /mutation and forwards orgId', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ rowCount: 1, row: { id: 'o-1' } }), {
        status: 200,
        headers: {
          'x-request-id': 'server-mutation',
        },
      }),
    );
    const manager = createBffDataSourceManager({
      fetchImpl: fetchSpy,
    });

    const result = await manager.execute({
      datasource: createDatasource({
        id: 'orders-create-datasource',
        request: {
          params: {
            table: 'orders',
            operation: 'create',
            fieldStateMap: {
              id: 'form_id',
              org_id: 'form_org_id',
            },
          },
        },
      }) as never,
      state: {
        tenantId: 'tenant-a',
        userId: 'u-a',
        roles: ['USER'],
        form_id: 'o-1',
        form_org_id: 'dept-a',
      },
    });

    const [endpoint, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('http://localhost:6000/mutation');
    const body = JSON.parse(String(init.body));
    expect(body.operation).toBe('create');
    expect(body.orgId).toBe('dept-a');
    expect(result).toEqual({ id: 'o-1' });
  });

  it('classifies 403 errors as denied', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('permission denied', {
        status: 403,
      }),
    );
    const executions: RuntimeBffExecutionSnapshot[] = [];
    const manager = createBffDataSourceManager({
      fetchImpl: fetchSpy,
      onExecution: (snapshot) => executions.push(snapshot),
    });

    await expect(
      manager.execute({
        datasource: createDatasource() as never,
        state: {},
      }),
    ).rejects.toThrowError('permission denied');

    expect(executions[0]?.status).toBe('denied');
    expect(executions[0]?.httpStatus).toBe(403);
  });

  it('classifies network failures as network_error', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError('network down'));
    const executions: RuntimeBffExecutionSnapshot[] = [];
    const manager = createBffDataSourceManager({
      fetchImpl: fetchSpy,
      onExecution: (snapshot) => executions.push(snapshot),
    });

    await expect(
      manager.execute({
        datasource: createDatasource() as never,
        state: {},
      }),
    ).rejects.toThrowError('network down');

    expect(executions[0]?.status).toBe('network_error');
  });
});

describe('createDefaultWebSocketManager', () => {
  it('executes lifecycle hooks', async () => {
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const onSubscribe = vi.fn();
    const onUnsubscribe = vi.fn();
    const manager = createDefaultWebSocketManager({
      onConnect,
      onDisconnect,
      onSubscribe,
      onUnsubscribe,
    });
    const handler = vi.fn();

    await manager.connect();
    await manager.subscribe('orders', handler);
    await manager.unsubscribe('orders', handler);
    await manager.disconnect();

    expect(onConnect).toHaveBeenCalledOnce();
    expect(onSubscribe).toHaveBeenCalledWith('orders');
    expect(onUnsubscribe).toHaveBeenCalledWith('orders');
    expect(onDisconnect).toHaveBeenCalledOnce();
  });
});

describe('createSocketIoWebSocketManager', () => {
  it('parses runtime page topics and rejects invalid topics', () => {
    expect(parseRuntimePageTopic('tenant.tenant-a.page.orders.instance.instance-1')).toEqual({
      tenantId: 'tenant-a',
      pageId: 'orders',
      pageInstanceId: 'instance-1',
    });

    expect(() => parseRuntimePageTopic('orders')).toThrowError(
      'Invalid runtime page topic: orders. Expected tenant.{tenantId}.page.{pageId}.instance.{pageInstanceId}.',
    );
  });

  it('connects and disconnects the socket', async () => {
    const socket = new FakeRuntimeSocket();
    const manager = createSocketIoWebSocketManager({
      baseUrl: 'http://localhost:6001',
      socketFactory: () => socket,
    });

    await manager.connect();
    await manager.disconnect();

    expect(socket.connected).toBe(false);
    expect(socket.connectCalls).toBe(1);
    expect(socket.disconnectCalls).toBe(1);
    expect(socket.listenerCount('runtimeManagerExecuted')).toBe(0);
    expect(socket.listenerCount('connect')).toBe(0);
  });

  it('subscribes to BFF runtime page topics without cursor', async () => {
    const socket = new FakeRuntimeSocket();
    const manager = createSocketIoWebSocketManager({
      baseUrl: 'http://localhost:6001',
      socketFactory: (url, options) => {
        socket.createdWith = { url, options };
        return socket;
      },
    });
    const handler = vi.fn();

    await manager.connect();
    await manager.subscribe('tenant.tenant-a.page.orders.instance.instance-1', handler);

    expect(socket.createdWith).toEqual({
      url: 'http://localhost:6001/runtime',
      options: { autoConnect: false },
    });
    expect(socket.emits).toEqual([
      {
        event: 'subscribePage',
        payload: {
          tenantId: 'tenant-a',
          pageId: 'orders',
          pageInstanceId: 'instance-1',
        },
      },
    ]);
  });

  it('resubscribes active topics after socket reconnect', async () => {
    const socket = new FakeRuntimeSocket();
    const manager = createSocketIoWebSocketManager({
      socketFactory: () => socket,
    });
    const topic = 'tenant.tenant-a.page.orders.instance.instance-1';

    await manager.connect();
    await manager.subscribe(topic, vi.fn());
    socket.receive('connect', undefined);

    expect(socket.emits).toEqual([
      {
        event: 'subscribePage',
        payload: {
          tenantId: 'tenant-a',
          pageId: 'orders',
          pageInstanceId: 'instance-1',
        },
      },
      {
        event: 'subscribePage',
        payload: {
          tenantId: 'tenant-a',
          pageId: 'orders',
          pageInstanceId: 'instance-1',
        },
      },
    ]);
  });

  it('resubscribes a topic once when multiple handlers share it', async () => {
    const socket = new FakeRuntimeSocket();
    const manager = createSocketIoWebSocketManager({
      socketFactory: () => socket,
    });
    const topic = 'tenant.tenant-a.page.orders.instance.instance-1';

    await manager.connect();
    await manager.subscribe(topic, vi.fn());
    await manager.subscribe(topic, vi.fn());
    socket.emits.length = 0;
    socket.receive('connect', undefined);

    expect(socket.emits).toEqual([
      {
        event: 'subscribePage',
        payload: {
          tenantId: 'tenant-a',
          pageId: 'orders',
          pageInstanceId: 'instance-1',
        },
      },
    ]);
  });

  it('subscribes with replay cursor options', async () => {
    const socket = new FakeRuntimeSocket();
    const manager = createSocketIoWebSocketManager({
      baseUrl: 'http://localhost:6001',
      namespace: 'runtime',
      socketFactory: () => socket,
    });

    await subscribeWithOptions(
      manager,
      'tenant.tenant-a.page.orders.instance.instance-1',
      vi.fn(),
      {
        afterReplayId: '42-0',
      },
    );

    expect(socket.emits).toEqual([
      {
        event: 'subscribePage',
        payload: {
          tenantId: 'tenant-a',
          pageId: 'orders',
          pageInstanceId: 'instance-1',
          afterReplayId: '42-0',
        },
      },
    ]);
  });

  it('uses the latest replay cursor when resubscribing after reconnect', async () => {
    const socket = new FakeRuntimeSocket();
    const manager = createSocketIoWebSocketManager({
      socketFactory: () => socket,
    });
    const topic = 'tenant.tenant-a.page.orders.instance.instance-1';
    const handler = vi.fn();

    await subscribeWithOptions(manager, topic, handler, {
      afterReplayId: '42-0',
    });
    socket.receive('runtimeManagerExecuted', {
      type: 'runtime.manager.executed',
      topic,
      page: {
        tenantId: 'tenant-a',
        pageId: 'orders',
        pageInstanceId: 'instance-1',
      },
      replayId: '43-0',
      patchState: {},
      refreshedDatasourceIds: [],
      runActionIds: [],
    });
    socket.emits.length = 0;
    socket.receive('connect', undefined);

    expect(socket.emits).toEqual([
      {
        event: 'subscribePage',
        payload: {
          tenantId: 'tenant-a',
          pageId: 'orders',
          pageInstanceId: 'instance-1',
          afterReplayId: '43-0',
        },
      },
    ]);
  });

  it('falls back to the original replay cursor when no newer event was received', async () => {
    const socket = new FakeRuntimeSocket();
    const manager = createSocketIoWebSocketManager({
      socketFactory: () => socket,
    });

    await subscribeWithOptions(
      manager,
      'tenant.tenant-a.page.orders.instance.instance-1',
      vi.fn(),
      {
        afterReplayId: '42-0',
      },
    );
    socket.emits.length = 0;
    socket.receive('connect', undefined);

    expect(socket.emits).toEqual([
      {
        event: 'subscribePage',
        payload: {
          tenantId: 'tenant-a',
          pageId: 'orders',
          pageInstanceId: 'instance-1',
          afterReplayId: '42-0',
        },
      },
    ]);
  });

  it('dispatches manager events only to matching topic handlers', async () => {
    const socket = new FakeRuntimeSocket();
    const manager = createSocketIoWebSocketManager({
      socketFactory: () => socket,
    });
    const ordersHandler = vi.fn();
    const customersHandler = vi.fn();
    const update = {
      type: 'runtime.manager.executed',
      topic: 'tenant.tenant-a.page.orders.instance.instance-1',
      page: {
        tenantId: 'tenant-a',
        pageId: 'orders',
        pageInstanceId: 'instance-1',
      },
      patchState: {},
      refreshedDatasourceIds: [],
      runActionIds: [],
    };

    await manager.connect();
    await manager.subscribe('tenant.tenant-a.page.orders.instance.instance-1', ordersHandler);
    await manager.subscribe('tenant.tenant-a.page.customers.instance.instance-1', customersHandler);
    socket.receive('runtimeManagerExecuted', update);

    expect(ordersHandler).toHaveBeenCalledWith(update);
    expect(customersHandler).not.toHaveBeenCalled();
  });

  it('stops dispatching after unsubscribe', async () => {
    const socket = new FakeRuntimeSocket();
    const manager = createSocketIoWebSocketManager({
      socketFactory: () => socket,
    });
    const handler = vi.fn();
    const topic = 'tenant.tenant-a.page.orders.instance.instance-1';

    await manager.connect();
    await manager.subscribe(topic, handler);
    await manager.unsubscribe(topic, handler);
    socket.emits.length = 0;
    socket.receive('connect', undefined);
    socket.receive('runtimeManagerExecuted', {
      type: 'runtime.manager.executed',
      topic,
      page: {
        tenantId: 'tenant-a',
        pageId: 'orders',
        pageInstanceId: 'instance-1',
      },
      patchState: {},
      refreshedDatasourceIds: [],
      runActionIds: [],
    });

    expect(handler).not.toHaveBeenCalled();
    expect(socket.emits).toEqual([]);
  });

  it('clears subscriptions and replay cursors on disconnect', async () => {
    const socket = new FakeRuntimeSocket();
    const manager = createSocketIoWebSocketManager({
      socketFactory: () => socket,
    });
    const topic = 'tenant.tenant-a.page.orders.instance.instance-1';

    await subscribeWithOptions(manager, topic, vi.fn(), {
      afterReplayId: '42-0',
    });
    await manager.disconnect();
    socket.emits.length = 0;
    socket.receive('connect', undefined);

    expect(socket.emits).toEqual([]);
    expect(socket.listenerCount('runtimeManagerExecuted')).toBe(0);
    expect(socket.listenerCount('connect')).toBe(0);
  });
});

class FakeRuntimeSocket implements RuntimeSocketLike {
  readonly emits: Array<{ event: string; payload: unknown }> = [];
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  connectCalls = 0;
  disconnectCalls = 0;
  connected = false;
  createdWith?: { url: string; options: unknown };

  connect(): RuntimeSocketLike {
    this.connectCalls += 1;
    this.connected = true;
    return this;
  }

  disconnect(): RuntimeSocketLike {
    this.disconnectCalls += 1;
    this.connected = false;
    return this;
  }

  emit(event: string, payload: unknown): RuntimeSocketLike {
    this.emits.push({ event, payload });
    return this;
  }

  on(event: string, handler: (payload: unknown) => void): RuntimeSocketLike {
    const handlers = this.listeners.get(event) ?? new Set<(payload: unknown) => void>();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return this;
  }

  off(event: string, handler: (payload: unknown) => void): RuntimeSocketLike {
    const handlers = this.listeners.get(event);
    handlers?.delete(handler);
    return this;
  }

  receive(event: string, payload: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(payload);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

async function subscribeWithOptions(
  manager: ReturnType<typeof createSocketIoWebSocketManager>,
  channel: string,
  handler: (event: unknown) => void,
  options: { afterReplayId: string },
): Promise<void> {
  await (
    manager.subscribe as unknown as (
      channel: string,
      handler: (event: unknown) => void,
      options: { afterReplayId: string },
    ) => void | Promise<void>
  )(channel, handler, options);
}
