#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'debugpy-pycache-keys-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'config-home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const RESOLVER = join(ROOT, 'src', 'services', 'dap', 'debugpyResolver.ts')
const { PYCACHE_KEYS_KEPT } = await import('../../src/services/dap/debugpyResolver.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
const SNIPPET = `const { pythonSpawnEnv } = await import(${JSON.stringify(RESOLVER)}); console.log(pythonSpawnEnv().PYTHONPYCACHEPREFIX ?? 'SUPPRESSED')`
function prefixFromFreshProcess(): string {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME, USERPROFILE: HOME, XDG_CACHE_HOME: join(HOME, '.cache'), LOCALAPPDATA: join(HOME, 'AppData', 'Local') }
  const run = spawnSync(process.execPath, ['-e', SNIPPET], { encoding: 'utf8', env, timeout: 60_000 })
  if (run.status !== 0) throw new Error(`the resolver did not answer a cache prefix: ${run.stderr.slice(0, 300)}`)
  return run.stdout.trim()
}
const keysUnder = (parent: string): string[] => readdirSync(parent).sort()
const ageKey = (parent: string, key: string, minutesAgo: number): void => {
  mkdirSync(join(parent, key), { recursive: true })
  const at = new Date(Date.now() - minutesAgo * 60_000)
  utimesSync(join(parent, key), at, at)
}

section('§1 one Mercury, one key: the cache root is this run\'s own key under the cache home')
const prefix = prefixFromFreshProcess()
check('the spawn env carries a bytecode cache prefix under the scratch cache home', prefix !== 'SUPPRESSED' && prefix.startsWith(HOME), prefix)
const parent = dirname(prefix)
const ownKey = prefix.slice(parent.length + 1)
check('a source run keys its cache dev (no manifest beside the module)', ownKey === 'dev', ownKey)
check('the key directory exists after the first resolution', existsSync(prefix))

section('§2 another Mercury\'s key survives this one\'s resolution: a build and a source checkout keep their own caches')
const BUILD_KEY = 'ed04c3ae27f4'
ageKey(parent, BUILD_KEY, 1)
prefixFromFreshProcess()
check('the build key is still there after a dev-keyed resolution', existsSync(join(parent, BUILD_KEY)), keysUnder(parent).join(','))
check('and the dev key too', existsSync(prefix), keysUnder(parent).join(','))

section(`§3 the cache keeps the ${PYCACHE_KEYS_KEPT} most recently used keys and drops the rest, oldest first`)
rmSync(parent, { recursive: true, force: true })
mkdirSync(parent, { recursive: true })
const olderKeys = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd', 'eeeeeeeeeeee', 'ffffffffffff']
olderKeys.forEach((key, index) => ageKey(parent, key, (olderKeys.length - index) * 10))
check('six foreign keys seeded, oldest first', keysUnder(parent).length === olderKeys.length)
prefixFromFreshProcess()
const kept = keysUnder(parent)
const expected = ['dev', ...olderKeys.slice(olderKeys.length - (PYCACHE_KEYS_KEPT - 1))].sort()
check(`${PYCACHE_KEYS_KEPT} keys remain: dev and the ${PYCACHE_KEYS_KEPT - 1} newest foreign keys`, JSON.stringify(kept) === JSON.stringify(expected), `kept ${kept.join(',')} expected ${expected.join(',')}`)
check('the oldest keys are gone', olderKeys.slice(0, olderKeys.length - (PYCACHE_KEYS_KEPT - 1)).every(key => !existsSync(join(parent, key))))

section('§4 a key is marked used on every resolution, so the key in use is never the oldest')
ageKey(parent, 'dev', 120)
prefixFromFreshProcess()
const newest = keysUnder(parent).map(key => ({ key, at: statSync(join(parent, key)).mtimeMs })).sort((a, b) => b.at - a.at)[0]
check('dev is the most recently used key after resolving again', newest?.key === 'dev', JSON.stringify(newest))

section('§5 the law in the source')
const src = readFileSync(RESOLVER, 'utf8')
check('the kept count is one named constant', /export const PYCACHE_KEYS_KEPT = \d+/.test(src) && PYCACHE_KEYS_KEPT >= 2)
check('the prefix root is touched before the sweep (mtime is the use mark)', src.indexOf('utimesSync(root, now, now)') !== -1 && src.indexOf('utimesSync(root, now, now)') < src.indexOf('PYCACHE_KEYS_KEPT - 1'))
check('no resolution removes every other key', !/if \(entry !== buildKey\) rmSync/.test(src))

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL LAWS HOLD — prove-debugpy-pycache-keys' : `\n❌ prove-debugpy-pycache-keys — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
