export const JS_KERNEL_MODULE_WORDS =
  "this JavaScript kernel is an ES module under Node: `require`, `module`, `exports`, `__dirname` and `__filename` are not defined. Import instead: `import { readFileSync } from 'node:fs'` at the top level of a cell persists across cells, and `const fs = await import('node:fs')` works anywhere; `process.cwd()` is the working directory"

export const JS_KERNEL_CRYPTO_WORDS =
  "the global `crypto` in this kernel is the Web Crypto API (`crypto.subtle`, `crypto.randomUUID()`, `crypto.getRandomValues()`); Node's `createHash`, `createHmac`, `randomBytes` and the rest are in the `node:crypto` module: `import { createHash } from 'node:crypto'` or `const { createHash } = await import('node:crypto')`"

const COMMONJS_NAME = /^(?:require|module|exports|__dirname|__filename) is not defined$/
const NODE_CRYPTO_CALL = /^crypto\.[A-Za-z_$][\w$]* is not a function$/

export function jsEnvironmentNotes(language: string, error: { name: string; value: string } | undefined): string[] {
  if (language !== 'js' || error === undefined) return []
  if (error.name === 'ReferenceError' && COMMONJS_NAME.test(error.value)) return [JS_KERNEL_MODULE_WORDS]
  if (error.name === 'TypeError' && NODE_CRYPTO_CALL.test(error.value)) return [JS_KERNEL_CRYPTO_WORDS]
  return []
}
