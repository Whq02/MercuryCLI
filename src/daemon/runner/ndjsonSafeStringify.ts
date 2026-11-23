import { jsonStringify } from '../../platform/logs/slowOperations.js'

export function ndjsonSafeStringify(value: unknown): string {
  return jsonStringify(value).replace(
    /[\u0080-\u009f\u2028\u2029]/g,
    ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}
