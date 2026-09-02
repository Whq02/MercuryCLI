// ============================================================================
//  src/cli/ndjsonSafeStringify.ts — serialize a value to a single-line JSON
//  string no line-splitting receiver can cut.
//
//  JSON leaves U+2028/U+2029 unescaped, and JavaScript's own line-terminator
//  definition treats both as line breaks — a splitter would cut the record
//  mid-string and discard both halves. The post-pass runs over the
//  serialized text, so the code points are covered inside object keys too.
// ============================================================================
import { jsonStringify } from '../utils/slowOperations.js'

export function ndjsonSafeStringify(value: unknown): string {
  return jsonStringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
