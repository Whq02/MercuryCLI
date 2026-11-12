#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'sealed-store-start-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_DAEMON_DIR
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_OAUTH_TOKEN
delete process.env.MERCURY_ANTHROPIC_OAUTH_BASE
delete process.env.CI
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

type TokenLeg = { reached: () => void; answered: Promise<void> }
let tokenLeg: TokenLeg | null = null
const axios = ((await import(realpathSync(join(SRC, '..', 'node_modules', 'axios', 'index.js')))) as { default: { defaults: { adapter: unknown } } }).default
axios.defaults.adapter = async (config: { url?: string }) => {
  const url = String(config.url ?? '')
  if (url.endsWith('/oauth/token')) {
    tokenLeg?.reached()
    await tokenLeg?.answered
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
const { setAuthScope, clearAuthScope } = await import(join(SRC, 'utils/envUtils.ts'))
const { enableConfigs } = await import(join(SRC, 'utils/config/globalConfig.ts'))
enableConfigs()
const auth = await import(join(SRC, 'utils/auth.ts'))
const sealedRecord = await import(join(SRC, 'utils/secureStorage/sealedRecord.ts'))
const sealedFile = await import(join(SRC, 'utils/secureStorage/sealedFileStorage.ts'))
const prefetch = await import(join(SRC, 'utils/secureStorage/keychainPrefetch.ts'))
const starts = await import(join(SRC, 'utils/secureStorage/sealedStoreStart.ts')).catch(() => null)
const others = await import(join(SRC, 'utils/secureStorage/otherBuilds.ts')).catch(() => null)

type Answer = { ok: true; bytes: Buffer } | { ok: false; why: string; final: boolean }
type Store = {
  read(): Record<string, unknown> | null
  update(data: Record<string, unknown>): { success: boolean; warning?: string; code?: string }
}
type Fake = {
  scheme: string
  asked: { protect: number; unprotect: number; offTheLoop: number }
  answers: boolean
  protect(secret: Buffer): Answer
  unprotect(token: Buffer): Answer
  protectAsync(secret: Buffer): Promise<Answer>
  unprotectAsync(token: Buffer): Promise<Answer>
}
type Row = { pid: number; ppid: number; exe: string; args: string[]; startedAtMs: number; user: string; terminal: string | null }
type Table = { observations: Array<{ process: Row; startToken: string | null; state: string; terminalAlive: boolean | null }>; complete: boolean; error?: string }

let total = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  total++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

function fakeProtector(account: string): Fake {
  const pad = createHash('sha256').update(`pad:${account}`).digest()
  const mark = Buffer.from(`sealed-for:${account}:`)
  const turn = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte, at) => byte ^ pad[at % pad.length]!))
  const fake: Fake = {
    scheme: 'fake-protector',
    asked: { protect: 0, unprotect: 0, offTheLoop: 0 },
    answers: true,
    protect(secret) {
      fake.asked.protect++
      if (!fake.answers) return { ok: false, why: 'the protector did not answer', final: false }
      return { ok: true, bytes: Buffer.concat([mark, turn(secret)]) }
    },
    unprotect(token) {
      fake.asked.unprotect++
      if (!fake.answers) return { ok: false, why: 'the protector did not answer', final: false }
      if (!token.subarray(0, mark.length).equals(mark)) return { ok: false, why: 'Key not valid for use in specified state', final: true }
      return { ok: true, bytes: turn(token.subarray(mark.length)) }
    },
    async protectAsync(secret) {
      fake.asked.offTheLoop++
      await new Promise(resolve => setTimeout(resolve, 5))
      return fake.protect(secret)
    },
    async unprotectAsync(token) {
      fake.asked.offTheLoop++
      await new Promise(resolve => setTimeout(resolve, 5))
      return fake.unprotect(token)
    },
  }
  return fake
}

const plain = plainTextStorage as Store
type Started = { store: Store; protector: Fake; warmed: Promise<void>; settled: Promise<string> }
function start1011(account: string, reader: () => Promise<string | null>): Started {
  const protector = fakeProtector(account)
  const custody = sealedRecord.createKeyCustody(protector)
  const store = sealedFile.createSealedFileStorage(plainTextStorage, custody) as Store
  if (starts === null) return { store, protector, warmed: Promise.resolve(), settled: Promise.resolve('no start-up step on this tree') }
  const begun = starts.startSealedStore({ file: plainTextStorage, custody, otherBuildAlive: reader }) as { warmed: Promise<void>; settled: Promise<string> }
  return { store, protector, ...begun }
}
const nobody = async (): Promise<string | null> => null

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
const onDisk = (file: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
const sealedOnly = (file: string): boolean => same(Object.keys(onDisk(file)), ['mercurySealed']) && !raw(file).includes('fixture-')

const TOKENS = { accessToken: 'fixture-access-AAAA', refreshToken: 'fixture-refresh-BBBB', expiresAt: 4102444800000, scopes: ['user:inference'] }
const NEWER = { ...TOKENS, accessToken: 'fixture-access-CCCC', refreshToken: 'fixture-refresh-DDDD' }
const FULL = {
  claudeAiOauth: TOKENS,
  mcpOAuth: { 'x|1': { accessToken: 'fixture-mcp-x-old' }, 'y|2': { accessToken: 'fixture-mcp-y' } },
  trustedDeviceToken: 'fixture-device-1',
}

section('§1 a plain file found at start is sealed there, off the read path')
{
  const { file } = freshHome()
  plain.update(FULL)
  const started = start1011('alice', nobody)
  await started.warmed
  const outcome = await started.settled
  check('the start-up step says it sealed', outcome === 'sealed', outcome)
  check('the file holds the one sealed key and no credential in the clear', sealedOnly(file), raw(file).slice(0, 100))
  check('the store reads back whole', same(started.store.read(), FULL), JSON.stringify(started.store.read()))
  check('the key was wrapped once and came back once, both off the event loop, and the read after asked nothing', started.protector.asked.protect === 1 && started.protector.asked.unprotect === 1 && started.protector.asked.offTheLoop === 2, JSON.stringify(started.protector.asked))
  const again = start1011('alice', nobody)
  await again.warmed
  const asked = again.protector.asked.unprotect
  const first = again.store.read()
  check('a later process has its key by the time the read-ahead is done, unwrapped off the event loop: its first read asks nothing', asked === 1 && again.protector.asked.unprotect === 1 && again.protector.asked.offTheLoop === 1 && same(first, FULL), JSON.stringify(again.protector.asked))
  check('and it finds nothing left to seal', (await again.settled) === 'sealed already', await again.settled)
  const { file: none } = freshHome()
  const empty = start1011('alice', nobody)
  check('a home with no store is left without one', (await empty.settled) === 'no store to seal' && !existsSync(none), await empty.settled)
}

section('§2 never while a Mercury process of another build is alive: the tree\'s own census is asked')
{
  const VERSIONS = join(SCRATCH, 'versions')
  const OWN = join(VERSIONS, '1.0.11', 'mercury.mjs')
  const OLD = join(VERSIONS, '1.0.10', 'mercury.mjs')
  for (const bundle of [OWN, OLD]) {
    mkdirSync(join(bundle, '..'), { recursive: true })
    writeFileSync(bundle, '')
  }
  const anHourAgo = new Date(Date.now() - 3_600_000)
  utimesSync(OWN, anHourAgo, anHourAgo)
  const placed = statSync(OWN)
  const WRITTEN = Math.max(placed.mtimeMs, placed.ctimeMs)
  const row = (pid: number, args: string[], over: Partial<Row> = {}): Table['observations'][number] => ({
    process: { pid, ppid: 1, exe: process.execPath, args, startedAtMs: WRITTEN + 60_000, user: 'operator', terminal: null, ...over },
    startToken: null,
    state: 'S',
    terminalAlive: null,
  })
  const self = row(process.pid, [process.execPath, OWN])
  const ask = async (home: string, rows: Table['observations'], table: Partial<Table> = {}, bundle: string = OWN): Promise<string | null> => {
    if (others === null) return 'no reader on this tree'
    return (await others.otherBuildAlive({
      home,
      ownDaemonDir: join(home, 'daemon'),
      bundle,
      collect: async (): Promise<Table> => ({ observations: rows, complete: true, ...table }),
    })) as string | null
  }
  const daemonRecord = (home: string, pid: number, script: string, version: string): void => {
    mkdirSync(join(home, 'daemon'), { recursive: true })
    writeFileSync(join(home, 'daemon', 'daemon.json'), JSON.stringify({ pid, version, origin: 'transient', startedAt: Date.now() - 600_000, dir: join(home, 'daemon'), controlSock: join(home, 'daemon', 'control.sock'), script, persist: true }))
  }

  const { home, file } = freshHome()
  plain.update(FULL)
  const before = raw(file)
  daemonRecord(home, 424242, OLD, '1.0.10')
  const oldDaemon = [self, row(424242, [process.execPath, OLD, 'daemon'], { startedAtMs: WRITTEN - 86_400_000 })]
  const deferred = start1011('alice', () => ask(home, oldDaemon))
  const why = await deferred.settled
  check('the daemon of an older build, still alive after an update, defers the sealing', /^left plain until the next start: another Mercury build is running \(process 424242, .*1\.0\.10\)$/.test(why), why)
  check('the file is byte for byte what it was', raw(file) === before && before.includes('fixture-access-AAAA'))
  check('no key was made for it', deferred.protector.asked.protect === 0, JSON.stringify(deferred.protector.asked))
  const stillPlain = deferred.store.update({ ...(deferred.store.read() ?? {}), trustedDeviceToken: 'fixture-device-2' })
  check('a write in that session leaves the file plain and says so', stillPlain.warning === 'Credentials are stored in plaintext on disk' && onDisk(file).mercurySealed === undefined && onDisk(file).trustedDeviceToken === 'fixture-device-2', JSON.stringify(stillPlain))
  daemonRecord(home, 434343, OWN, '1.0.11')
  const handedOver = [self, row(434343, [process.execPath, OWN, 'daemon'])]
  const next = start1011('alice', () => ask(home, handedOver))
  const sealedNow = await next.settled
  check('the start after the daemon has been handed over to this build seals', sealedNow === 'sealed' && sealedOnly(file), sealedNow)
  check('and nothing written meanwhile was lost', same(next.store.read(), { ...FULL, trustedDeviceToken: 'fixture-device-2' }), JSON.stringify(next.store.read()))

  const blocked = async (label: string, rows: Table['observations'], wanted: RegExp, table: Partial<Table> = {}, bundle: string = OWN): Promise<void> => {
    const answer = await ask(home, rows, table, bundle)
    check(label, answer !== null && wanted.test(answer), String(answer))
  }
  await blocked('a headless run of an older build, which writes no record, counts', [self, row(555, [process.execPath, OLD, '-p', 'work'])], /another Mercury build is running \(process 555, /)
  mkdirSync(join(home, 'processes'), { recursive: true })
  writeFileSync(join(home, 'processes', 'cockpit-666-11111111-2222-3333-4444-555555555555.json'), JSON.stringify({ schema: 1, id: '11111111-2222-3333-4444-555555555555', pid: 666, startToken: null, exe: process.execPath, bundle: OLD, configHome: home, daemonDir: join(home, 'daemon'), terminal: null, bornAt: Date.now(), heartbeatAt: Date.now() }))
  await blocked('a window of an older build counts', [self, row(666, [process.execPath, OLD])], /another Mercury build is running \(process 666, /)
  rmSync(join(home, 'processes'), { recursive: true, force: true })
  await blocked('a process born before this build was written counts: a tree rebuilt in place', [self, row(777, [process.execPath, OWN], { startedAtMs: WRITTEN - 1 })], /process 777 started before this build was written/)
  await blocked('a process whose start time could not be read counts', [self, row(778, [process.execPath, OWN], { startedAtMs: 0 })], /the start time of process 778 could not be read/)
  await blocked('a bundle named by a relative path counts', [self, row(779, [process.execPath, 'dist/mercury.mjs'])], /process 779 names its bundle by a relative path/)
  await blocked('a process table that says it is incomplete defers', [self], /the process table could not be read \(the reader timed out\)/, { complete: false, error: 'the reader timed out' })
  await blocked('a process table without this process defers', [row(780, [process.execPath, OWN])], /this process was not found in the process table/)
  await blocked('this process born before its own bundle was written defers', [row(process.pid, [process.execPath, OWN], { startedAtMs: WRITTEN - 1 })], /this process started before its bundle was last written/)
  await blocked('a process that does not run from a mercury.mjs defers', [self], /does not run from a mercury\.mjs/, {}, join(SCRATCH, 'cli.tsx'))
  await blocked('a bundle put in place under an older date counts from when it was put there', [self, row(785, [process.execPath, OWN], { startedAtMs: placed.mtimeMs + 60_000 })], /process 785 started before this build was written/)
  daemonRecord(home, 791, OWN, '1.0.11')
  await blocked('a recorded process whose command line could not be read counts', [self, row(791, [], { exe: '' })], /the command line of process 791 could not be read/)
  const clear = async (label: string, rows: Table['observations']): Promise<void> => {
    const answer = await ask(home, rows)
    check(label, others !== null && answer === null, String(answer))
  }
  await clear('this build alone is no other build', [self])
  await clear('another process of this build, born after it was written, is no other build', [self, row(781, [process.execPath, OWN, '-p', 'work'])])
  await clear('another account\'s Mercury is not this account\'s', [self, row(782, [process.execPath, OLD], { user: 'somebody-else' })])
  await clear('a launcher that names no bundle does not read the store', [self, row(783, [join(VERSIONS, 'mercury.exe')], { exe: join(VERSIONS, 'mercury.exe') })])
  await clear('a process that is gone but not yet reaped is not alive', [self, { ...row(784, [process.execPath, OLD]), state: 'Z' }])

  const NODE = 'C:\\Program Files\\nodejs\\node.exe'
  const INSTALL = 'C:\\Users\\Op\\AppData\\Local\\Mercury\\versions'
  const WINDOWS_OWN = `${INSTALL}\\1.0.11\\mercury.mjs`
  const onWindows = (pid: number, args: string[], startedAtMs = 2_000): Record<string, unknown> => ({
    process: { pid, ppid: 1, exe: NODE, args, startedAtMs, user: 'S-1-5-21-1000', terminal: null },
    platform: 'win32',
    kind: 'window',
    startToken: null,
    registrationId: null,
    classification: 'running',
    reason: '',
    state: 'running',
  })
  const windows = (entries: Array<Record<string, unknown>>): string | null | undefined =>
    others?.otherBuildIn?.({ readAt: 0, platform: 'win32', complete: true, entries: [onWindows(10, [NODE, WINDOWS_OWN]), ...entries], memory: {}, endings: [] }, 10, WINDOWS_OWN, 1_000) as string | null | undefined
  check('on Windows the same bundle in another case and with other slashes is this build', windows([onWindows(11, [NODE, 'c:/users/op/appdata/local/mercury/versions/1.0.11/MERCURY.MJS', 'daemon'])]) === null, String(windows([onWindows(11, [NODE, 'c:/users/op/appdata/local/mercury/versions/1.0.11/MERCURY.MJS', 'daemon'])])))
  check('on Windows another versions folder is another build', /^another Mercury build is running \(process 12, C:\\Users\\Op\\AppData\\Local\\Mercury\\versions\\1\.0\.10\)$/.test(String(windows([onWindows(12, [NODE, `${INSTALL}\\1.0.10\\mercury.mjs`])]))), String(windows([onWindows(12, [NODE, `${INSTALL}\\1.0.10\\mercury.mjs`])])))
  check('on Windows a bundle named from the drive\'s current folder is a relative path', /process 13 names its bundle by a relative path/.test(String(windows([onWindows(13, [NODE, 'dist\\mercury.mjs'])]))), String(windows([onWindows(13, [NODE, 'dist\\mercury.mjs'])])))
  check('on Windows the launcher beside the bundle names no bundle and is passed over', windows([onWindows(14, [`${INSTALL}\\1.0.11\\mercury\\mercury.exe`, '--resume'])]) === null, String(windows([onWindows(14, [`${INSTALL}\\1.0.11\\mercury\\mercury.exe`, '--resume'])])))
  check('on Windows a process born before the bundle was written counts', /process 15 started before this build was written/.test(String(windows([onWindows(15, [NODE, WINDOWS_OWN], 999)]))), String(windows([onWindows(15, [NODE, WINDOWS_OWN], 999)])))
}

section('§3 the write happens under the refresh lock, and only if the file still reads as it did')
{
  const { file } = freshHome()
  plain.update({ ...FULL, claudeAiOauth: { ...TOKENS, expiresAt: Date.now() - 60_000, subscriptionType: null, rateLimitTier: null } })
  auth.clearOAuthTokenCache()
  auth.__resetKnownDeadRefreshTokensForTest()
  let reached = (): void => {}
  let answer = (): void => {}
  const atTheWire = new Promise<void>(resolve => {
    reached = resolve
  })
  tokenLeg = {
    reached,
    answered: new Promise<void>(resolve => {
      answer = resolve
    }),
  }
  const refreshing = auth.checkAndRefreshOAuthTokenIfNeeded() as Promise<boolean>
  const inside = await Promise.race([atTheWire.then(() => true), refreshing.then(() => false)])
  check('a token refresh is under way: it has taken its lock and its request is out', inside)
  const before = raw(file)
  const during = start1011('alice', nobody)
  const waited = await during.settled
  check('while a token refresh holds its lock, its request still out, the step writes nothing and says why', waited === 'left as it is until the next start: the refresh lock on the home is held' && raw(file) === before && before.includes(TOKENS.refreshToken), waited)
  answer()
  const refreshOutcome = await refreshing
  tokenLeg = null
  const landed = onDisk(file).claudeAiOauth as { refreshToken?: string } | undefined
  check('the refresh then saves its new pair, in the clear as the file still is', refreshOutcome === true && landed?.refreshToken === 'fixture-refresh-REFRESHED' && onDisk(file).mercurySealed === undefined, `${String(refreshOutcome)} ${String(landed?.refreshToken)}`)
  const after = start1011('alice', nobody)
  const sealedAfter = await after.settled
  const kept = after.store.read()?.claudeAiOauth as { refreshToken?: string } | undefined
  check('the next start seals, and the pair the refresh saved is the one sealed', sealedAfter === 'sealed' && sealedOnly(file) && kept?.refreshToken === 'fixture-refresh-REFRESHED', `${sealedAfter} ${String(kept?.refreshToken)}`)

  const { file: moved } = freshHome()
  plain.update(FULL)
  const refreshed = start1011('alice', async () => {
    plain.update({ ...(plain.read() ?? {}), claudeAiOauth: NEWER })
    return null
  })
  const skipped = await refreshed.settled
  check('a write that lands while the step is at work is not written over', skipped === 'left as it is until the next start: the file changed while the key was made' && same(onDisk(moved).claudeAiOauth, NEWER) && onDisk(moved).mercurySealed === undefined, skipped)
  const later = start1011('alice', nobody)
  check('and the next start seals what that write left', (await later.settled) === 'sealed' && same(later.store.read()?.claudeAiOauth, NEWER), await later.settled)

  const second = freshHome()
  plain.update({ trustedDeviceToken: 'fixture-device-other-home' })
  const otherBefore = raw(second.file)
  const first = freshHome()
  plain.update(FULL)
  const pinned = start1011('alice', async () => {
    setAuthScope(second.home)
    return null
  })
  const pinnedOutcome = await pinned.settled
  clearAuthScope()
  check('the step stays on the home it started on when the session moves to another', pinnedOutcome === 'sealed' && sealedOnly(first.file) && raw(second.file) === otherBefore, pinnedOutcome)
}

section('§4 what the step leaves alone')
{
  const { file } = freshHome()
  start1011('alice', nobody).store.update(FULL)
  plain.update({ ...(plain.read() ?? {}), claudeAiOauth: NEWER })
  const sealedBefore = onDisk(file).mercurySealed
  const back = start1011('alice', async () => 'another Mercury build is running (process 1, /older)')
  const folded = await back.settled
  check('clear fields left beside a sealed part by a downgrade are folded in and sealed, another build alive or not', folded === 'sealed' && sealedOnly(file) && onDisk(file).mercurySealed !== sealedBefore, folded)
  check('the sign-in made on the older build wins and the rest is kept', same(back.store.read(), { ...FULL, claudeAiOauth: NEWER }), JSON.stringify(back.store.read()))

  const stranger = start1011('bob', nobody)
  const untouched = raw(file)
  const kept = await stranger.settled
  check('a sealed part this process cannot open is left as it is', /^the sealed part was not opened \(Key not valid for use in specified state\); the file is left as it is$/.test(kept) && raw(file) === untouched, kept)

  const { file: plainFile } = freshHome()
  plain.update(FULL)
  const plainBefore = raw(plainFile)
  const silent = fakeProtector('alice')
  silent.answers = false
  const custody = sealedRecord.createKeyCustody(silent)
  const mute = starts === null ? 'no start-up step on this tree' : ((await (starts.startSealedStore({ file: plainTextStorage, custody, otherBuildAlive: nobody }) as { settled: Promise<string> }).settled) as string)
  check('where the protector gives no key the plain file stays as it is', mute === 'left as it is: the protector did not answer' && raw(plainFile) === plainBefore, mute)

  const { file: bare } = freshHome()
  writeFileSync(bare, '{}')
  const nothing = start1011('alice', nobody)
  check('a store with nothing in it is not sealed', (await nothing.settled) === 'nothing in the store to seal' && raw(bare) === '{}', await nothing.settled)
}

section('§5 the choice at start, by platform and by the flag')
{
  const { home } = freshHome()
  const startFor = prefetch.sealedStoreStartFor as ((platform: string, flag: string | undefined) => { warmed: Promise<void>; settled: Promise<string> } | null) | undefined
  check('Linux and macOS start no sealed store', startFor !== undefined && startFor('linux', undefined) === null && startFor('darwin', undefined) === null)
  check('MERCURY_CREDENTIAL_STORE=file starts none on Windows', startFor !== undefined && startFor('win32', 'file') === null)
  process.env.SystemRoot = join(SCRATCH, 'no-windows-here')
  const windows = startFor?.('win32', undefined) ?? null
  check('Windows starts one, and a home with no store is left without one', windows !== null && (await windows.settled) === 'no store to seal', windows === null ? 'null' : await windows.settled)
  writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: TOKENS }))
  const asksCensus = startFor?.('win32', undefined) ?? null
  const answer = asksCensus === null ? 'null' : await asksCensus.settled
  check('with a plain file it asks the census, which here cannot name this process\'s build, and leaves the file plain', /^left plain until the next start: this process does not run from a mercury\.mjs/.test(answer) && same(onDisk(join(home, '.credentials.json')), { claudeAiOauth: TOKENS }), answer)
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  prefetch.startKeychainPrefetch()
  await prefetch.ensureKeychainPrefetchCompleted()
  check('under the flag the read-ahead starts nothing and is done at once', same(onDisk(join(home, '.credentials.json')), { claudeAiOauth: TOKENS }))
}

rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 })
console.log(failures === 0 ? `\nALL ${total} CHECKS PASS` : `\n${failures} OF ${total} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)
