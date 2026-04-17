import { describe, expect, it, vi } from 'vitest';
import {
  createBffDataSourceManager,
  createDefaultWebSocketManager,
  RuntimeBffExecutionSnapshot
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
          roles: 'roles'
        }
      }
    },
    ...overrides
  };
}

describe('createBffDataSourceManager', () => {
  it('maps query datasource to /query and returns rows', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ rows: [{ id: 'o-1' }] }), {
        status: 200,
        headers: {
          'x-request-id': 'server-1'
        }
      })
    );
    const executions: RuntimeBffExecutionSnapshot[] = [];
    const manager = createBffDataSourceManager({
      baseUrl: 'http://localhost:6000',
      fetchImpl: fetchSpy,
      onExecution: (snapshot) => executions.push(snapshot)
    });

    const result = await manager.execute({
      datasource: createDatasource() as never,
      state: {
        tenantId: 'tenant-a',
        userId: 'u-a',
        roles: ['MANAGER'],
        filter_keyword: 'hello'
      }
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
          'x-request-id': 'server-mutation'
        }
      })
    );
    const manager = createBffDataSourceManager({
      fetchImpl: fetchSpy
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
              org_id: 'form_org_id'
            }
          }
        }
      }) as never,
      state: {
        tenantId: 'tenant-a',
        userId: 'u-a',
        roles: ['USER'],
        form_id: 'o-1',
        form_org_id: 'dept-a'
      }
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
        status: 403
      })
    );
    const executions: RuntimeBffExecutionSnapshot[] = [];
    const manager = createBffDataSourceManager({
      fetchImpl: fetchSpy,
      onExecution: (snapshot) => executions.push(snapshot)
    });

    await expect(
      manager.execute({
        datasource: createDatasource() as never,
        state: {}
      })
    ).rejects.toThrowError('permission denied');

    expect(executions[0]?.status).toBe('denied');
    expect(executions[0]?.httpStatus).toBe(403);
  });

  it('classifies network failures as network_error', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError('network down'));
    const executions: RuntimeBffExecutionSnapshot[] = [];
    const manager = createBffDataSourceManager({
      fetchImpl: fetchSpy,
      onExecution: (snapshot) => executions.push(snapshot)
    });

    await expect(
      manager.execute({
        datasource: createDatasource() as never,
        state: {}
      })
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
      onUnsubscribe
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
