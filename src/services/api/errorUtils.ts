import { APIError } from '../../utils/api/sdkErrors.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


type ConnectionErrorDetails = Unbuilt

const MAX_CAUSE_LINKS = 5

export function extractConnectionErrorDetails(error: unknown): ConnectionErrorDetails | null {
  return notBuilt('src/services/api/errorUtils.ts:34')
}

function sanitizeAPIError(apiError: string | undefined | null): string {
  if (apiError === undefined || apiError === null) return ''
  const lower = apiError.toLowerCase()
  if (!lower.includes('<!doctype') && !lower.includes('<html')) return apiError
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(apiError)
  return title?.[1]?.trim() ?? ''
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof APIError && typeof error.status === 'number') return error.status
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

function recoverNestedMessage(error: unknown): string | undefined {
  const outer = (error as { error?: unknown } | null)?.error as
    | { error?: { message?: unknown }; message?: unknown }
    | undefined
  const deep = outer?.error?.message
  if (typeof deep === 'string') {
    const sanitized = sanitizeAPIError(deep)
    if (sanitized !== '') return sanitized
  }
  const shallow = outer?.message
  if (typeof shallow === 'string') {
    const sanitized = sanitizeAPIError(shallow)
    if (sanitized !== '') return sanitized
  }
  return undefined
}

export function decodeApiErrorBlobMessage(blob: string): string | undefined {
  const parse = (raw: string): unknown => {
    try {
      return JSON.parse(raw)
    } catch (error) {
      passedOver(error)
      return undefined
    }
  }
  let parsed = parse(blob)
  if (parsed === undefined) {
    const end = blob.lastIndexOf('}')
    if (end !== -1) parsed = parse(blob.slice(0, end + 1))
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  return recoverNestedMessage({ error: parsed })
}

export function formatAPIError(error: unknown): string {
  return notBuilt('src/services/api/errorUtils.ts:127')
}
