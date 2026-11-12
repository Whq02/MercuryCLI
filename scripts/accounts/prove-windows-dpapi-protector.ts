#!/usr/bin/env bun
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REAL = process.argv.includes('--real')
const SCRATCH = mkdtempSync(join(tmpdir(), 'windows-dpapi-protector-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
process.env.NODE_ENV = 'test'
process.env.MERCURY_OAUTH_TOKEN = 'fixture-env-oauth-token'
process.env.OPENAI_API_KEY = 'fixture-env-provider-key'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { plainTextStorage } = await import(join(SRC, 'utils/secureStorage/plainTextStorage.ts'))
const { setAuthScope } = await import(join(SRC, 'utils/envUtils.ts'))
const index = await import(join(SRC, 'utils/secureStorage/index.ts'))
const dpapi = await import(join(SRC, 'utils/secureStorage/windowsDpapiProtector.ts')).catch(() => null)
const system = await import(join(SRC, 'utils/secureStorage/systemProtector.ts')).catch(() => null)
const files = await import(join(SRC, 'utils/secureStorage/fileStorage.ts')).catch(() => null)

type Answer = { ok: true; bytes: Buffer } | { ok: false; why: string; final: boolean }
type Protector = {
  scheme: string
  protect(secret: Buffer): Answer
  unprotect(token: Buffer): Answer
  protectAsync(secret: Buffer): Promise<Answer>
  unprotectAsync(token: Buffer): Promise<Answer>
}
type Store = {
  name: string
  read(): Record<string, unknown> | null
  update(data: Record<string, unknown>): { success: boolean; warning?: string; code?: string }
}

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
const why = (answer: Answer | undefined): string => (answer === undefined ? 'no protector on this tree' : answer.ok ? `ok, ${answer.bytes.length} bytes` : answer.why)
const protectorOf = (timeoutMs?: number): Protector | undefined => dpapi?.createDpapiProtector(timeoutMs) as Protector | undefined
const TOKENS = { accessToken: 'fixture-access-AAAA', refreshToken: 'fixture-refresh-BBBB', expiresAt: 4102444800000, scopes: ['user:inference'] }
const PLAINTEXT_WARNING = 'Credentials are stored in plaintext on disk'
const credentialsIn = (home: string): string => {
  mkdirSync(home, { recursive: true })
  setAuthScope(home)
  return join(home, '.credentials.json')
}
const onDisk = (file: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

const ROOT = join(SCRATCH, 'windows')
const STAND_IN_DIR = join(ROOT, 'System32', 'WindowsPowerShell', 'v1.0')
const CALLS = join(SCRATCH, 'calls.jsonl')
const MODE = join(SCRATCH, 'mode')
const setMode = (mode: string): void => writeFileSync(MODE, mode)
const calls = (): Array<{ argv: string[]; way: string; textLength: number; secretsInEnv: string[] }> =>
  existsSync(CALLS)
    ? readFileSync(CALLS, 'utf8')
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line))
    : []

const STAND_IN = `
import { appendFileSync, readFileSync } from 'node:fs'
const mode = readFileSync(${JSON.stringify(MODE)}, 'utf8').trim()
const [way, text] = readFileSync(0, 'utf8').split('\\n')
appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({
  argv: process.argv.slice(2),
  way,
  textLength: (text ?? '').length,
  secretsInEnv: Object.keys(process.env).filter(name => name === 'MERCURY_OAUTH_TOKEN' || name === 'OPENAI_API_KEY'),
}) + '\\n')
const MARK = Buffer.from('held-by-this-account:')
const turn = bytes => Buffer.from(bytes.map((byte, at) => byte ^ (0x5a + (at % 7))))
if (mode === 'silent') {
  await new Promise(resolve => setTimeout(resolve, 60000))
} else if (mode === 'refuses') {
  console.log('no System.Security.Cryptography.CryptographicException 0x8009000B: Key not valid for use in specified state.')
} else if (mode === 'garbage') {
  console.log('#< CLIXML')
} else if (mode === 'exits') {
  console.error('Cannot invoke method. Method invocation is supported only on core types in this language mode.')
  process.exit(3)
} else if (mode === 'malformed') {
  console.log('ok !!!not-base64!!!')
} else {
  const bytes = Buffer.from(text ?? '', 'base64')
  if (way === 'protect') {
    const answer = 'ok ' + Buffer.concat([MARK, turn(bytes)]).toString('base64')
    if (mode === 'no-then-ok') console.log('no System.Security.Cryptography.CryptographicException 0x8009000B: Key not valid for use in specified state.')
    process.stdout.write((mode === 'noisy' ? '#< CLIXML\\r\\n' : mode === 'marked' ? '\\uFEFF' : '') + answer + (mode === 'noisy' || mode === 'crlf' || mode === 'marked' ? '\\r\\n' : '\\n'))
    if (mode === 'ok-then-exit') process.exit(7)
    if (mode === 'ok-then-silent') await new Promise(resolve => setTimeout(resolve, 60000))
  } else if (way === 'unprotect' && bytes.subarray(0, MARK.length).equals(MARK)) {
    process.stdout.write('ok ' + turn(bytes.subarray(MARK.length)).toString('base64') + '\\n')
  } else {
    console.log('no System.Security.Cryptography.CryptographicException 0x8007000D: The data is invalid.')
  }
}
`

if (process.platform === 'win32') {
  for (const part of ['§1 the request', '§2 the answers', '§3 the store over it']) skip(part, 'a script cannot stand in for powershell.exe on Windows; --real asks the system itself')
} else {
  mkdirSync(STAND_IN_DIR, { recursive: true })
  writeFileSync(join(SCRATCH, 'stand-in.mjs'), STAND_IN)
  writeFileSync(join(STAND_IN_DIR, 'powershell.exe'), `#!/bin/sh\nexec "${process.execPath}" "${join(SCRATCH, 'stand-in.mjs')}" "$@"\n`)
  chmodSync(join(STAND_IN_DIR, 'powershell.exe'), 0o755)
  process.env.SystemRoot = ROOT

  section('§1 the request: the system\'s PowerShell by its own path, the key on stdin and nowhere else')
  {
    setMode('answers')
    const protector = protectorOf()
    const key = randomBytes(32)
    const wrapped = protector?.protect(key)
    const back = wrapped?.ok ? protector?.unprotect(wrapped.bytes) : undefined
    check('the protector names its scheme dpapi-user', protector?.scheme === 'dpapi-user', String(protector?.scheme))
    check('a key is wrapped', wrapped?.ok === true && !wrapped.bytes.equals(key), why(wrapped))
    check('and comes back the same', back?.ok === true && back.bytes.equals(key), why(back))
    const wrappedAsync = await protector?.protectAsync(key)
    const backAsync = wrappedAsync?.ok ? await protector?.unprotectAsync(wrappedAsync.bytes) : undefined
    check('the asynchronous road wraps and gives back the same key', backAsync?.ok === true && backAsync.bytes.equals(key), why(backAsync))
    const seen = calls()
    const argv = seen[0]?.argv ?? []
    const script = Buffer.from(argv[4] ?? '', 'base64').toString('utf16le')
    check('four PowerShell starts were made, one for each request', seen.length === 4, String(seen.length))
    check('each start is -NoLogo -NoProfile -NonInteractive -EncodedCommand and one script', seen.length === 4 && seen.every(call => call.argv.length === 5 && call.argv.slice(0, 4).join(' ') === '-NoLogo -NoProfile -NonInteractive -EncodedCommand' && call.argv[4] === argv[4]), argv.slice(0, 4).join(' '))
    check('the script asks DPAPI for the current user and reads its request from the console', script.includes('[System.Security.Cryptography.ProtectedData]::Protect(') && script.includes('[System.Security.Cryptography.ProtectedData]::Unprotect(') && script.includes('DataProtectionScope]::CurrentUser') && script.includes('[Console]::ReadLine()'), script.slice(0, 80))
    const secrets = [key.toString('base64'), wrapped?.ok ? wrapped.bytes.toString('base64') : 'no-token']
    check('no argument of any start holds the key or its wrapped form', seen.length === 4 && seen.every(call => call.argv.every(arg => secrets.every(secret => !arg.includes(secret) && !Buffer.from(arg, 'base64').toString('utf16le').includes(secret)))))
    check('the request is two lines on stdin: the way, then the bytes as base64', seen.length === 4 && same(seen.map(call => call.way), ['protect', 'unprotect', 'protect', 'unprotect']) && seen[0]?.textLength === key.toString('base64').length, JSON.stringify(seen.map(call => [call.way, call.textLength])))
    check('the PowerShell it starts is not handed the session\'s token or a provider key', seen.length === 4 && seen.every(call => call.secretsInEnv.length === 0), JSON.stringify(seen[0]?.secretsInEnv))
  }

  section('§2 the answers: it says why whenever the system does not give the bytes')
  {
    const quick = protectorOf(1500)
    const key = randomBytes(32)
    setMode('crlf')
    const crlf = quick?.protect(key)
    check('one answer ended CR LF is read', crlf?.ok === true, why(crlf))
    setMode('marked')
    const marked = quick?.protect(key)
    check('one answer behind a byte-order mark is read', marked?.ok === true, why(marked))
    for (const [mode, label, wanted, final] of [
      ['ok-then-exit', 'an answer from a PowerShell that then ended with exit 7 is no key', /PowerShell ended with exit 7/, true],
      ['no-then-ok', 'an answer that follows a refusal is no key, and the refusal is what is said', /CryptographicException 0x8009000B: Key not valid for use in specified state\./, true],
      ['noisy', 'an answer behind a line that is no answer is no key', /PowerShell wrote something that is not one answer/, true],
      ['ok-then-silent', 'an answer from a PowerShell that then ran out of its time is no key, and it may be asked again', /did not answer within 1500 ms/, false],
    ] as Array<[string, string, RegExp, boolean]>) {
      setMode(mode)
      const answer = quick?.protect(key)
      const answerAsync = await quick?.protectAsync(key)
      check(label, answer?.ok === false && wanted.test(answer.why) && answer.final === final, why(answer))
      check(`${label}, on the asynchronous road too`, answerAsync?.ok === false && wanted.test(answerAsync.why) && answerAsync.final === final, why(answerAsync))
    }
    for (const [mode, label, wanted] of [
      ['refuses', 'a refusal of the system is given in the system\'s words', /CryptographicException 0x8009000B: Key not valid for use in specified state\./],
      ['garbage', 'output that is no answer is no key', /PowerShell gave no answer/],
      ['exits', 'a PowerShell that fails says what it wrote', /Method invocation is supported only on core types/],
      ['malformed', 'an answer that is not base64 is no key', /PowerShell gave no answer/],
    ] as Array<[string, string, RegExp]>) {
      setMode(mode)
      const answer = quick?.unprotect(key)
      const answerAsync = await quick?.unprotectAsync(key)
      check(`${label}, and the answer is final for the process`, answer?.ok === false && wanted.test(answer.why) && answer.final === true, why(answer))
      check(`${label}, on the asynchronous road too`, answerAsync?.ok === false && wanted.test(answerAsync.why), why(answerAsync))
    }
    setMode('answers')
    const foreign = quick?.unprotect(Buffer.from('held-by-another-account:0123456789'))
    check('bytes this account did not wrap are refused', foreign?.ok === false && /The data is invalid/.test(foreign.why), why(foreign))
    setMode('silent')
    const began = Date.now()
    const silent = quick?.unprotect(key)
    const waited = Date.now() - began
    check('a PowerShell that does not answer is given up after the time it is allowed, and may be asked again', silent?.ok === false && silent.final === false && /did not answer within 1500 ms/.test(silent.why) && waited >= 1400 && waited < 8000, `${why(silent)} after ${waited} ms`)
    const silentAsync = await quick?.unprotectAsync(key)
    check('on the asynchronous road too', silentAsync?.ok === false && silentAsync.final === false && /did not answer within 1500 ms/.test(silentAsync.why), why(silentAsync))
    process.env.SystemRoot = join(SCRATCH, 'no-windows-here')
    const absent = quick?.protect(key)
    const absentAsync = await quick?.protectAsync(key)
    check('a system with no PowerShell at that path says so', absent?.ok === false && absent.final === true && /ENOENT at .*no-windows-here.*powershell\.exe/.test(absent.why), why(absent))
    check('on the asynchronous road too', absentAsync?.ok === false && /ENOENT at .*no-windows-here.*powershell\.exe/.test(absentAsync.why), why(absentAsync))
    process.env.SystemRoot = ROOT
  }

  section('§3 the store over it: two starts for the first sealing, one for a process that reads, none after')
  {
    setMode('answers')
    rmSync(CALLS, { force: true })
    const file = credentialsIn(join(SCRATCH, 'home-sealed'))
    const first = files?.fileStorageFor(protectorOf()) as Store | undefined
    const signIn = first?.update({ ...(first.read() ?? {}), claudeAiOauth: TOKENS })
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    check('a sign-in is sealed: no plaintext warning, no token in the file', signIn?.success === true && signIn.warning === undefined && text !== '' && !text.includes('fixture-'), `${JSON.stringify(signIn)} ${text.slice(0, 60)}`)
    check('the file holds one text sealed by dpapi-user', /^1\.dpapi-user\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/.test(String(onDisk(file).mercurySealed)), String(onDisk(file).mercurySealed).slice(0, 40))
    check('the first sealing started PowerShell twice: to wrap the key, and to see it come back', same(calls().map(call => call.way), ['protect', 'unprotect']), JSON.stringify(calls().map(call => call.way)))
    const second = files?.fileStorageFor(protectorOf()) as Store | undefined
    check('another process reads the sign-in back', same(second?.read()?.claudeAiOauth, TOKENS), JSON.stringify(second?.read()))
    check('it started PowerShell once', calls().length === 3 && calls()[2]?.way === 'unprotect', String(calls().length))
    for (let turn = 0; turn < 20; turn++) second?.read()
    second?.update({ ...(second.read() ?? {}), trustedDeviceToken: 'fixture-device-2' })
    check('twenty reads and a write later it has started none', calls().length === 3 && second?.read()?.trustedDeviceToken === 'fixture-device-2', String(calls().length))
    check('the store is the same object for the same protector', (() => {
      const protector = protectorOf()
      return protector !== undefined && files?.fileStorageFor(protector) === files?.fileStorageFor(protector)
    })())
    setMode('refuses')
    const locked = files?.fileStorageFor(protectorOf()) as Store | undefined
    const view = locked?.read() ?? {}
    check('a logon whose keys are locked reads the store as signed out, the sealed part riding', view.claudeAiOauth === undefined && typeof view.mercurySealed === 'string', Object.keys(view).join(','))
    const sealedBefore = onDisk(file).mercurySealed
    const beside = locked?.update({ ...view, claudeAiOauth: { ...TOKENS, accessToken: 'fixture-access-SSH' } })
    check('its sign-in is saved beside the sealed part and answers the plaintext warning', beside?.success === true && beside.warning === PLAINTEXT_WARNING && typeof sealedBefore === 'string' && onDisk(file).mercurySealed === sealedBefore, JSON.stringify(beside))
    const fresh = credentialsIn(join(SCRATCH, 'home-locked'))
    const plainSignIn = locked?.update({ claudeAiOauth: TOKENS })
    check('on a home with no store the same logon signs in in the clear and says so', plainSignIn?.success === true && plainSignIn.warning === PLAINTEXT_WARNING && same(onDisk(fresh), { claudeAiOauth: TOKENS }), JSON.stringify(plainSignIn))
  }
}

section('§4 the choice, by platform and by the flag')
{
  const forWindows = system?.systemProtectorFor('win32', undefined) as Protector | null | undefined
  check('Windows has a protector: dpapi-user', forWindows?.scheme === 'dpapi-user', String(forWindows?.scheme))
  check('and it is one object for the process', forWindows !== undefined && forWindows !== null && system?.systemProtectorFor('win32', undefined) === forWindows)
  check('MERCURY_CREDENTIAL_STORE=file leaves Windows on the plain file, with no protector', system?.systemProtectorFor('win32', 'file') === null)
  check('Linux has none yet', system?.systemProtectorFor('linux', undefined) === null)
  check('macOS has none: its store is the Keychain', system?.systemProtectorFor('darwin', undefined) === null)
  check('the store Mercury picks for Windows is the sealed one', (files?.fileStorageFor(forWindows ?? null) as Store | undefined)?.name === 'encrypted-with-plaintext-fallback', String((files?.fileStorageFor(forWindows ?? null) as Store | undefined)?.name))
  check('with no protector the store is the plain file store itself', files?.fileStorageFor(null) === plainTextStorage)
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  check('under the flag this process gets the plain file store, as before', index.getSecureStorage() === plainTextStorage, String(index.getSecureStorage().name))
}

if (REAL) {
  section('--real: the system\'s own PowerShell and DPAPI')
  if (process.platform !== 'win32') {
    check('--real is run on Windows', false, process.platform)
  } else {
    const protector = protectorOf()
    const key = randomBytes(32)
    const times: number[] = []
    const timed = <T,>(work: () => T): T => {
      const began = Date.now()
      const out = work()
      times.push(Date.now() - began)
      return out
    }
    const wrapped = timed(() => protector?.protect(key))
    const back = wrapped?.ok ? timed(() => protector?.unprotect(wrapped.bytes)) : undefined
    console.log(`  the system answered: protect ${why(wrapped)}; unprotect ${why(back)}`)
    console.log(`  one PowerShell start, in ms: ${times.join(', ')}`)
    if (wrapped?.ok === true) {
      check('the key comes back the same', back?.ok === true && back.bytes.equals(key), why(back))
      const altered = Buffer.from(wrapped.bytes)
      altered[altered.length - 1] = altered[altered.length - 1]! ^ 1
      const refused = protector?.unprotect(altered)
      check('an altered wrapped key is refused in the system\'s words', refused?.ok === false, why(refused))
      const backAsync = await protector?.unprotectAsync(wrapped.bytes)
      check('the asynchronous road gives the same key', backAsync?.ok === true && backAsync.bytes.equals(key), why(backAsync))
      const file = credentialsIn(join(SCRATCH, 'home-real'))
      const store = files?.fileStorageFor(protector ?? null) as Store | undefined
      const signIn = store?.update({ claudeAiOauth: TOKENS })
      const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
      check('a sign-in is sealed and reads back in another process\'s custody', signIn?.success === true && signIn.warning === undefined && !text.includes('fixture-') && same((files?.fileStorageFor(protectorOf() ?? null) as Store | undefined)?.read()?.claudeAiOauth, TOKENS), `${JSON.stringify(signIn)} ${text.slice(0, 60)}`)
    } else {
      const file = credentialsIn(join(SCRATCH, 'home-real'))
      const store = files?.fileStorageFor(protector ?? null) as Store | undefined
      const signIn = store?.update({ claudeAiOauth: TOKENS })
      check('this logon cannot wrap a key: the sign-in is saved in the clear and says so', signIn?.success === true && signIn.warning === PLAINTEXT_WARNING && same(onDisk(file), { claudeAiOauth: TOKENS }), JSON.stringify(signIn))
    }
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 })
console.log(failures === 0 ? `\nALL ${total} CHECKS PASS` : `\n${failures} OF ${total} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)
