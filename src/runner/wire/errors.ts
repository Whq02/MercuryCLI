export const RPC_PARSE_ERROR = -32700
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INTERNAL_ERROR = -32603
export const RPC_NOT_INITIALIZED = -32002
export const RPC_REFUSED = -32010
export const RPC_CANCELLED = -32800

export const RPC_ERROR_CODES = [
  RPC_PARSE_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
  RPC_NOT_INITIALIZED,
  RPC_REFUSED,
  RPC_CANCELLED,
] as const
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number]

export const REFUSAL_KINDS = [
  'protocol',
  'claim',
  'model',
  'effort',
  'mode',
  'spawn-switch',
  'kit',
  'rewind',
  'pause-gate',
  'quiesce',
  'queue',
  'agent',
  'no-shell',
  'nothing-to-resume',
  'already-initialized',
  'capability',
] as const
export type RefusalKind = (typeof REFUSAL_KINDS)[number]

export const BAD_LINE_LIMIT = 3
export const MAX_LINE_BYTES = 32 * 1024 * 1024

export type RpcErrorShape = { code: number; message: string; data?: unknown }

export class RpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
  toJSON(): RpcErrorShape {
    return { code: this.code, message: this.message, ...(this.data !== undefined ? { data: this.data } : {}) }
  }
}

export function refused(message: string, kind: RefusalKind, extra: Record<string, unknown> = {}): RpcError {
  return new RpcError(RPC_REFUSED, message, { kind, ...extra })
}

export function methodNotFound(method: string): RpcError {
  return new RpcError(RPC_METHOD_NOT_FOUND, `unknown method ${method}`, { method })
}

export function invalidParams(method: string, issues: unknown): RpcError {
  return new RpcError(RPC_INVALID_PARAMS, `invalid params for ${method}`, { method, issues })
}

export function notInitialized(method: string): RpcError {
  return new RpcError(RPC_NOT_INITIALIZED, 'not initialized: initialize must be answered before any other request', { method })
}

export function cancelled(reason?: string): RpcError {
  return new RpcError(RPC_CANCELLED, reason ?? 'request cancelled', reason !== undefined ? { reason } : undefined)
}

export function isRpcError(value: unknown): value is RpcError {
  return value instanceof RpcError
}

export function rpcErrorOf(value: unknown): RpcErrorShape {
  if (isRpcError(value)) return value.toJSON()
  const message = value instanceof Error ? value.message : String(value)
  return { code: RPC_INTERNAL_ERROR, message }
}
