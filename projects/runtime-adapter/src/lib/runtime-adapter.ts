import {
  NgxLowcodeDatasourceDefinition,
  NgxLowcodeDatasourceRequest,
  NgxLowcodeDataSourceManager,
  NgxLowcodeWebSocketEventHandler,
  NgxLowcodeWebSocketManager,
} from '@zhongmiao/ngx-lowcode-core-types';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';

export interface RuntimeBffAdapterOptions {
  baseUrl?: string;
  queryPath?: string;
  mutationPath?: string;
  tenantStateKey?: string;
  userStateKey?: string;
  rolesStateKey?: string;
  selectedRecordStateKey?: string;
  orgIdStateKeys?: string[];
  requestIdHeader?: string;
  fetchImpl?: typeof fetch;
  onExecution?: (snapshot: RuntimeBffExecutionSnapshot) => void;
}

export interface RuntimeBffExecutionSnapshot {
  requestId: string;
  responseRequestId: string;
  endpoint: string;
  status: 'success' | 'denied' | 'network_error' | 'error';
  message: string;
  httpStatus?: number;
}

interface QueryApiRequest {
  table: string;
  fields: string[];
  filters?: Record<string, string | number | boolean>;
  tenantId: string;
  userId: string;
  roles: string[];
  limit?: number;
}

type MutationOperation = 'create' | 'update' | 'delete';

interface MutationApiRequest {
  table: string;
  operation: MutationOperation;
  tenantId: string;
  userId: string;
  roles: string[];
  orgId?: string;
  key?: Record<string, string>;
  data?: Record<string, string>;
}

interface MutationApiResponse {
  rowCount: number;
  row: unknown | null;
}

interface StateKeysConfig {
  tenantId: string;
  userId: string;
  roles: string;
  selectedRecordId: string;
}

class RuntimeAdapterHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'RuntimeAdapterHttpError';
    this.status = status;
  }
}

export function createBffDataSourceManager(
  options: RuntimeBffAdapterOptions = {},
): NgxLowcodeDataSourceManager {
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const requestIdHeader = (options.requestIdHeader ?? 'x-request-id').toLowerCase();

  return {
    execute: async ({
      datasource,
      state,
      payload,
    }: NgxLowcodeDatasourceRequest): Promise<unknown> => {
      if (datasource.type === 'local-payload') {
        return extractPayloadField(payload, String(datasource.request?.params?.['field'] ?? 'id'));
      }

      const mutationOperation = resolveMutationOperation(datasource);
      if (mutationOperation) {
        const mutationPayload = toMutationPayload(datasource, state, mutationOperation, options);
        const endpoint = resolveEndpoint(options, datasource, 'mutation');
        const requestId = crypto.randomUUID();
        const { json, responseRequestId } = await sendJsonRequest(
          fetchImpl,
          endpoint,
          requestId,
          mutationPayload,
        );

        const response = asObject<MutationApiResponse>(json);
        recordExecution(options, {
          endpoint,
          requestId,
          responseRequestId,
          status: 'success',
          message: `${mutationOperation} succeeded`,
        });
        return response.row ?? null;
      }

      const queryPayload = toQueryPayload(datasource, state, options);
      const endpoint = resolveEndpoint(options, datasource, 'query');
      const requestId = crypto.randomUUID();
      const { json, responseRequestId } = await sendJsonRequest(
        fetchImpl,
        endpoint,
        requestId,
        queryPayload,
      );
      const rows = normalizeQueryRows(json);
      recordExecution(options, {
        endpoint,
        requestId,
        responseRequestId,
        status: 'success',
        message: 'query succeeded',
      });
      return rows;
    },
  };

  async function sendJsonRequest(
    sender: typeof fetch,
    endpoint: string,
    requestId: string,
    payload: QueryApiRequest | MutationApiRequest,
  ): Promise<{ json: unknown; responseRequestId: string }> {
    try {
      const response = await sender(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [requestIdHeader]: requestId,
        },
        body: JSON.stringify(payload),
      });

      const responseRequestId = response.headers.get(requestIdHeader) ?? requestId;
      const responseText = await response.text();
      const parsedJson = parseJson(responseText);
      if (!response.ok) {
        const message = responseText.trim() || response.statusText || `HTTP ${response.status}`;
        recordExecution(options, {
          endpoint,
          requestId,
          responseRequestId,
          status: response.status === 403 ? 'denied' : 'error',
          httpStatus: response.status,
          message,
        });
        throw new RuntimeAdapterHttpError(response.status, message);
      }

      return {
        json: parsedJson,
        responseRequestId,
      };
    } catch (error) {
      if (error instanceof RuntimeAdapterHttpError) {
        throw error;
      }

      const message = resolveErrorMessage(error);
      recordExecution(options, {
        endpoint,
        requestId,
        responseRequestId: requestId,
        status: 'network_error',
        message,
      });
      throw error;
    }
  }
}

export interface WebSocketManagerOptions {
  onConnect?: () => void | Promise<void>;
  onDisconnect?: () => void | Promise<void>;
  onSubscribe?: (channel: string) => void | Promise<void>;
  onUnsubscribe?: (channel: string) => void | Promise<void>;
}

export interface RuntimePageTopicRef {
  tenantId: string;
  pageId: string;
  pageInstanceId: string;
}

export interface RuntimeWebSocketSubscribeOptions {
  afterReplayId?: string;
}

export interface RuntimeManagerExecutedEvent {
  type: 'runtime.manager.executed';
  topic: string;
  page: RuntimePageTopicRef;
  requestId?: string;
  replayId?: string;
  patchState: Record<string, unknown>;
  refreshedDatasourceIds: string[];
  runActionIds: string[];
}

export interface RuntimeSocketLike {
  connect(): RuntimeSocketLike;
  disconnect(): RuntimeSocketLike;
  emit(event: string, payload: unknown): RuntimeSocketLike;
  on(event: string, handler: (payload: unknown) => void): RuntimeSocketLike;
  off(event: string, handler: (payload: unknown) => void): RuntimeSocketLike;
}

export interface SocketIoWebSocketManagerOptions {
  baseUrl?: string;
  namespace?: string;
  socketOptions?: Partial<ManagerOptions & SocketOptions>;
  socketFactory?: (
    url: string,
    options: Partial<ManagerOptions & SocketOptions>,
  ) => RuntimeSocketLike;
}

export function createDefaultWebSocketManager(
  options: WebSocketManagerOptions = {},
): NgxLowcodeWebSocketManager {
  const subscriptions = new Map<string, Set<NgxLowcodeWebSocketEventHandler>>();

  return {
    connect: async () => {
      await options.onConnect?.();
    },
    subscribe: async (channel: string, handler: NgxLowcodeWebSocketEventHandler) => {
      const handlers = subscriptions.get(channel) ?? new Set<NgxLowcodeWebSocketEventHandler>();
      handlers.add(handler);
      subscriptions.set(channel, handlers);
      await options.onSubscribe?.(channel);
    },
    unsubscribe: async (channel: string, handler: NgxLowcodeWebSocketEventHandler) => {
      const handlers = subscriptions.get(channel);
      handlers?.delete(handler);
      if (handlers && handlers.size === 0) {
        subscriptions.delete(channel);
      }
      await options.onUnsubscribe?.(channel);
    },
    disconnect: async () => {
      subscriptions.clear();
      await options.onDisconnect?.();
    },
  };
}

export function createSocketIoWebSocketManager(
  options: SocketIoWebSocketManagerOptions = {},
): NgxLowcodeWebSocketManager {
  const subscriptions = new Map<string, Set<NgxLowcodeWebSocketEventHandler>>();
  const originalReplayIdsByTopic = new Map<string, string>();
  const latestReplayIdsByTopic = new Map<string, string>();
  const socketUrl = resolveSocketUrl(options);
  const socketOptions: Partial<ManagerOptions & SocketOptions> = {
    autoConnect: false,
    ...options.socketOptions,
  };
  const socketFactory = options.socketFactory ?? defaultSocketFactory;
  let socket: RuntimeSocketLike | undefined;
  let listenerAttached = false;

  const handleManagerExecuted = (event: unknown): void => {
    if (!isRuntimeManagerExecutedEvent(event)) {
      return;
    }

    if (event.replayId) {
      latestReplayIdsByTopic.set(event.topic, event.replayId);
    }

    const handlers = subscriptions.get(event.topic);
    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      handler(event);
    }
  };

  const handleConnect = (): void => {
    for (const channel of subscriptions.keys()) {
      emitSubscribePage(channel);
    }
  };

  return {
    connect: () => {
      getSocket().connect();
    },
    subscribe: (
      channel: string,
      handler: NgxLowcodeWebSocketEventHandler,
      subscribeOptions?: RuntimeWebSocketSubscribeOptions,
    ) => {
      const page = parseRuntimePageTopic(channel);
      const handlers = subscriptions.get(channel) ?? new Set<NgxLowcodeWebSocketEventHandler>();
      const isFirstTopicHandler = handlers.size === 0;
      handlers.add(handler);
      subscriptions.set(channel, handlers);
      if (subscribeOptions?.afterReplayId) {
        originalReplayIdsByTopic.set(channel, subscribeOptions.afterReplayId);
      }
      if (isFirstTopicHandler) {
        emitSubscribePage(channel, page);
      }
    },
    unsubscribe: (channel: string, handler: NgxLowcodeWebSocketEventHandler) => {
      const handlers = subscriptions.get(channel);
      handlers?.delete(handler);
      if (handlers && handlers.size === 0) {
        subscriptions.delete(channel);
        originalReplayIdsByTopic.delete(channel);
        latestReplayIdsByTopic.delete(channel);
      }
    },
    disconnect: () => {
      subscriptions.clear();
      originalReplayIdsByTopic.clear();
      latestReplayIdsByTopic.clear();
      socket?.off('runtimeManagerExecuted', handleManagerExecuted);
      socket?.off('connect', handleConnect);
      socket?.disconnect();
      socket = undefined;
      listenerAttached = false;
    },
  };

  function getSocket(): RuntimeSocketLike {
    socket ??= socketFactory(socketUrl, socketOptions);
    if (!listenerAttached) {
      socket.on('runtimeManagerExecuted', handleManagerExecuted);
      socket.on('connect', handleConnect);
      listenerAttached = true;
    }
    return socket;
  }

  function emitSubscribePage(channel: string, page = parseRuntimePageTopic(channel)): void {
    const replayId = latestReplayIdsByTopic.get(channel) ?? originalReplayIdsByTopic.get(channel);
    getSocket().emit('subscribePage', {
      ...page,
      ...(replayId ? { afterReplayId: replayId } : {}),
    });
  }
}

export function parseRuntimePageTopic(topic: string): RuntimePageTopicRef {
  const match = /^tenant\.([^.]+)\.page\.([^.]+)\.instance\.([^.]+)$/.exec(topic);
  if (!match) {
    throw new Error(
      `Invalid runtime page topic: ${topic}. Expected tenant.{tenantId}.page.{pageId}.instance.{pageInstanceId}.`,
    );
  }
  return {
    tenantId: match[1] ?? '',
    pageId: match[2] ?? '',
    pageInstanceId: match[3] ?? '',
  };
}

function resolveEndpoint(
  options: RuntimeBffAdapterOptions,
  datasource: NgxLowcodeDatasourceDefinition,
  kind: 'query' | 'mutation',
): string {
  const configured = String(datasource.request?.url ?? '').trim();
  if (configured) {
    if (/^https?:\/\//.test(configured)) {
      return configured;
    }
    const base = resolveBaseUrl(options);
    return `${base}${configured.startsWith('/') ? '' : '/'}${configured}`;
  }

  const base = resolveBaseUrl(options);
  const path =
    kind === 'mutation' ? (options.mutationPath ?? '/mutation') : (options.queryPath ?? '/query');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function resolveBaseUrl(options: RuntimeBffAdapterOptions): string {
  if (options.baseUrl && options.baseUrl.trim()) {
    return options.baseUrl.trim().replace(/\/+$/, '');
  }

  const runtimeValue = (globalThis as { __LC_BFF_URL__?: unknown }).__LC_BFF_URL__;
  if (typeof runtimeValue === 'string' && runtimeValue.trim()) {
    return runtimeValue.trim().replace(/\/+$/, '');
  }
  return 'http://localhost:6000';
}

function resolveSocketUrl(options: SocketIoWebSocketManagerOptions): string {
  const baseUrl = resolveBaseUrl({ baseUrl: options.baseUrl });
  const namespace = options.namespace ?? '/runtime';
  return `${baseUrl}${namespace.startsWith('/') ? '' : '/'}${namespace}`;
}

function defaultSocketFactory(
  url: string,
  options: Partial<ManagerOptions & SocketOptions>,
): RuntimeSocketLike {
  return io(url, options) as Socket;
}

function isRuntimeManagerExecutedEvent(event: unknown): event is RuntimeManagerExecutedEvent {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return false;
  }

  const candidate = event as Partial<RuntimeManagerExecutedEvent>;
  return (
    candidate.type === 'runtime.manager.executed' &&
    typeof candidate.topic === 'string' &&
    typeof candidate.patchState === 'object' &&
    candidate.patchState !== null &&
    !Array.isArray(candidate.patchState) &&
    Array.isArray(candidate.refreshedDatasourceIds) &&
    Array.isArray(candidate.runActionIds)
  );
}

function resolveMutationOperation(
  datasource: NgxLowcodeDatasourceDefinition,
): MutationOperation | null {
  const configured = datasource.request?.params?.['operation'];
  if (configured === 'create' || configured === 'update' || configured === 'delete') {
    return configured;
  }
  if (datasource.id.endsWith('-create-datasource')) {
    return 'create';
  }
  if (datasource.id.endsWith('-update-datasource')) {
    return 'update';
  }
  if (datasource.id.endsWith('-delete-datasource')) {
    return 'delete';
  }
  return null;
}

function toQueryPayload(
  datasource: NgxLowcodeDatasourceDefinition,
  state: Record<string, unknown>,
  options: RuntimeBffAdapterOptions,
): QueryApiRequest {
  const stateKeys = resolveStateKeysConfig(datasource, options);
  const tenantId = String(state[stateKeys.tenantId] ?? 'tenant-a');
  const userId = String(state[stateKeys.userId] ?? `${tenantId}-user`);
  const roles = normalizeRoles(state[stateKeys.roles]);
  return {
    table: resolveTable(datasource),
    fields: resolveFields(datasource),
    filters: resolveFilters(datasource, state),
    tenantId,
    userId,
    roles,
    limit: 100,
  };
}

function toMutationPayload(
  datasource: NgxLowcodeDatasourceDefinition,
  state: Record<string, unknown>,
  operation: MutationOperation,
  options: RuntimeBffAdapterOptions,
): MutationApiRequest {
  const stateKeys = resolveStateKeysConfig(datasource, options);
  const tenantId = String(state[stateKeys.tenantId] ?? 'tenant-a');
  const userId = String(state[stateKeys.userId] ?? `${tenantId}-user`);
  const roles = normalizeRoles(state[stateKeys.roles]);
  const table = resolveTable(datasource);
  const keyField = String(datasource.request?.params?.['keyField'] ?? 'id');
  const fieldStateMap = resolveFieldStateMap(datasource);
  const keyValue = String(
    state[fieldStateMap[keyField] ?? `form_${keyField}`] ?? state[stateKeys.selectedRecordId] ?? '',
  ).trim();
  const orgId = resolveOrgId(datasource, state, tenantId, options);

  const data =
    operation === 'delete'
      ? undefined
      : Object.entries(fieldStateMap).reduce<Record<string, string>>(
          (acc, [fieldName, stateKey]) => {
            acc[fieldName] = String(state[stateKey] ?? '').trim();
            return acc;
          },
          {},
        );

  return {
    table,
    operation,
    tenantId,
    userId,
    roles,
    orgId,
    key: {
      [keyField]: keyValue,
    },
    data,
  };
}

function resolveStateKeysConfig(
  datasource: NgxLowcodeDatasourceDefinition,
  options: RuntimeBffAdapterOptions,
): StateKeysConfig {
  const raw = datasource.request?.params?.['stateKeys'];
  const normalized =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const fromState = (key: string): string =>
    (typeof normalized[key] === 'string' && String(normalized[key]).trim()) || '';

  return {
    tenantId: fromState('tenantId') || options.tenantStateKey?.trim() || 'tenantId',
    userId: fromState('userId') || options.userStateKey?.trim() || 'userId',
    roles: fromState('roles') || options.rolesStateKey?.trim() || 'roles',
    selectedRecordId:
      fromState('selectedRecordId') || options.selectedRecordStateKey?.trim() || 'selectedRecordId',
  };
}

function resolveOrgId(
  datasource: NgxLowcodeDatasourceDefinition,
  state: Record<string, unknown>,
  tenantId: string,
  options: RuntimeBffAdapterOptions,
): string {
  const raw = datasource.request?.params?.['orgIdStateKeys'];
  const fromDatasource =
    Array.isArray(raw) && raw.every((item) => typeof item === 'string' && item.trim())
      ? raw.map((item) => item.trim())
      : [];
  const stateKeys =
    fromDatasource.length > 0
      ? fromDatasource
      : (options.orgIdStateKeys ?? defaultOrgIdStateKeys());

  for (const stateKey of stateKeys) {
    const candidate = state[stateKey];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return tenantId === 'tenant-b' ? 'dept-c' : 'dept-a';
}

function defaultOrgIdStateKeys(): string[] {
  return ['orgId', 'form_org_id', 'org_id', 'selectedOrgId'];
}

function resolveFieldStateMap(datasource: NgxLowcodeDatasourceDefinition): Record<string, string> {
  const raw = datasource.request?.params?.['fieldStateMap'];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.entries(raw as Record<string, unknown>).reduce<Record<string, string>>(
      (acc, [field, stateKey]) => {
        acc[field] = String(stateKey);
        return acc;
      },
      {},
    );
  }
  return resolveFields(datasource).reduce<Record<string, string>>((acc, field) => {
    acc[field] = `form_${field}`;
    return acc;
  }, {});
}

function resolveTable(datasource: NgxLowcodeDatasourceDefinition): string {
  const tableFromParams =
    typeof datasource.request?.params?.['table'] === 'string'
      ? datasource.request.params['table']
      : '';
  if (tableFromParams.trim()) {
    return tableFromParams.trim();
  }
  const target = datasource.command?.target ?? '';
  if (target.includes('.')) {
    return target.split('.')[0];
  }
  return 'orders';
}

function resolveFields(datasource: NgxLowcodeDatasourceDefinition): string[] {
  const fields = datasource.request?.params?.['fields'];
  if (Array.isArray(fields) && fields.every((item) => typeof item === 'string')) {
    return fields;
  }
  return ['id'];
}

function resolveFilters(
  datasource: NgxLowcodeDatasourceDefinition,
  state: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const filters: Record<string, string | number | boolean> = {};
  const prefix = resolveFilterStatePrefix(datasource);
  const explicitFilterStateKeys = resolveFilterStateKeys(datasource);

  explicitFilterStateKeys.forEach((stateKey, filterKey) => {
    appendFilter(filters, filterKey, state[stateKey]);
  });

  Object.entries(state).forEach(([key, value]) => {
    if (key.startsWith(prefix)) {
      appendFilter(filters, key.slice(prefix.length), value);
    }
  });

  ['keyword', 'owner', 'channel', 'priority', 'status', 'org_id'].forEach((legacyKey) => {
    appendFilter(filters, legacyKey, state[legacyKey]);
  });

  return filters;
}

function resolveFilterStatePrefix(datasource: NgxLowcodeDatasourceDefinition): string {
  const raw = datasource.request?.params?.['filterStatePrefix'];
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  return 'filter_';
}

function resolveFilterStateKeys(datasource: NgxLowcodeDatasourceDefinition): Map<string, string> {
  const raw = datasource.request?.params?.['filterStateKeys'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return new Map();
  }
  return new Map(
    Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string' && value.trim())
      .map(([filterKey, stateKey]) => [filterKey, String(stateKey).trim()]),
  );
}

function appendFilter(
  target: Record<string, string | number | boolean>,
  key: string,
  value: unknown,
): void {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized || normalized === 'all') {
      return;
    }
    target[key] = normalized;
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    target[key] = value;
  }
}

function normalizeRoles(input: unknown): string[] {
  if (Array.isArray(input) && input.every((item) => typeof item === 'string') && input.length > 0) {
    return input;
  }
  return ['USER'];
}

function normalizeQueryRows(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return input;
  }
  if (input && typeof input === 'object' && Array.isArray((input as { rows?: unknown[] }).rows)) {
    return (input as { rows: unknown[] }).rows;
  }
  return [];
}

function extractPayloadField(payload: unknown, key: string): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const row = (payload as Record<string, unknown>)['row'];
  if (!row || typeof row !== 'object') {
    return '';
  }
  return String((row as Record<string, unknown>)[key] ?? '');
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? 'unknown error');
}

function parseJson(text: string): unknown {
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function asObject<T>(value: unknown): T {
  return (value ?? {}) as T;
}

function recordExecution(
  options: RuntimeBffAdapterOptions,
  snapshot: Omit<RuntimeBffExecutionSnapshot, never>,
): void {
  options.onExecution?.(snapshot);
}
