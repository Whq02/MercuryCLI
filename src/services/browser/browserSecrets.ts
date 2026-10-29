
import { spawnSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getMercuryHome, withAuthScope } from '../../utils/envUtils.js'
import { getMacOsKeychainStorageServiceName, getUsername, keychainReachable } from '../../utils/secureStorage/macOsKeychainHelpers.js'
import { readKeychainServiceSync } from '../../utils/secureStorage/macOsKeychainStorage.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'

const BROWSER_SECRET_ENV_PREFIX = 'MERCURY_BROWSER_SECRET_'
export const BROWSER_SECRET_REF_GRAMMAR = /^[A-Z][A-Z0-9_]{0,63}$/
const BROWSER_SECRETS_FILENAME = 'browser-secrets.json'

type BrowserSecretResolution =
  | { state: 'ok'; value: string; source: 'env' | 'file' | 'keychain'; origin?: string }
  | { state: 'missing' | 'refused'; note: string }

function totpCode(seed: string): string | null {
  const base32 = seed.replace(/\s/g, '').toUpperCase().replace(/=+$/, '')
  if (!/^[A-Z2-7]+$/.test(base32) || ![0, 2, 4, 5, 7].includes(base32.length % 8)) return null
  const bytes: number[] = []
  let bits = 0
  let buffer = 0
  for (const char of base32) {
    buffer = (buffer << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >>> bits) & 255)
      buffer &= (1 << bits) - 1
    }
  }
  if (bytes.length === 0 || buffer !== 0) return null
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest()
  const offset = digest[digest.length - 1]! & 15
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

function resolvedEntry(entry: unknown, source: 'file' | 'keychain', origin: string | undefined, note: string): BrowserSecretResolution {
  if (typeof entry === 'string' && entry !== '') return { state: 'ok', value: entry, source }
  if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
    const saved = entry as Record<string, unknown>
    if (typeof saved.origin === 'string' && saved.origin === origin && typeof saved.totp === 'string') {
      try {
        const url = new URL(saved.origin)
        if ((url.protocol === 'https:' || url.protocol === 'http:') && url.origin === saved.origin) {
          const value = totpCode(saved.totp)
          if (value !== null) return { state: 'ok', value, source, origin: saved.origin }
        }
      } catch {}
    }
    return { state: 'refused', note }
  }
  return { state: 'missing', note }
}

function migrateBrowserSecret(ref: string, entry: unknown, service: string, file: string, raw: string, parsed: Record<string, unknown>): boolean {
  try {
    const username = getUsername()
    if (/["\\\r\n\0]/.test(username)) return false
    const serialized = JSON.stringify(entry)
    const hex = Buffer.from(serialized, 'utf8').toString('hex')
    const commandLine = `add-generic-password -U -a "${username}" -s "${service}" -X ${hex}\n`
    if (commandLine.length > 4096 - 64) return false
    const written = spawnSync('security', ['-i'], {
      windowsHide: true,
      input: commandLine,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...subprocessEnv() },
    })
    if (written.status !== 0 || readKeychainServiceSync(service) !== serialized) return false
    const target = fs.realpathSync(file)
    if (fs.readFileSync(target, 'utf8') !== raw) return false
    const remaining = { ...parsed }
    delete remaining[ref]
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(remaining, null, 2)}\n`, { mode: 0o600, flag: 'wx', flush: true })
      if (fs.readFileSync(target, 'utf8') !== raw) return false
      fs.renameSync(temporary, target)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
    return true
  } catch {
    return false
  }
}

export function resolveBrowserSecret(ref: string, opts?: { fileDir?: string; origin?: string }): BrowserSecretResolution {
  if (!BROWSER_SECRET_REF_GRAMMAR.test(ref)) {
    return {
      state: 'refused',
      note: `secretRef "${ref}" does not match the name grammar (UPPER_SNAKE, letter-led, up to 64 chars)`,
    }
  }
  const fromEnv = process.env[`${BROWSER_SECRET_ENV_PREFIX}${ref}`]
  if (typeof fromEnv === 'string' && fromEnv !== '') return { state: 'ok', value: fromEnv, source: 'env' }
  const dir = opts?.fileDir ?? getMercuryHome()
  const file = path.join(dir, BROWSER_SECRETS_FILENAME)
  const roads = `set ${BROWSER_SECRET_ENV_PREFIX}${ref}, or add "${ref}" to ${file} (owner-only file mode)`
  const note = `secret ${ref} is not registered — ${roads}`
  const service = withAuthScope(dir, () => getMacOsKeychainStorageServiceName(`-browser-secret-${ref}`))
  let raw: string | undefined
  try {
    if (process.platform !== 'win32') {
      const mode = fs.statSync(file).mode & 0o777
      if ((mode & 0o077) !== 0) {
        return {
          state: 'refused',
          note: `${file} is readable beyond its owner (mode ${mode.toString(8)}) — chmod 600 it; the secret was not read`,
        }
      }
    }
    raw = fs.readFileSync(file, 'utf8')
  } catch {}
  if (raw !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { state: 'refused', note: `${file} is not valid JSON — expected a flat {"NAME": "value"} object` }
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Object.hasOwn(parsed, ref)) {
      const entries = parsed as Record<string, unknown>
      const entry = entries[ref]
      const resolved = resolvedEntry(entry, 'file', opts?.origin, note)
      if (resolved.state !== 'ok' || !keychainReachable()) return resolved
      const moved = migrateBrowserSecret(ref, entry, service, file, raw, entries)
      return resolvedEntry(entry, moved ? 'keychain' : 'file', opts?.origin, note)
    }
  }
  if (keychainReachable()) {
    try {
      const stored = readKeychainServiceSync(service)
      if (stored !== null) return resolvedEntry(JSON.parse(stored), 'keychain', opts?.origin, note)
    } catch {}
  }
  return { state: 'missing', note }
}

export function scrubSecretFromText(text: string, value: string, ref: string): string {
  if (value === '') return text
  return text.split(value).join(`[redacted:${ref}]`)
}
