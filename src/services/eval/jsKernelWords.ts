export const JS_KERNEL_MODULE_WORDS =
  "this kernel is an ES module: `require`, `module`, `exports`, `__dirname` and `__filename` are not defined; use `import { readFileSync } from 'node:fs'` at a cell's top level (it persists across cells) or `const fs = await import('node:fs')` anywhere; `process.cwd()` is the working directory"

export const JS_KERNEL_CRYPTO_WORDS =
  "the global `crypto` is the Web Crypto API (`subtle`, `randomUUID()`, `getRandomValues()`); Node's `createHash`, `createHmac` and `randomBytes` come from `import { createHash } from 'node:crypto'` or `await import('node:crypto')`"

const COMMONJS_NAME = /^(?:require|module|exports|__dirname|__filename) is not defined$/
const NODE_CRYPTO_CALL = /^crypto\.[A-Za-z_$][\w$]* is not a function$/

export function jsEnvironmentNotes(language: string, error: { name: string; value: string } | undefined): string[] {
  if (language !== 'js' || error === undefined) return []
  if (error.name === 'ReferenceError' && COMMONJS_NAME.test(error.value)) return [JS_KERNEL_MODULE_WORDS]
  if (error.name === 'TypeError' && NODE_CRYPTO_CALL.test(error.value)) return [JS_KERNEL_CRYPTO_WORDS]
  return []
}
