#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'credential-store-unseal-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_DAEMON_DIR
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_OAUTH_TOKEN
delete process.env.CI
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
process.env.SystemRoot = join(SCRATCH, 'no-windows-here')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { plainTextStorage } = await import(join(SRC, 'utils/secureStorage/plainTextStorage.ts'))
const { clearAuthScope } = await import(join(SRC, 'utils/envUtils.ts'))
const { lockSync } = await import(join(SRC, 'utils/lockfile.ts'))
const { FLAG_REGISTRY } = await import(join(SRC, 'substrate/flagRegistry.ts'))
const { enableConfigs } = await import(join(SRC, 'utils/config/globalConfig.ts'))
enableConfigs()
const auth = await import(join(SRC, 'utils/auth.ts'))
const sealedRecord = await import(join(SRC, 'utils/secureStorage/sealedRecord.ts'))
const sealedFile = await import(join(SRC, 'utils/secureStorage/sealedFileStorage.ts'))
const starts = await import(join(SRC, 'utils/secureStorage/sealedStoreStart.ts'))
const system = await import(join(SRC, 'utils/secureStorage/systemProtector.ts'))
const files = await import(join(SRC, 'utils/secureStorage/fileStorage.ts'))
const prefetch = await import(join(SRC, 'utils/secureStorage/keychainPrefetch.ts'))

type Answer = { ok: true; bytes: Buffer } | { ok: false; why: string; final: boolean }
type Store = {
  name: string
  read(): Record<string, unknown> | null
  update(data: Record<string, unknown>): { success: boolean; warning?: string; code?: string }
}
type Fake = {
  scheme: string
  asked: { protect: number; unprotect: number; offTheLoop: number }
  meanwhile: (() => void) | null
  protect(secret: Buffer): Answer
  unprotect(token: Buffer): Answer
  protectAsync(secret: Buffer): Promise<Answer>
  unprotectAsync(token: Buffer): Promise<Answer>
}

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
    meanwhile: null,
    protect(secret) {
      fake.asked.protect++
      return { ok: true, bytes: Buffer.concat([mark, turn(secret)]) }
    },
    unprotect(token) {
      fake.asked.unprotect++
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
      fake.meanwhile?.()
      return fake.unprotect(token)
    },
  }
  return fake
}

const plain = plainTextStorage as Store
const PLAINTEXT_WARNING = 'Credentials are stored in plaintext on disk'
const UNSEALED = 'written back in the clear, as the credential store flag asks'
const CLEAR_ALREADY = 'in the clear already, as the credential store flag asks'

type Process = { store: Store; protector: Fake; censusAsked: () => number; start: () => Promise<string> }
function process1011(account: string, flag: 'unseal' | undefined): Process {
  const protector = fakeProtector(account)
  const custody = sealedRecord.createKeyCustody(protector)
  const seals = (system.sealsUnder as ((flag: string | undefined) => boolean) | undefined)?.(flag) ?? true
  const store = sealedFile.createSealedFileStorage(plainTextStorage, custody, seals) as Store
  let asked = 0
  return {
    store,
    protector,
    censusAsked: () => asked,
    start: () =>
      (starts.startSealedStore({
        file: plainTextStorage,
        custody,
        otherBuildAlive: async () => {
          asked++
          return null
        },
        seals,
      }) as { settled: Promise<string> }).settled,
  }
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
  extensionSecrets: { 'ext-1': { first: 'fixture-ext-first' } },
  trustedDeviceToken: 'fixture-device-1',
}

section('§1 the flag\'s second value, read in one place')
{
  const sealsUnder = system.sealsUnder as ((flag: string | undefined) => boolean) | undefined
  check('with no value the store seals', sealsUnder?.(undefined) === true, String(sealsUnder?.(undefined)))
  check('under unseal it does not', sealsUnder?.('unseal') === false, String(sealsUnder?.('unseal')))
  check('no other spelling turns sealing off', sealsUnder?.('UNSEAL') === true && sealsUnder?.('plain') === true && sealsUnder?.('') === true)
  check('under unseal Windows still has its protector, to open what is sealed', sealsUnder !== undefined && (system.systemProtectorFor('win32', 'unseal') as { scheme?: string } | null)?.scheme === 'dpapi-user')
  check('under file it has none, as before', system.systemProtectorFor('win32', 'file') === null)
  check('on macOS and Linux unseal changes nothing: no protector, so no sealed store to open', sealsUnder !== undefined && system.systemProtectorFor('darwin', 'unseal') === null && system.systemProtectorFor('linux', 'unseal') === null)
  const row = (FLAG_REGISTRY as Array<{ env: string; summary: string; off: string }>).find(flag => flag.env === 'MERCURY_CREDENTIAL_STORE')
  check('the flag\'s row names the value and what it does', row !== undefined && row.summary.includes("'unseal'") && row.summary.includes('written back in the clear') && row.off.includes('win32: the sealed file'), row?.off)
}

section('§2 a sealed home reads plain again at the next start, and stays plain')
{
  const { file } = freshHome()
  process1011('alice', undefined).store.update(FULL)
  check('the home is sealed', sealedOnly(file), raw(file).slice(0, 80))
  check('a build that reads the plain file alone reads it signed out', plain.read()?.claudeAiOauth === undefined)

  const back = process1011('alice', 'unseal')
  const first = await back.start()
  check('the start under unseal says it wrote the store back in the clear', first === UNSEALED, first)
  check('the file holds the whole store in the clear and no sealed part', same(onDisk(file), FULL), raw(file).slice(0, 120))
  check('a build that reads the plain file alone now finds the sign-in', same(plain.read()?.claudeAiOauth, TOKENS))
  check('the protector was asked once, to unwrap, off the event loop, and never to wrap', same(back.protector.asked, { protect: 0, unprotect: 1, offTheLoop: 1 }), JSON.stringify(back.protector.asked))
  check('the census was not asked: every build reads a plain file', back.censusAsked() === 0, String(back.censusAsked()))

  const before = raw(file)
  const again = process1011('alice', 'unseal')
  const second = await again.start()
  check('the next start under unseal finds it in the clear already and writes nothing', second === CLEAR_ALREADY && raw(file) === before, second)
  check('and asks the protector nothing', same(again.protector.asked, { protect: 0, unprotect: 0, offTheLoop: 0 }), JSON.stringify(again.protector.asked))
  const saved = again.store.update({ ...(again.store.read() ?? {}), trustedDeviceToken: 'fixture-device-2' })
  check('a write under unseal lands in the clear and answers the plaintext warning', saved.success === true && saved.warning === PLAINTEXT_WARNING && same(onDisk(file), { ...FULL, trustedDeviceToken: 'fixture-device-2' }), JSON.stringify(saved))
  check('the store names itself plaintext under unseal', again.store.name === 'plaintext', again.store.name)
  const third = await process1011('alice', 'unseal').start()
  check('a third start: still in the clear', third === CLEAR_ALREADY && onDisk(file).mercurySealed === undefined, third)

  const { file: empty } = freshHome()
  const signing = process1011('alice', 'unseal')
  const signIn = signing.store.update({ claudeAiOauth: TOKENS })
  check('a sign-in under unseal on a home with no store is saved in the clear and says so', signIn.success === true && signIn.warning === PLAINTEXT_WARNING && same(onDisk(empty), { claudeAiOauth: TOKENS }), JSON.stringify(signIn))
  check('and no key was made for it', same(signing.protector.asked, { protect: 0, unprotect: 0, offTheLoop: 0 }), JSON.stringify(signing.protector.asked))

  process.env.MERCURY_CONFIG_DIR = join(file, '..')
  const without = process1011('alice', undefined)
  const resealed = await without.start()
  check('without the value the start after seals again', resealed === 'sealed' && sealedOnly(file) && same(without.store.read(), { ...FULL, trustedDeviceToken: 'fixture-device-2' }), resealed)
}

section('§3 the unsealing takes the care the sealing takes')
{
  const { file } = freshHome()
  process1011('alice', undefined).store.update(FULL)
  plain.update({ ...(plain.read() ?? {}), claudeAiOauth: NEWER })
  plain.update({ ...(plain.read() ?? {}), mcpOAuth: { 'x|1': { accessToken: 'fixture-mcp-x-new' } } })
  const folded = await process1011('alice', 'unseal').start()
  check('clear fields an older build left beside the sealed part are folded in: its sign-in wins, the MCP sign-ins per entry', folded === UNSEALED && same(onDisk(file), { ...FULL, claudeAiOauth: NEWER, mcpOAuth: { 'x|1': { accessToken: 'fixture-mcp-x-new' }, 'y|2': { accessToken: 'fixture-mcp-y' } } }), `${folded} ${raw(file).slice(0, 160)}`)

  const { file: withMarkers } = freshHome()
  process1011('alice', undefined).store.update(FULL)
  writeFileSync(withMarkers, JSON.stringify({ ...onDisk(withMarkers), mercurySealedRemoved: [['claudeAiOauth']] }))
  const unmarked = await process1011('alice', 'unseal').start()
  check('what a closed session removed stays removed when the store is written back in the clear, and the markers go', unmarked === UNSEALED && onDisk(withMarkers).claudeAiOauth === undefined && onDisk(withMarkers).mercurySealedRemoved === undefined && same(onDisk(withMarkers).mcpOAuth, FULL.mcpOAuth), `${unmarked} ${raw(withMarkers).slice(0, 120)}`)

  const { file: foreign } = freshHome()
  process1011('alice', undefined).store.update(FULL)
  const untouched = raw(foreign)
  const stranger = process1011('bob', 'unseal')
  const kept = await stranger.start()
  check('a sealed part this process cannot open is left as it is under unseal too', kept === 'the sealed part was not opened (Key not valid for use in specified state); the file is left as it is' && raw(foreign) === untouched, kept)
  const beside = stranger.store.update({ ...(stranger.store.read() ?? {}), claudeAiOauth: NEWER })
  check('and a write keeps it, the sign-in standing beside it', beside.warning === PLAINTEXT_WARNING && onDisk(foreign).mercurySealed === JSON.parse(untouched).mercurySealed && same(onDisk(foreign).claudeAiOauth, NEWER), JSON.stringify(beside))

  const { file: early } = freshHome()
  process1011('alice', undefined).store.update(FULL)
  const writer = process1011('alice', 'unseal')
  const written = writer.store.update({ ...(writer.store.read() ?? {}), trustedDeviceToken: 'fixture-device-3' })
  check('a write under unseal that comes before the start has done its work writes the whole store in the clear', written.warning === PLAINTEXT_WARNING && same(onDisk(early), { ...FULL, trustedDeviceToken: 'fixture-device-3' }), raw(early).slice(0, 120))

  const { file: locked } = freshHome()
  process1011('alice', undefined).store.update(FULL)
  const sealedBefore = raw(locked)
  const site = auth.oauthRefreshLockSite() as { dir: string; options: { realpath: false } }
  const release = lockSync(site.dir, site.options) as () => void
  const waiting = await process1011('alice', 'unseal').start()
  release()
  check('while the refresh lock on the home is held nothing is written', waiting === 'left as it is until the next start: the refresh lock on the home is held' && raw(locked) === sealedBefore, waiting)
  const after = await process1011('alice', 'unseal').start()
  check('the next start writes it back in the clear', after === UNSEALED && same(onDisk(locked), FULL), after)

  const { file: moving } = freshHome()
  const other = process1011('alice', undefined)
  other.store.update(FULL)
  const racing = process1011('alice', 'unseal')
  racing.protector.meanwhile = () => {
    racing.protector.meanwhile = null
    other.store.update({ ...FULL, trustedDeviceToken: 'fixture-device-landed' })
  }
  const skipped = await racing.start()
  check('a write that lands while the store is being opened is not written over', skipped === 'left as it is until the next start: the file changed while it was opened' && other.store.read()?.trustedDeviceToken === 'fixture-device-landed' && sealedOnly(moving), skipped)
}

section('§4 the choice at start and of the store, by the flag\'s value')
{
  const { file } = freshHome()
  writeFileSync(file, JSON.stringify({ claudeAiOauth: TOKENS }))
  const startFor = prefetch.sealedStoreStartFor as (platform: string, flag: string | undefined) => { settled: Promise<string> } | null
  const underUnseal = await (startFor('win32', 'unseal')?.settled ?? Promise.resolve('no start'))
  check('on Windows under unseal the start finds a plain file in the clear already, and asks no census', underUnseal === CLEAR_ALREADY, underUnseal)
  const underNothing = await (startFor('win32', undefined)?.settled ?? Promise.resolve('no start'))
  check('with no value the same start takes the sealing road and asks the census', /^left plain until the next start: this process does not run from a mercury\.mjs/.test(underNothing), underNothing)
  check('under file there is no start at all', startFor('win32', 'file') === null)
  check('the file is untouched by all three', same(onDisk(file), { claudeAiOauth: TOKENS }))
  const protector = fakeProtector('alice')
  const fileStorageFor = files.fileStorageFor as (protector: Fake | null, seals?: boolean) => Store
  check('the store for a protector seals unless told not to', fileStorageFor(protector).name === 'encrypted-with-plaintext-fallback' && fileStorageFor(protector, true) === fileStorageFor(protector) && fileStorageFor(protector, false).name === 'plaintext' && fileStorageFor(protector, false) !== fileStorageFor(protector), fileStorageFor(protector, false).name)
  check('the two share one custody of keys: what one unwrapped the other does not ask for again', (() => {
    freshHome()
    fileStorageFor(protector).update(FULL)
    const asked = protector.asked.unprotect
    return same(fileStorageFor(protector, false).read(), FULL) && protector.asked.unprotect === asked
  })(), JSON.stringify(protector.asked))
  check('with no protector the store is the plain file store, whatever the switch', fileStorageFor(null, false) === plainTextStorage && fileStorageFor(null) === plainTextStorage)
}

rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 })
console.log(failures === 0 ? `\nALL ${total} CHECKS PASS` : `\n${failures} OF ${total} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)
