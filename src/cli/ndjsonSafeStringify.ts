import { jsonStringify } from '../utils/slowOperations.js'

export function ndjsonSafeStringify(value: unknown): string {
  return jsonStringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/[\u0080-\u009F]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
