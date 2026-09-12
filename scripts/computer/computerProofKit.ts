import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const ROOT = resolve(import.meta.dir, '..', '..')
export const HOME = proofHome
export const FIXTURES = join(import.meta.dir, 'fixtures')
export const TWO_DISPLAYS_SCENE = join(FIXTURES, 'two-displays.json')

process.env.MERCURY_DAEMON_DIR = join(proofHome, 'daemon')
process.env.BROWSER = '/usr/bin/true'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'fake'
process.env.ANTHROPIC_API_KEY ??= 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_COMPUTER_USE', 'MERCURY_COMPUTER_ACCESS', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_DESKTOP_FAKE_SCENE', 'MERCURY_DESKTOP_FAKE_LOG', 'MERCURY_DESKTOP_PACK_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(ROOT)
mkdirSync(join(proofHome, 'daemon'), { recursive: true })

let failures = 0
let checks = 0

export function check(label: string, cond: boolean, detail = ''): void {
  checks += 1
  if (!cond) failures += 1
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}

export function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}`)
}

export function finish(name: string): never {
  console.log(`\n${name}: ${checks} checks, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

export function freshSignal(): AbortSignal {
  return new AbortController().signal
}

export function abortAfter(ms: number): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller.signal
}

export function abortedSignal(): AbortSignal {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}

export function sourceText(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8')
}

export function scratchDir(name: string): string {
  const dir = join(proofHome, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

export const PNG_SIGNATURE_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

export function isPng(bytes: Buffer): boolean {
  return bytes.length >= 8 && PNG_SIGNATURE_BYTES.every((b, i) => bytes[i] === b)
}
