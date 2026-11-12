#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'sealed-store-lease-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_DAEMON_DIR
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_OAUTH_TOKEN
delete process.env.MERCURY_ANTHROPIC_OAUTH_BASE
delete process.env.MERCURY_FAULT_INJECT
delete process.env.CI
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const axios = ((await import(realpathSync(join(SRC, '..', 'node_modules', 'axios', 'index.js')))) as { default: { defaults: { adapter: unknown } } }).default
axios.defaults.adapter = async (config: { url?: string }) => {
  const url = String(config.url ?? '')
  if (url.endsWith('/oauth/token')) {
    return {
      data: { access_token: 'fixture-access-REFRESHED', refresh_token: 'fixture-refresh-REFRESHED', expires_in: 3600, scope: 'user:inference', token_type: 'Bearer' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }
  }
  const error = new Error(`no route to ${url}`) as Error & { code?: string }
  error.code = 'ENETUNREACH'
  throw error
}

const { plainTextStorage } = await import(join(SRC, 'utils/secureStorage/plainTextStorage.ts'))
const { clearAuthScope } = await import(join(SRC, 'utils/envUtils.ts'))
const { lockSync } = await import(join(SRC, 'utils/lockfile.ts'))
const { enableConfigs } = await import(join(SRC, 'utils/config/globalConfig.ts'))
enableConfigs()
const auth = await import(join(SRC, 'utils/auth.ts'))
const sealedRecord = await import(join(SRC, 'utils/secureStorage/sealedRecord.ts'))
const sealedFile = await import(join(SRC, 'utils/secureStorage/sealedFileStorage.ts'))
const starts = await import(join(SRC, 'utils/secureStorage/sealedStoreStart.ts'))

type Answer = { ok: true; bytes: Buffer } | { ok: false; why: string; final: boolean }
type Stored = Record<string, unknown>
type Prepared = { ok: true; commit(): { success: boolean; code?: string }; discard(): void } | { ok: false; code?: string }
type File = { name: string; read(): Stored | null; readAsync(): Promise<Stored | null>; update(data: Stored): { success: boolean; warning?: string; code?: string }; delete(): boolean; prepare?(data: Stored): Prepared }
type Clocks = { wall: number; mono: number }

let total = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  total++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const skip = (label: string, why: string): void => {
  console.log(`  [SKIP] ${label} — ${why}`)
}
const section = (title: string): void => {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

const protector = {
  scheme: 'fake-protector',
  protect: (secret: Buffer): Answer => ({ ok: true, bytes: Buffer.concat([Buffer.from('held:'), secret]) }),
  unprotect: (token: Buffer): Answer => ({ ok: true, bytes: token.subarray(5) }),
  async protectAsync(secret: Buffer): Promise<Answer> {
    return this.protect(secret)
  },
  async unprotectAsync(token: Buffer): Promise<Answer> {
    return this.unprotect(token)
  },
}
const plain = plainTextStorage as File
const custodyNow = (): unknown => sealedRecord.createKeyCustody(protector)
const sealedStore = (): File => sealedFile.createSealedFileStorage(plainTextStorage, custodyNow()) as File
const step = (over: { file?: File; seals?: boolean; clocks?: () => Clocks } = {}): Promise<string> =>
  (starts.startSealedStore({ file: over.file ?? plainTextStorage, custody: custodyNow(), otherBuildAlive: async () => null, ...(over.seals === undefined ? {} : { seals: over.seals }), ...(over.clocks === undefined ? {} : { clocks: over.clocks }) }) as { settled: Promise<string> }).settled
const passing = (wall: number, mono: number): (() => Clocks) => {
  const readings: Clocks[] = [{ wall: 1_700_000_000_000, mono: 50_000 }, { wall: 1_700_000_000_000 + wall, mono: 50_000 + mono }]
  let asked = 0
  return () => readings[Math.min(asked++, readings.length - 1)]!
}

let homes = 0
function freshHome(): { home: string; file: string } {
  const home = join(SCRATCH, `home-${++homes}`)
  mkdirSync(home, { recursive: true })
  clearAuthScope()
  process.env.MERCURY_CONFIG_DIR = home
  return { home, file: join(home, '.credentials.json') }
}
const raw = (file: string): string => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
const onDisk = (file: string): Stored => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Stored
  } catch {
    return {}
  }
}
const temporaries = (home: string): string[] => readdirSync(home).filter(name => name.endsWith('.tmp'))
const sealedOnly = (file: string): boolean => same(Object.keys(onDisk(file)), ['mercurySealed']) && !raw(file).includes('fixture-')
const lockIsFree = (): boolean => {
  try {
    const site = auth.oauthRefreshLockSite() as { dir: string; options: Record<string, unknown> }
    ;(lockSync(site.dir, site.options) as () => void)()
    return true
  } catch {
    return false
  }
}

const TOKENS = { accessToken: 'fixture-access-AAAA', refreshToken: 'fixture-refresh-BBBB', expiresAt: 4102444800000, scopes: ['user:inference'] }
const STORE = { claudeAiOauth: TOKENS, trustedDeviceToken: 'fixture-device-1' }
const PAST = /^left as it is until the next start: the refresh lock had been held for (\d+) ms before the write, past half its lease of 10000 ms$/

section('§1 the lease the refresh has always run on is named beside the lock, and handed to it')
{
  const site = auth.oauthRefreshLockSite() as { dir: string; options: Record<string, unknown> }
  check('the lock site names a lease of ten seconds beside its other option', same(site.options, { realpath: false, stale: 10_000 }), JSON.stringify(site.options))
  const library = readFileSync(realpathSync(join(SRC, '..', 'node_modules', 'proper-lockfile', 'lib', 'lockfile.js')), 'utf8')
  check('ten seconds is the default the lock library runs on: naming it changes nothing', (library.match(/stale: 10000,/g) ?? []).length === 2, String((library.match(/stale: 10000,/g) ?? []).length))
}

section('§2 everything slow is done before the lock is taken; after the last read stand the bound and the rename')
{
  const { home, file } = freshHome()
  plain.update(STORE)
  const order: string[] = []
  const seen: { freeAtTemporary?: boolean; freeAtLastRead?: boolean; temporaryAtLastRead?: Stored; freeAtRename?: boolean } = {}
  const watching: File = {
    ...plain,
    prepare(data: Stored): Prepared {
      order.push('the temporary file is written')
      seen.freeAtTemporary = lockIsFree()
      const prepared = plain.prepare?.(data) ?? { ok: false as const }
      if (!prepared.ok) return prepared
      return {
        ok: true,
        commit() {
          order.push('the rename')
          seen.freeAtRename = lockIsFree()
          return prepared.commit()
        },
        discard: prepared.discard,
      }
    },
    read(): Stored | null {
      order.push('the last read')
      seen.freeAtLastRead = lockIsFree()
      const names = temporaries(home)
      seen.temporaryAtLastRead = names.length === 1 ? onDisk(join(home, names[0]!)) : {}
      return plain.read()
    },
  }
  const outcome = await step({ file: watching })
  check('the ordinary start still seals', outcome === 'sealed' && sealedOnly(file), outcome)
  check('the order: the temporary file, then the last read, then the rename', same(order, ['the temporary file is written', 'the last read', 'the rename']), order.join(' / '))
  check('the temporary file is written before the lock is taken', seen.freeAtTemporary === true, String(seen.freeAtTemporary))
  check('the last read and the rename happen under the lock', seen.freeAtLastRead === false && seen.freeAtRename === false, `${String(seen.freeAtLastRead)} ${String(seen.freeAtRename)}`)
  check('at the last read the temporary file already holds the sealed text, whole', typeof seen.temporaryAtLastRead?.mercurySealed === 'string' && same(Object.keys(seen.temporaryAtLastRead ?? {}), ['mercurySealed']) && seen.temporaryAtLastRead?.mercurySealed === onDisk(file).mercurySealed, Object.keys(seen.temporaryAtLastRead ?? {}).join(','))
  check('no temporary file is left, and the lock is free again', temporaries(home).length === 0 && lockIsFree(), temporaries(home).join(','))
  check('the store reads back', same(sealedStore().read(), STORE), JSON.stringify(sealedStore().read()))
}

section('§3 the bound: past half the lease between asking for the lock and the rename, the step does not write')
{
  const refusedWith = async (label: string, wall: number, mono: number, wanted: number): Promise<void> => {
    const { home, file } = freshHome()
    plain.update(STORE)
    const before = raw(file)
    const outcome = await step({ clocks: passing(wall, mono) })
    check(label, PAST.exec(outcome)?.[1] === String(wanted) && raw(file) === before && temporaries(home).length === 0 && lockIsFree(), `${outcome} ${temporaries(home).join(',')}`)
  }
  await refusedWith('six seconds on the wall clock: nothing is written, the temporary file is removed, the reason is said', 6_000, 6_000, 6_000)
  await refusedWith('six seconds on the monotonic clock alone, the wall clock standing still: nothing is written', 0, 6_000, 6_000)
  await refusedWith('six seconds on the wall clock alone, as after a sleep the monotonic clock did not count: nothing is written', 6_000, 0, 6_000)
  await refusedWith('the wall clock set back an hour while six seconds pass: nothing is written', -3_600_000, 6_000, 6_000)
  await refusedWith('one millisecond past half the lease: nothing is written', 5_001, 5_001, 5_001)
  const { home, file } = freshHome()
  plain.update(STORE)
  const atHalf = await step({ clocks: passing(5_000, 5_000) })
  check('exactly half the lease is still inside: it seals', atHalf === 'sealed' && sealedOnly(file) && temporaries(home).length === 0, atHalf)
  const after = freshHome()
  plain.update(STORE)
  const first = await step({ clocks: passing(6_000, 6_000) })
  const second = await step()
  check('after a start that did not write, the next start seals', PAST.test(first) && second === 'sealed' && sealedOnly(after.file), `${first} / ${second}`)

  const back = freshHome()
  sealedStore().update(STORE)
  const sealedBefore = raw(back.file)
  const late = await step({ seals: false, clocks: passing(6_000, 6_000) })
  check('the way back has the same bound: past it the sealed store is left as it is', PAST.test(late) && raw(back.file) === sealedBefore && temporaries(back.home).length === 0, late)
  const inTime = await step({ seals: false })
  check('and inside it the store is written back in the clear', inTime === 'written back in the clear, as the credential store flag asks' && same(onDisk(back.file), STORE) && temporaries(back.home).length === 0, inTime)
}

section('§3b a lock that passed to another holder while the step was held is not the step\'s to remove')
{
  const { home, file } = freshHome()
  plain.update(STORE)
  const before = raw(file)
  const lockFolder = `${home}.lock`
  let theirs = 0
  const overtaken: File = {
    ...plain,
    read(): Stored | null {
      const value = plain.read()
      rmdirSync(lockFolder)
      mkdirSync(lockFolder)
      const later = new Date(Date.now() + 12_000)
      utimesSync(lockFolder, later, later)
      theirs = statSync(lockFolder).mtimeMs
      return value
    },
  }
  const outcome = await step({ file: overtaken, clocks: passing(12_000, 12_000) })
  check('held twelve seconds, the lease gone to another holder: the step does not write', PAST.exec(outcome)?.[1] === '12000' && raw(file) === before && temporaries(home).length === 0, outcome)
  check('and it leaves the other holder\'s lock standing', theirs !== 0 && existsSync(lockFolder) && statSync(lockFolder).mtimeMs === theirs, String(existsSync(lockFolder)))
  await new Promise(resolve => setTimeout(resolve, 50))
  rmSync(lockFolder, { recursive: true, force: true })
  const next = await step()
  check('when that holder has let go, the next start seals', next === 'sealed' && sealedOnly(file) && lockIsFree(), next)
}

section('§4 a write that cannot be made leaves the file as it was and no temporary file')
{
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    skip('a home the temporary file cannot be written in', 'a mode-0500 folder needs a non-root POSIX process')
  } else {
    const { home, file } = freshHome()
    plain.update(STORE)
    const before = raw(file)
    chmodSync(home, 0o500)
    const outcome = await step()
    chmodSync(home, 0o700)
    check('a home the temporary file cannot be written in: the step says so and nothing changes', outcome === 'left as it is: the temporary file could not be written (EACCES)' && raw(file) === before && temporaries(home).length === 0, outcome)
  }
  const { home, file } = freshHome()
  plain.update(STORE)
  const before = raw(file)
  process.env.MERCURY_FAULT_INJECT = 'rename@.credentials.json:eio'
  const outcome = await step()
  delete process.env.MERCURY_FAULT_INJECT
  check('a rename the system refuses: the step says so, the file is as it was, the temporary file is removed', outcome === 'left as it is: the write was refused (EIO)' && raw(file) === before && temporaries(home).length === 0 && lockIsFree(), `${outcome} ${temporaries(home).join(',')}`)
}

section('§5 two processes: the step is held past the lease after its last read, a real refresh lands, and the step ends without writing')
{
  const { home, file } = freshHome()
  plain.update({ claudeAiOauth: { ...TOKENS, expiresAt: Date.now() - 60_000, subscriptionType: null, rateLimitTier: null } })
  const sealer = join(SCRATCH, 'sealer.ts')
  writeFileSync(
    sealer,
    `
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SRC = ${JSON.stringify(SRC)}
const { plainTextStorage } = await import(SRC + '/utils/secureStorage/plainTextStorage.ts')
const { createKeyCustody } = await import(SRC + '/utils/secureStorage/sealedRecord.ts')
const { startSealedStore } = await import(SRC + '/utils/secureStorage/sealedStoreStart.ts')
const protector = {
  scheme: 'fake-protector',
  protect: (secret: Buffer) => ({ ok: true, bytes: Buffer.concat([Buffer.from('held:'), secret]) }),
  unprotect: (token: Buffer) => ({ ok: true, bytes: token.subarray(5) }),
  async protectAsync(secret: Buffer) { return this.protect(secret) },
  async unprotectAsync(token: Buffer) { return this.unprotect(token) },
}
const file = {
  ...plainTextStorage,
  read() {
    const value = plainTextStorage.read()
    process.stdout.write('LAST_READ_DONE\\n')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 14500)
    return value
  },
}
const outcome = await startSealedStore({ file, custody: createKeyCustody(protector), otherBuildAlive: async () => null }).settled
console.log('OUTCOME ' + outcome)
process.exit(0)
`,
  )
  const child = spawn(process.execPath, [sealer], { env: { ...process.env, MERCURY_CONFIG_DIR: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString('utf8')
  })
  const ended = once(child, 'exit')
  const reached = await new Promise<boolean>(resolve => {
    const poll = setInterval(() => {
      if (out.includes('LAST_READ_DONE') || child.exitCode !== null) {
        clearInterval(poll)
        resolve(out.includes('LAST_READ_DONE'))
      }
    }, 20)
  })
  check('the step in the other process has made its last read and is held there', reached, err.slice(-300))
  check('the refresh lock is the step\'s while its lease stands: another process cannot take it', !lockIsFree())
  await new Promise(resolve => setTimeout(resolve, 11_500))
  auth.clearOAuthTokenCache()
  auth.__resetKnownDeadRefreshTokensForTest()
  const refreshed = (await auth.checkAndRefreshOAuthTokenIfNeeded()) as boolean
  const landed = onDisk(file).claudeAiOauth as { refreshToken?: string } | undefined
  check('eleven and a half seconds on, a real refresh takes the expired lease and saves its new pair', refreshed === true && landed?.refreshToken === 'fixture-refresh-REFRESHED', `${String(refreshed)} ${String(landed?.refreshToken)}`)
  await ended
  const outcome = (out.split('\n').find(line => line.startsWith('OUTCOME ')) ?? '').slice(8)
  const held = Number(PAST.exec(outcome)?.[1] ?? 0)
  check('the step, when it runs again, does not write, and says how long the lock had been held', held >= 14_000 && held < 60_000, `${outcome} ${err.slice(-300)}`)
  const still = onDisk(file).claudeAiOauth as { refreshToken?: string } | undefined
  check('the pair on disk is still the refresh\'s', still?.refreshToken === 'fixture-refresh-REFRESHED' && onDisk(file).mercurySealed === undefined, raw(file).slice(0, 120))
  check('the step left no temporary file', temporaries(home).length === 0, temporaries(home).join(','))
  const next = await step()
  const kept = sealedStore().read()?.claudeAiOauth as { refreshToken?: string } | undefined
  check('the next start seals, and what it seals is the refresh\'s pair', next === 'sealed' && sealedOnly(file) && kept?.refreshToken === 'fixture-refresh-REFRESHED', `${next} ${String(kept?.refreshToken)}`)
}

rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 })
console.log(failures === 0 ? `\nALL ${total} CHECKS PASS` : `\n${failures} OF ${total} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)
