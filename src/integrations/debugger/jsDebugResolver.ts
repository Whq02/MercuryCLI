import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'

const __dapFilename = fileURLToPath(import.meta.url)
const __dapDirname = path.join(__dapFilename, '../')

export interface JsDebugResolution {
  path: string
  source: 'env-override' | 'vendored' | 'user-dir'
}

export function resolveJsDebugServer(): JsDebugResolution | null {
  const pinned = flagEnv('MERCURY_JS_DEBUG_DAP')
  if (pinned && pinned.length > 0) {
    return existsSync(pinned) ? { path: pinned, source: 'env-override' } : null
  }
  const vendored = path.resolve(__dapDirname, 'vendor', 'js-debug', 'src', 'dapDebugServer.js')
  if (existsSync(vendored)) return { path: vendored, source: 'vendored' }
  const unpacked = join(homedir(), '.js-debug', 'src', 'dapDebugServer.js')
  return existsSync(unpacked) ? { path: unpacked, source: 'user-dir' } : null
}

export function jsDebugSourceLabel(source: JsDebugResolution['source']): string {
  return source === 'vendored'
    ? 'the vendored bundle'
    : source === 'env-override'
      ? 'MERCURY_JS_DEBUG_DAP'
      : 'the ~/.js-debug unpack'
}
