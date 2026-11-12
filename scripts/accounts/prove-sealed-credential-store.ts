#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'sealed-credential-store-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { plainTextStorage } = await import(join(SRC, 'utils/secureStorage/plainTextStorage.ts'))
const { setAuthScope } = await import(join(SRC, 'utils/envUtils.ts'))
const sealedRecord = await import(join(SRC, 'utils/secureStorage/sealedRecord.ts')).catch(() => null)
const sealedFile = await import(join(SRC, 'utils/secureStorage/sealedFileStorage.ts')).catch(() => null)

type Answer = { ok: true; bytes: Buffer } | { ok: false; why: string; final: boolean }
type Store = {
  name: string
  read(): Record<string, unknown> | null
  readAsync(): Promise<Record<string, unknown> | null>
  update(data: Record<string, unknown>): { success: boolean; warning?: string; code?: string }
  delete(): boolean
}
type Fake = {
  scheme: string
  asked: { protect: number; unprotect: number }
  answers: boolean
  forgets: boolean
  mangles: boolean
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

function fakeProtector(account: string, scheme = 'fake-protector'): Fake {
  const pad = createHash('sha256').update(`pad:${account}`).digest()
  const mark = Buffer.from(`sealed-for:${account}:`)
  const turn = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte, at) => byte ^ pad[at % pad.length]!))
  const fake: Fake = {
    scheme,
    asked: { protect: 0, unprotect: 0 },
    answers: true,
    forgets: false,
    mangles: false,
    protect(secret) {
      fake.asked.protect++
      if (!fake.answers) return { ok: false, why: 'the protector did not answer', final: false }
      return { ok: true, bytes: Buffer.concat([mark, turn(secret)]) }
    },
    unprotect(token) {
      fake.asked.unprotect++
      if (!fake.answers) return { ok: false, why: 'the protector did not answer', final: false }
      if (fake.forgets || !token.subarray(0, mark.length).equals(mark)) return { ok: false, why: 'Key not valid for use in specified state', final: true }
      const secret = turn(token.subarray(mark.length))
      if (fake.mangles) secret[0] = secret[0]! ^ 1
      return { ok: true, bytes: secret }
    },
    async protectAsync(secret) {
      return fake.protect(secret)
    },
    async unprotectAsync(token) {
      await new Promise(resolve => setTimeout(resolve, 5))
      return fake.unprotect(token)
    },
  }
  return fake
}

const plain = plainTextStorage as Store
function process1011(protector: Fake, clock?: () => number): Store {
  if (sealedRecord === null || sealedFile === null) return plain
  return sealedFile.createSealedFileStorage(plainTextStorage, sealedRecord.createKeyCustody(protector, clock)) as Store
}

let homes = 0
function freshHome(): string {
  const home = join(SCRATCH, `home-${++homes}`)
  mkdirSync(home, { recursive: true })
  setAuthScope(home)
  return join(home, '.credentials.json')
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
const sealedPart = (file: string): unknown => onDisk(file).mercurySealed
const SEALED_TEXT = /^1\.fake-protector\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

const TOKENS = { accessToken: 'fixture-access-AAAA', refreshToken: 'fixture-refresh-BBBB', expiresAt: 4102444800000, scopes: ['user:inference'], subscriptionType: 'pro', rateLimitTier: null }
const NEWER = { ...TOKENS, accessToken: 'fixture-access-CCCC', refreshToken: 'fixture-refresh-DDDD' }
const FULL = {
  claudeAiOauth: TOKENS,
  mcpOAuth: { 'x|1': { accessToken: 'fixture-mcp-x-old' }, 'y|2': { accessToken: 'fixture-mcp-y' } },
  mcpOAuthClientConfig: { 'x|1': { clientSecret: 'fixture-client-x' } },
  extensionSecrets: { 'ext-1': { first: 'fixture-ext-first', second: 'fixture-ext-second' } },
  trustedDeviceToken: 'fixture-device-1',
}
const SECRETS = ['fixture-access-AAAA', 'fixture-refresh-BBBB', 'fixture-mcp-x-old', 'fixture-mcp-y', 'fixture-client-x', 'fixture-ext-first', 'fixture-ext-second', 'fixture-device-1']
const PLAINTEXT_WARNING = 'Credentials are stored in plaintext on disk'

section('§1 a sign-in on a home with no store: the file does not hold the credential, and it reads back')
{
  const file = freshHome()
  const alice = fakeProtector('alice')
  const store = process1011(alice)
  const signIn = store.update({ ...(store.read() ?? {}), claudeAiOauth: TOKENS })
  const text = raw(file)
  check('the sign-in is saved', signIn.success === true, JSON.stringify(signIn))
  check('the save answers no plaintext warning', signIn.warning === undefined, String(signIn.warning))
  check('the stored file does not hold the access token in the clear', text !== '' && !text.includes(TOKENS.accessToken), text.slice(0, 120))
  check('the stored file does not hold the refresh token in the clear', text !== '' && !text.includes(TOKENS.refreshToken), text.slice(0, 120))
  check('the stored file is one JSON object with the one sealed key', same(Object.keys(onDisk(file)), ['mercurySealed']), Object.keys(onDisk(file)).join(','))
  check('the sealed key holds one text of six parts: format, protector, key, iv, tag, data', SEALED_TEXT.test(String(sealedPart(file))), String(sealedPart(file)).slice(0, 60))
  check('the credential reads back', same(store.read()?.claudeAiOauth, TOKENS), JSON.stringify(store.read()))
  check('the credential reads back on the asynchronous road', same((await store.readAsync())?.claudeAiOauth, TOKENS))
  check('what is read back carries no sealed key', store.read() !== null && !Object.hasOwn(store.read() ?? {}, 'mercurySealed'))
  check('the store names itself encrypted-with-plaintext-fallback', store.name === 'encrypted-with-plaintext-fallback', store.name)
  check('the new key was wrapped once and came back once before it was used', alice.asked.protect === 1 && alice.asked.unprotect === 1, JSON.stringify(alice.asked))
  store.update({ ...(store.read() ?? {}), ...FULL })
  const full = raw(file)
  check('no value of a full store stands in the file', full !== '' && SECRETS.every(secret => !full.includes(secret)), SECRETS.filter(secret => full.includes(secret)).join(','))
  check('a full store reads back whole', same(store.read(), FULL), JSON.stringify(store.read()))
}

section('§2 what a read costs: the protector is asked once in a process, and never on a write')
{
  const file = freshHome()
  process1011(fakeProtector('alice')).update(FULL)
  const second = fakeProtector('alice')
  const store = process1011(second)
  const first = store.read()
  check('a second process reads the store', same(first, FULL), JSON.stringify(first))
  check('it asked the protector once, to unwrap', second.asked.unprotect === 1 && second.asked.protect === 0, JSON.stringify(second.asked))
  const keyBefore = String(sealedPart(file)).split('.')[2]
  const dataBefore = String(sealedPart(file)).split('.')[5]
  for (let turn = 0; turn < 40; turn++) store.read()
  for (let turn = 0; turn < 3; turn++) store.update({ ...(store.read() ?? {}), trustedDeviceToken: `fixture-device-${turn + 2}` })
  await store.readAsync()
  check('forty reads, three writes and an asynchronous read later it has asked nothing more', second.asked.unprotect === 1 && second.asked.protect === 0, JSON.stringify(second.asked))
  check('the writes kept the wrapped key the file had', typeof keyBefore === 'string' && String(sealedPart(file)).split('.')[2] === keyBefore)
  check('each write sealed afresh', typeof dataBefore === 'string' && String(sealedPart(file)).split('.')[5] !== dataBefore)
  check('the last write reads back', store.read()?.trustedDeviceToken === 'fixture-device-4', String(store.read()?.trustedDeviceToken))
  const once = String(sealedPart(file)).split('.')
  store.update({ ...(store.read() ?? {}) })
  const twice = String(sealedPart(file)).split('.')
  check('the same content written twice is sealed under a fresh iv each time', once.length === 6 && twice.length === 6 && once[3] !== twice[3] && once[5] !== twice[5] && once[2] === twice[2], `${once[3]} ${twice[3]}`)
  const third = fakeProtector('alice')
  const racing = process1011(third)
  const [left, right] = await Promise.all([racing.readAsync(), racing.readAsync()])
  check('two asynchronous reads at once ask the protector once', third.asked.unprotect === 1 && left?.trustedDeviceToken === 'fixture-device-4' && right?.trustedDeviceToken === 'fixture-device-4', JSON.stringify(third.asked))
  const other = freshHome()
  store.update({ trustedDeviceToken: 'fixture-device-other-home' })
  check('a second home sealed by the same process reuses the key it holds', second.asked.protect === 0 && String(sealedPart(other)).split('.')[2] === keyBefore, JSON.stringify(second.asked))
}

section('§3 a new key is used only after its wrapped form has come back; otherwise the store says plaintext')
{
  for (const [fault, set] of [
    ['a protector that does not answer', (fake: Fake) => { fake.answers = false }],
    ['a protector that wraps but cannot unwrap', (fake: Fake) => { fake.forgets = true }],
    ['a protector that gives the key back changed', (fake: Fake) => { fake.mangles = true }],
  ] as Array<[string, (fake: Fake) => void]>) {
    const file = freshHome()
    const broken = fakeProtector('alice')
    set(broken)
    const store = process1011(broken)
    const signIn = store.update({ claudeAiOauth: TOKENS })
    check(`${fault}: the sign-in is saved and answers the plaintext warning`, signIn.success === true && signIn.warning === PLAINTEXT_WARNING, JSON.stringify(signIn))
    check(`${fault}: nothing sealed was written`, existsSync(file) && sealedPart(file) === undefined && same(onDisk(file).claudeAiOauth, TOKENS), raw(file).slice(0, 80))
    check(`${fault}: the credential reads back`, same(store.read()?.claudeAiOauth, TOKENS))
    const asked = broken.asked.protect
    const next = freshHome()
    const again = store.update({ trustedDeviceToken: 'fixture-device-9' })
    check(`${fault}: on a second home the process does not ask for a new key again, and says plaintext there too`, asked === 1 && broken.asked.protect === 1 && again.warning === PLAINTEXT_WARNING && onDisk(next).trustedDeviceToken === 'fixture-device-9', JSON.stringify(broken.asked))
  }
}

section('§4 a write never seals a file that is still plain')
{
  const file = freshHome()
  plain.update({ claudeAiOauth: TOKENS })
  const alice = fakeProtector('alice')
  const store = process1011(alice)
  const saved = store.update({ ...(store.read() ?? {}), trustedDeviceToken: 'fixture-device-1' })
  check('the write lands in the clear, beside what was there', sealedPart(file) === undefined && same(onDisk(file), { claudeAiOauth: TOKENS, trustedDeviceToken: 'fixture-device-1' }), raw(file).slice(0, 120))
  check('it answers the plaintext warning', saved.success === true && saved.warning === PLAINTEXT_WARNING, JSON.stringify(saved))
  check('the protector was not asked', alice.asked.protect === 0 && alice.asked.unprotect === 0, JSON.stringify(alice.asked))
}

section('§5 a downgrade: the plain store of 1.0.10 keeps the sealed part, and what it writes is folded back')
{
  const file = freshHome()
  process1011(fakeProtector('alice')).update(FULL)
  const sealedBefore = sealedPart(file)
  const older = plain.read() ?? {}
  check('1.0.10 reads the store as signed out', typeof sealedBefore === 'string' && older.claudeAiOauth === undefined && same(Object.keys(older), ['mercurySealed']), Object.keys(older).join(','))
  plain.update({ ...(plain.read() ?? {}), claudeAiOauth: NEWER })
  plain.update({ ...(plain.read() ?? {}), mcpOAuth: { 'x|1': { accessToken: 'fixture-mcp-x-new' } } })
  plain.update({ ...(plain.read() ?? {}), extensionSecrets: { 'ext-1': { first: 'fixture-ext-first-new' } } })
  check('its writes keep the sealed part as it was', typeof sealedBefore === 'string' && sealedPart(file) === sealedBefore)
  check('its sign-in stands in the clear beside it', same(onDisk(file).claudeAiOauth, NEWER))
  const back = fakeProtector('alice')
  const store = process1011(back)
  const view = store.read() ?? {}
  check('on return the sign-in made on 1.0.10 wins, whole', same(view.claudeAiOauth, NEWER), JSON.stringify(view.claudeAiOauth))
  check('the MCP sign-ins fold per entry: the one renewed on 1.0.10, the other from the sealed part', same(view.mcpOAuth, { 'x|1': { accessToken: 'fixture-mcp-x-new' }, 'y|2': { accessToken: 'fixture-mcp-y' } }), JSON.stringify(view.mcpOAuth))
  check('the extension secrets fold per entry', same(view.extensionSecrets, { 'ext-1': { first: 'fixture-ext-first-new', second: 'fixture-ext-second' } }), JSON.stringify(view.extensionSecrets))
  check('what 1.0.10 never saw is still there', view.trustedDeviceToken === 'fixture-device-1' && same(view.mcpOAuthClientConfig, FULL.mcpOAuthClientConfig))
  check('the folded view carries no sealed key', sealedPart(file) !== undefined && !Object.hasOwn(view, 'mercurySealed'))
  const saved = store.update({ ...view, trustedDeviceToken: 'fixture-device-2' })
  const after = raw(file)
  check('the next write of 1.0.11 seals everything again', saved.success === true && saved.warning === undefined && same(Object.keys(onDisk(file)), ['mercurySealed']), Object.keys(onDisk(file)).join(','))
  check('no credential is left in the clear', after !== '' && !after.includes('fixture-'), after.slice(0, 120))
  check('and the whole reads back', same(store.read(), { ...view, trustedDeviceToken: 'fixture-device-2' }), JSON.stringify(store.read()))
}

section('§6 a sealed part this process cannot open is never replaced and never dropped')
{
  const roads: Array<[string, (file: string) => Fake]> = [
    ['the protector does not answer', () => { const fake = fakeProtector('alice'); fake.answers = false; return fake }],
    ['the part was sealed for another account', () => fakeProtector('bob')],
    ['the sealed text is damaged', file => {
      const text = String(sealedPart(file))
      writeFileSync(file, JSON.stringify({ mercurySealed: `${text.slice(0, -2)}${text.endsWith('AA') ? 'BB' : 'AA'}` }))
      return fakeProtector('alice')
    }],
    ['one bit inside a sealed value is changed', file => {
      const fields = String(sealedPart(file)).split('.')
      const data = Buffer.from(fields[5] ?? '', 'base64url')
      data[40] = data[40]! ^ 1
      fields[5] = data.toString('base64url')
      writeFileSync(file, JSON.stringify({ mercurySealed: fields.join('.') }))
      return fakeProtector('alice')
    }],
    ['the protector named in the sealed text is rewritten to one whose key still unwraps', file => {
      const fields = String(sealedPart(file)).split('.')
      fields[1] = 'another-protector'
      writeFileSync(file, JSON.stringify({ mercurySealed: fields.join('.') }))
      return fakeProtector('alice', 'another-protector')
    }],
    ['the sealed text is of a newer format', file => {
      writeFileSync(file, JSON.stringify({ mercurySealed: `2${String(sealedPart(file)).slice(1)}` }))
      return fakeProtector('alice')
    }],
    ['the part was sealed by another protector', () => fakeProtector('alice', 'another-protector')],
    ['the sealed part is not text', file => {
      writeFileSync(file, JSON.stringify({ mercurySealed: { held: String(sealedPart(file)) } }))
      return fakeProtector('alice')
    }],
  ]
  for (const [road, arrange] of roads) {
    const file = freshHome()
    process1011(fakeProtector('alice')).update(FULL)
    const sealedAtFirst = sealedPart(file)
    const protector = arrange(file)
    const riding = sealedPart(file)
    const store = process1011(protector)
    const view = store.read() ?? {}
    check(`${road}: the session reads as 1.0.10 would, signed out, the part riding`, sealedAtFirst !== undefined && view.claudeAiOauth === undefined && same(view.mercurySealed, riding), Object.keys(view).join(','))
    for (let turn = 0; turn < 5; turn++) store.read()
    check(`${road}: the protector is asked at most once for it`, protector.asked.unprotect <= 1, JSON.stringify(protector.asked))
    const saved = store.update({ ...view, claudeAiOauth: NEWER })
    check(`${road}: a sign-in is saved beside it and answers the plaintext warning`, saved.success === true && saved.warning === PLAINTEXT_WARNING && same(onDisk(file).claudeAiOauth, NEWER), JSON.stringify(saved))
    check(`${road}: the part stands as it stood`, riding !== undefined && same(sealedPart(file), riding))
    check(`${road}: the session reads its own sign-in back`, same(store.read()?.claudeAiOauth, NEWER))
    const bare = store.update({ trustedDeviceToken: 'fixture-device-alone' })
    check(`${road}: a write that does not carry the part keeps it all the same`, bare.success === true && riding !== undefined && same(sealedPart(file), riding) && onDisk(file).trustedDeviceToken === 'fixture-device-alone')
  }
  const file = freshHome()
  process1011(fakeProtector('alice')).update(FULL)
  const away = process1011(fakeProtector('bob'))
  away.update({ ...(away.read() ?? {}), claudeAiOauth: NEWER })
  const home = process1011(fakeProtector('alice'))
  const folded = home.read() ?? {}
  check('where the part opens again, the sign-in made beside it wins and nothing sealed was lost', same(folded, { ...FULL, claudeAiOauth: NEWER }), JSON.stringify(folded))
  const stale = freshHome()
  process1011(fakeProtector('alice')).update(FULL)
  const cannot = process1011(fakeProtector('bob'))
  const early = cannot.read() ?? {}
  const can = process1011(fakeProtector('alice'))
  can.update({ ...(can.read() ?? {}), trustedDeviceToken: 'fixture-device-later' })
  const later = sealedPart(stale)
  cannot.update({ ...early, claudeAiOauth: NEWER })
  check('a write that carries an older part keeps the part the disk holds', typeof later === 'string' && later !== early.mercurySealed && sealedPart(stale) === later)
  check('and what was sealed in between is not rolled back', process1011(fakeProtector('alice')).read()?.trustedDeviceToken === 'fixture-device-later')
}

section('§7 the plain store\'s own refusals and removals pass through')
{
  const file = freshHome()
  const store = process1011(fakeProtector('alice'))
  store.update(FULL)
  const before = raw(file)
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    console.log('  [SKIP] a store that cannot be read is not replaced — a mode-000 file needs a non-root POSIX process')
  } else {
    chmodSync(file, 0o000)
    const refused = process1011(fakeProtector('alice')).update({ trustedDeviceToken: 'fixture-device-refused' })
    chmodSync(file, 0o600)
    check('a store that cannot be read is not replaced: the save is refused with its errno', sealedPart(file) !== undefined && refused.success === false && refused.code === 'EACCES' && raw(file) === before, JSON.stringify(refused))
  }
  check('a sign-out removes the file', sealedPart(file) !== undefined && store.delete() === true && !existsSync(file))
  check('and the store then reads empty', store.read() === null)
}

section('§8 what is held against the protector: a refusal for the process, a silence for thirty seconds')
{
  freshHome()
  process1011(fakeProtector('alice')).update(FULL)
  let at = 1_000_000
  const clock = (): number => at
  const slow = fakeProtector('alice')
  slow.answers = false
  const waiting = process1011(slow, clock)
  for (let turn = 0; turn < 5; turn++) waiting.read()
  check('a protector that stayed silent is asked once while the silence is held', slow.asked.unprotect === 1 && waiting.read()?.claudeAiOauth === undefined, JSON.stringify(slow.asked))
  at += 29_000
  waiting.read()
  check('twenty-nine seconds later it has still been asked once', slow.asked.unprotect === 1, JSON.stringify(slow.asked))
  at += 2_000
  slow.answers = true
  const healed = waiting.read()
  check('after thirty seconds it is asked again, and the session reads its store without a restart', slow.asked.unprotect === 2 && same(healed, FULL), `${JSON.stringify(slow.asked)} ${Object.keys(healed ?? {}).join(',')}`)
  const stranger = fakeProtector('bob')
  const refusedFor = process1011(stranger, clock)
  refusedFor.read()
  at += 3_600_000
  for (let turn = 0; turn < 5; turn++) refusedFor.read()
  await refusedFor.readAsync()
  check('a protector that answered no is not asked again, an hour later either', stranger.asked.unprotect === 1, JSON.stringify(stranger.asked))
  const cold = fakeProtector('alice')
  cold.answers = false
  const booting = process1011(cold, clock)
  const ahead = await booting.readAsync()
  cold.answers = true
  const first = booting.read()
  check('a silence met on the asynchronous road is not held against the first synchronous read', ahead?.claudeAiOauth === undefined && cold.asked.unprotect === 2 && same(first, FULL), JSON.stringify(cold.asked))
  const stuck = fakeProtector('alice')
  stuck.answers = false
  const hanging = process1011(stuck, clock)
  await hanging.readAsync()
  hanging.read()
  hanging.read()
  await hanging.readAsync()
  check('where both roads met silence, neither asks again inside the thirty seconds', stuck.asked.unprotect === 2, JSON.stringify(stuck.asked))
  const empty = freshHome()
  const late = fakeProtector('alice')
  late.answers = false
  const signing = process1011(late, clock)
  const inTheClear = signing.update({ claudeAiOauth: TOKENS })
  at += 31_000
  late.answers = true
  const another = freshHome()
  const sealedLater = signing.update({ claudeAiOauth: TOKENS })
  check('a new key refused by silence is asked for again after thirty seconds, on a home with no store', inTheClear.warning === PLAINTEXT_WARNING && sealedPart(empty) === undefined && sealedLater.warning === undefined && SEALED_TEXT.test(String(sealedPart(another))), `${JSON.stringify(late.asked)} ${JSON.stringify(sealedLater)}`)
}

section('§9 a removal made while the sealed part was closed holds when the part opens')
{
  const REMOVED = 'mercurySealedRemoved'
  const Y_ALONE = { 'y|2': { accessToken: 'fixture-mcp-y' } }
  const entries = (value: unknown): Record<string, unknown> => ({ ...((value ?? {}) as Record<string, unknown>) })
  const closedProcess = (): { store: Store; open: () => void } => {
    let at = 5_000_000
    const protector = fakeProtector('alice')
    protector.answers = false
    const store = process1011(protector, () => at)
    return {
      store,
      open: () => {
        protector.answers = true
        at += 31_000
      },
    }
  }
  const sealedHome = (store: Record<string, unknown> = FULL): string => {
    const file = freshHome()
    process1011(fakeProtector('alice')).update(store)
    return file
  }

  const file = sealedHome()
  const session = closedProcess()
  const closed = session.store.read() ?? {}
  check('the part is closed: the session sees none of the sealed MCP sign-ins', closed.mcpOAuth === undefined && typeof closed.mercurySealed === 'string', Object.keys(closed).join(','))
  session.store.update({ ...closed, mcpOAuth: { 'x|1': { accessToken: 'fixture-mcp-x-while-closed' } } })
  const signedIn = session.store.read() ?? {}
  const fewer = entries(signedIn.mcpOAuth)
  delete fewer['x|1']
  session.store.update({ ...signedIn, mcpOAuth: fewer })
  check('the removal leaves a marker beside the sealed part: the field and the key, and no value', same(onDisk(file)[REMOVED], [['mcpOAuth', 'x|1']]) && !raw(file).includes('fixture-'), JSON.stringify(onDisk(file)[REMOVED]))
  const still = session.store.read() ?? {}
  check('the closed session reads the entry as gone, and its view does not show the marker', entries(still.mcpOAuth)['x|1'] === undefined && !Object.hasOwn(still, REMOVED), Object.keys(still).join(','))
  session.open()
  const opened = session.store.read() ?? {}
  check('the protector answers again: the removed entry stays gone', entries(opened.mcpOAuth)['x|1'] === undefined, JSON.stringify(opened.mcpOAuth))
  check('what the session never saw is still there', same(opened.mcpOAuth, Y_ALONE) && same(opened.claudeAiOauth, TOKENS) && same(opened.extensionSecrets, FULL.extensionSecrets) && opened.trustedDeviceToken === 'fixture-device-1', JSON.stringify(opened))
  check('the read wrote nothing: the marker stands until the next write', same(onDisk(file)[REMOVED], [['mcpOAuth', 'x|1']]))
  const sealedOnce = session.store.update({ ...opened, trustedDeviceToken: 'fixture-device-after' })
  check('the next write seals once, and the marker goes with the clear fields', sealedOnce.success === true && sealedOnce.warning === undefined && same(Object.keys(onDisk(file)), ['mercurySealed']), Object.keys(onDisk(file)).join(','))
  const fresh = process1011(fakeProtector('alice')).read() ?? {}
  check('another process reads the store without the removed entry', same(fresh.mcpOAuth, Y_ALONE) && fresh.trustedDeviceToken === 'fixture-device-after', JSON.stringify(fresh.mcpOAuth))

  const fieldFile = sealedHome()
  const second = closedProcess()
  second.store.update({ ...(second.store.read() ?? {}), claudeAiOauth: NEWER })
  const signedOut = { ...(second.store.read() ?? {}) }
  delete signedOut.claudeAiOauth
  second.store.update(signedOut)
  check('a whole field removed while the part was closed is marked by its name', same(onDisk(fieldFile)[REMOVED], [['claudeAiOauth']]) && !raw(fieldFile).includes('fixture-'), JSON.stringify(onDisk(fieldFile)[REMOVED]))
  second.open()
  const after = second.store.read() ?? {}
  check('when the part opens, the sign-in that was sealed does not come back', after.claudeAiOauth === undefined && same(after.mcpOAuth, FULL.mcpOAuth) && after.trustedDeviceToken === 'fixture-device-1', Object.keys(after).join(','))

  const extensionFile = sealedHome()
  const third = closedProcess()
  third.store.update({ ...(third.store.read() ?? {}), extensionSecrets: { 'ext-1': { third: 'fixture-ext-third' }, 'ext-2': { key: 'fixture-ext2-key', other: 'fixture-ext2-other' } } })
  third.store.update({ ...(third.store.read() ?? {}), extensionSecrets: { 'ext-2': { other: 'fixture-ext2-other' } } })
  check('an extension removed whole is marked whole, a single option by its name', same(onDisk(extensionFile)[REMOVED], [['extensionSecrets', 'ext-1'], ['extensionSecrets', 'ext-2', 'key']]), JSON.stringify(onDisk(extensionFile)[REMOVED]))
  third.open()
  check('when the part opens, the removed extension has none of its sealed secrets either', same(third.store.read()?.extensionSecrets, { 'ext-2': { other: 'fixture-ext2-other' } }), JSON.stringify(third.store.read()?.extensionSecrets))

  const pinsFile = sealedHome({ ...FULL, gatewayTrust: { 'a.example': 'fixture-pin-a', 'b.example': 'fixture-pin-b' } })
  const fourth = closedProcess()
  fourth.store.update({ ...(fourth.store.read() ?? {}), gatewayTrust: { 'a.example': 'fixture-pin-a-new' } })
  const unpinned = { ...(fourth.store.read() ?? {}) }
  delete unpinned.gatewayTrust
  fourth.store.update(unpinned)
  check('a map removed whole is marked entry by entry, for the entries the session saw', same(onDisk(pinsFile)[REMOVED], [['gatewayTrust', 'a.example']]), JSON.stringify(onDisk(pinsFile)[REMOVED]))
  fourth.open()
  check('so the entry it never saw survives, and the one it removed does not', same(fourth.store.read()?.gatewayTrust, { 'b.example': 'fixture-pin-b' }), JSON.stringify(fourth.store.read()?.gatewayTrust))

  const twiceFile = sealedHome()
  const fifth = closedProcess()
  fifth.store.update({ ...(fifth.store.read() ?? {}), claudeAiOauth: NEWER, trustedDeviceToken: 'fixture-device-closed' })
  const first = { ...(fifth.store.read() ?? {}) }
  delete first.claudeAiOauth
  fifth.store.update(first)
  const then = { ...(fifth.store.read() ?? {}) }
  delete then.trustedDeviceToken
  fifth.store.update({ ...then, [REMOVED]: [['mcpOAuth', 'y|2']] })
  check('markers add up over the writes of a closed session, and a caller cannot hand one in', same(onDisk(twiceFile)[REMOVED], [['claudeAiOauth'], ['trustedDeviceToken']]), JSON.stringify(onDisk(twiceFile)[REMOVED]))
  fifth.store.update({ ...(fifth.store.read() ?? {}), claudeAiOauth: TOKENS })
  check('a write that removes nothing carries them on', same(onDisk(twiceFile)[REMOVED], [['claudeAiOauth'], ['trustedDeviceToken']]) && same(onDisk(twiceFile).claudeAiOauth, TOKENS))
  fifth.open()
  const both = fifth.store.read() ?? {}
  check('when the part opens, a field marked and then written again holds the new value, and the other stays gone', same(both.claudeAiOauth, TOKENS) && both.trustedDeviceToken === undefined && same(both.mcpOAuth, FULL.mcpOAuth), JSON.stringify(Object.keys(both)))

  const sixth = closedProcess()
  const addedFile = sealedHome()
  sixth.store.update({ ...(sixth.store.read() ?? {}), mcpOAuth: { 'x|1': { accessToken: 'fixture-mcp-x-added' } }, [REMOVED]: [['mcpOAuth', 'y|2']] })
  check('a write that removes nothing leaves no marker, whatever the caller hands in under that name', onDisk(addedFile)[REMOVED] === undefined && typeof onDisk(addedFile).mercurySealed === 'string', JSON.stringify(onDisk(addedFile)[REMOVED]))
  sixth.open()
  check('the other direction: an entry added in the clear while the part was closed wins over the older sealed entry of its key', same(sixth.store.read()?.mcpOAuth, { 'x|1': { accessToken: 'fixture-mcp-x-added' }, ...Y_ALONE }), JSON.stringify(sixth.store.read()?.mcpOAuth))

  const lateFile = sealedHome()
  const seventh = closedProcess()
  seventh.store.update({ ...(seventh.store.read() ?? {}), mcpOAuth: { 'x|1': { accessToken: 'fixture-mcp-x-while-closed' } } })
  const stale = seventh.store.read() ?? {}
  seventh.open()
  const late = entries(stale.mcpOAuth)
  delete late['x|1']
  const lateWrite = seventh.store.update({ ...stale, mcpOAuth: late })
  check('a removal handed in from a closed view after the part has opened holds as well, sealed at once', lateWrite.warning === undefined && same(Object.keys(onDisk(lateFile)), ['mercurySealed']) && same(seventh.store.read()?.mcpOAuth, Y_ALONE), JSON.stringify(seventh.store.read()?.mcpOAuth))

  const olderFile = sealedHome()
  plain.update({ ...(plain.read() ?? {}), mcpOAuth: { 'x|1': { accessToken: 'fixture-mcp-x-on-older' } } })
  const emptied = { ...(plain.read() ?? {}), mcpOAuth: {} }
  plain.update(emptied)
  const returned = process1011(fakeProtector('alice')).read() ?? {}
  check('the limit that stays: a removal made by a build that writes no marker comes back from the sealed part', onDisk(olderFile)[REMOVED] === undefined && same(returned.mcpOAuth, FULL.mcpOAuth), JSON.stringify(returned.mcpOAuth))
}

rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 })
console.log(failures === 0 ? `\nALL ${total} CHECKS PASS` : `\n${failures} OF ${total} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)
