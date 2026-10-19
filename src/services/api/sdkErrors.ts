export class APIError extends Error {
  readonly requestID: string | null | undefined
  readonly workspaceID: string | null | undefined
  readonly type: string | null

  constructor(
    readonly status: number | undefined,
    readonly error: unknown,
    message: string | undefined,
    readonly headers: Headers | undefined,
    type?: string | null,
  ) {
    const detail = error && typeof error === 'object' && 'message' in error ? error.message : undefined
    const text = detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail))
      : error ? JSON.stringify(error) : message
    super(status ? (text ? `${status} ${text}` : `${status} status code (no body)`) : text || '(no status code or body)')
    this.requestID = headers?.get('request-id')
    this.workspaceID = headers?.get('anthropic-workspace-id')
    this.type = type ?? null
  }

  static generate(status: number | undefined, body: unknown, message: string | undefined, headers: Headers | undefined): APIError {
    if (!status || !headers) return new APIConnectionError({ message, cause: body instanceof Error ? body : undefined })
    const nested = body && typeof body === 'object' && 'error' in body ? body.error : undefined
    const type = nested && typeof nested === 'object' && 'type' in nested && typeof nested.type === 'string' ? nested.type : null
    const Kind = status === 400 ? BadRequestError : status === 401 ? AuthenticationError
      : status === 403 ? PermissionDeniedError : status === 404 ? NotFoundError
        : status === 409 ? ConflictError : status === 422 ? UnprocessableEntityError
          : status === 429 ? RateLimitError : status >= 500 ? InternalServerError : APIError
    return new Kind(status, body, message, headers, type)
  }
}

export class APIUserAbortError extends APIError {
  constructor({ message }: { message?: string } = {}) {
    super(undefined, undefined, message || 'Request was aborted.', undefined)
  }
}

export class APIConnectionError extends APIError {
  constructor({ message, cause }: { message?: string; cause?: unknown }) {
    super(undefined, undefined, message || 'Connection error.', undefined)
    if (cause) this.cause = cause
  }
}

export class APIConnectionTimeoutError extends APIConnectionError {
  constructor({ message }: { message?: string } = {}) {
    super({ message: message ?? 'Request timed out.' })
  }
}

class BadRequestError extends APIError {}
export class AuthenticationError extends APIError {}
class PermissionDeniedError extends APIError {}
export class NotFoundError extends APIError {}
class ConflictError extends APIError {}
class UnprocessableEntityError extends APIError {}
class RateLimitError extends APIError {}
class InternalServerError extends APIError {}
