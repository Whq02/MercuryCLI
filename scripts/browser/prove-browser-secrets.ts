import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { Browser as DriverBrowser } from 'puppeteer-core'

const ROOT = process.env.PROOF_SUBJECT_ROOT ?? join(import.meta.dir, '../..')
const actualSpawn = childProcess.spawnSync
const scratch = mkdtempSync(join(tmpdir(), 'browser-secrets-'))
const file = join(scratch, 'browser-secrets.json')
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const store = new Map<string, string>()
const calls: Array<{ args: string[]; input: string; env: NodeJS.ProcessEnv | undefined }> = []
let writeFails = false
let wrongReadback = false
let readThrows = false
let afterRead: (() => void) | undefined
let checks = 0
let failures = 0
function check(label: string, ok: boolean): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
}
function save(data: unknown): void {
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 })
  chmodSync(file, 0o600)
}
function hasEntry(ref: string): boolean {
  return Object.hasOwn(JSON.parse(readFileSync(file, 'utf8')), ref)
}
mock.module('node:child_process', () => ({
  ...childProcess,
  spawnSync: ((command: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv }) => {
    if (command !== 'security') return actualSpawn(command, args, options)
    calls.push({ args, input: options.input ?? '', env: options.env })
    if (args[0] === '-i') {
      const line = options.input ?? ''
      const service = / -s "([^"]+)"/.exec(line)?.[1]
      const hex = / -X ([a-f0-9]+)\n$/.exec(line)?.[1]
      if (!service || !hex || writeFails) return { status: 1, stdout: '', stderr: 'fixture write refused' }
      store.set(service, Buffer.from(hex, 'hex').toString('utf8'))
      return { status: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'find-generic-password') {
      if (readThrows) throw new Error('fixture keychain unavailable')
      const value = store.get(args[args.indexOf('-s') + 1]!)
      const callback = afterRead
      afterRead = undefined
      callback?.()
      return { status: value === undefined ? 44 : 0, stdout: value === undefined ? '' : `${wrongReadback ? '"wrong"' : value}\n`, stderr: '' }
    }
    throw new Error('unexpected security command')
  }) as typeof childProcess.spawnSync,
}))

try {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  const { resolveBrowserSecret, scrubSecretFromText } = await import(join(ROOT, 'src/services/browser/browserSecrets.ts'))
  const resolve = resolveBrowserSecret as (ref: string, opts?: { fileDir?: string; origin?: string }) =>
    | { state: 'ok'; value: string; source: string; origin?: string }
    | { state: 'missing' | 'refused'; note: string }
  const opts = { fileDir: scratch }
  const password = '  fixture-keychain-password\n'
  save({ LOGIN: password, KEEP: 'other-login' })
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  const pinned = resolve('LOGIN', opts)
  check('the file pin never spawns security and leaves its secret on disk', pinned.state === 'ok' && pinned.source === 'file' && calls.length === 0 && hasEntry('LOGIN'))

  process.env.MERCURY_CREDENTIAL_STORE = 'keychain'
  process.env.MERCURY_BROWSER_SECRET_CHILD_SENTINEL = 'must-not-reach-child'
  const migrated = resolve('LOGIN', opts)
  check('a browser password moves to the OS keychain after read-back', migrated.state === 'ok' && migrated.value === password && migrated.source === 'keychain')
  check('migration removes only the verified entry, keeping other logins', !hasEntry('LOGIN') && hasEntry('KEEP'))
  check('the remaining file keeps its owner-only mode', (statSync(file).mode & 0o777) === 0o600)
  check('the keychain write is followed by a fresh read', calls.length === 2 && calls[0]?.args[0] === '-i' && calls[1]?.args[0] === 'find-generic-password')
  check('the password travels only on stdin, never argv or child environment', calls.length > 0 && calls.every(c => !c.args.join(' ').includes(password) && !c.args.join(' ').includes(Buffer.from(password).toString('hex')) && c.env?.MERCURY_BROWSER_SECRET_CHILD_SENTINEL === undefined))
  const keychainOnly = resolve('LOGIN', opts)
  check('a keychain-only login resolves with whitespace preserved', keychainOnly.state === 'ok' && keychainOnly.source === 'keychain' && keychainOnly.value === password)
  check('a different config home cannot read that entry', resolve('LOGIN', { fileDir: join(scratch, 'other-home') }).state === 'missing')

  save({ UPDATE: 'newer-file-value' })
  writeFails = true
  const failedWrite = resolve('UPDATE', opts)
  check('a refused keychain write leaves the working file copy', failedWrite.state === 'ok' && failedWrite.source === 'file' && hasEntry('UPDATE'))
  writeFails = false
  wrongReadback = true
  const mismatch = resolve('UPDATE', opts)
  check('a successful write with mismatched read-back never removes the file copy', mismatch.state === 'ok' && mismatch.source === 'file' && hasEntry('UPDATE'))
  wrongReadback = false
  readThrows = true
  const unavailable = resolve('UPDATE', opts)
  check('a read-back exception keeps the file fallback', unavailable.state === 'ok' && unavailable.source === 'file' && hasEntry('UPDATE'))
  readThrows = false
  afterRead = () => save({ UPDATE: 'changed-during-keychain-write', ADDED: 'must-survive' })
  resolve('UPDATE', opts)
  check('a file changed during migration is not pruned using an old snapshot', hasEntry('UPDATE') && hasEntry('ADDED'))
  const newer = resolve('UPDATE', opts)
  check('the newer file entry wins over a stale keychain copy', newer.state === 'ok' && newer.value === 'changed-during-keychain-write' && !hasEntry('UPDATE'))

  save({ WIDE: 'never-read' })
  chmodSync(file, 0o644)
  const beforeWide = calls.length
  const wide = resolve('WIDE', opts)
  check('an exposed file refuses without a keychain write or value disclosure', wide.state === 'refused' && !wide.note.includes('never-read') && calls.length === beforeWide)
  process.env.MERCURY_BROWSER_SECRET_WIDE = 'environment-override'
  const env = resolve('WIDE', opts)
  check('the environment still wins without touching either persisted store', env.state === 'ok' && env.source === 'env' && env.value === 'environment-override' && calls.length === beforeWide)
  delete process.env.MERCURY_BROWSER_SECRET_WIDE

  save({ LARGE: 'x'.repeat(5000) })
  const beforeLarge = calls.length
  const large = resolve('LARGE', opts)
  check('a value larger than the security stdin line stays usable in the file, never in argv', large.state === 'ok' && large.value.length === 5000 && large.source === 'file' && hasEntry('LARGE') && calls.length === beforeLarge)

  const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  const origin = 'https://login.example'
  save({ OTP: { origin, totp: seed }, KEEP: 'other-login' })
  const originalNow = Date.now
  Date.now = () => 59_000
  try {
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    const code = resolve('OTP', { ...opts, origin })
    check('an origin-bound stored seed mints the RFC 6238 SHA-1 code (six digits)', code.state === 'ok' && code.value === '287082' && code.origin === origin)
    check('the stored seed is not exposed in the resolution', !JSON.stringify(code).includes(seed))
    check('the code uses the existing secret scrub rail', code.state === 'ok' && scrubSecretFromText(`failed ${code.value}`, code.value, 'OTP') === 'failed [redacted:OTP]')
    Date.now = () => 1_111_111_109_000
    const next = resolve('OTP', { ...opts, origin })
    check('a later time step mints a fresh zero-padded code', next.state === 'ok' && next.value === '081804')
    for (const wrong of [undefined, 'http://login.example', 'https://login.example:444', 'https://sub.login.example', 'https://login.example.evil', 'https://login.example@evil.example']) {
      const refused = resolve('OTP', { ...opts, origin: wrong })
      check(`TOTP refuses a missing or different exact origin (${wrong ?? 'absent'})`, refused.state === 'refused' && !JSON.stringify(refused).includes(seed))
    }
    for (const entry of [{ totp: seed }, { origin: `${origin}/path`, totp: seed }, { origin: 'file:///secret', totp: seed }, { origin, totp: 'bad!seed' }, { origin, totp: '' }, { origin, totp: 'A' }]) {
      save({ BAD: entry })
      check('an unbound or malformed seed refuses without disclosing it', resolve('BAD', { ...opts, origin }).state === 'refused')
    }
    save({ OTP: { origin, totp: seed } })
    process.env.MERCURY_CREDENTIAL_STORE = 'keychain'
    const beforeWrongOrigin = calls.length
    check('wrong-origin TOTP resolution refuses before migrating the seed', resolve('OTP', { ...opts, origin: 'https://other.example' }).state === 'refused' && calls.length === beforeWrongOrigin && hasEntry('OTP'))
    const movedCode = resolve('OTP', { ...opts, origin })
    check('the keychain stores the bound seed, never a soon-expired code', movedCode.state === 'ok' && movedCode.source === 'keychain' && movedCode.value === '081804' && !hasEntry('OTP') && [...store.values()].some(v => v === JSON.stringify({ origin, totp: seed })))
    const fromKeychain = resolve('OTP', { ...opts, origin })
    check('a keychain-only seed mints the current code', fromKeychain.state === 'ok' && fromKeychain.source === 'keychain' && fromKeychain.value === '081804')
    check('keychain-only seeds remain origin-bound', resolve('OTP', { ...opts, origin: 'https://other.example' }).state === 'refused')
    save({ SLOW_OTP: { origin, totp: seed } })
    Date.now = () => 59_000
    afterRead = () => { Date.now = () => 1_111_111_109_000 }
    const slow = resolve('SLOW_OTP', { ...opts, origin })
    check('a slow keychain migration mints the code after its read-back', slow.state === 'ok' && slow.value === '081804')
  } finally {
    Date.now = originalNow
  }
  for (const platform of ['linux', 'win32']) {
    Object.defineProperty(process, 'platform', { value: platform })
    save({ PORTABLE: 'file-floor' })
    const before = calls.length
    const portable = resolve('PORTABLE', opts)
    check(`${platform} keeps the existing file floor without spawning an OS keychain`, portable.state === 'ok' && portable.source === 'file' && hasEntry('PORTABLE') && calls.length === before)
  }
  Object.defineProperty(process, 'platform', originalPlatform)
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  process.env.MERCURY_BROWSER_PATH = process.execPath
  const originalHome = process.env.MERCURY_CONFIG_DIR
  process.env.MERCURY_CONFIG_DIR = scratch
  const session = await import(join(ROOT, 'src/services/browser/browserSession.ts'))
  const { processOwnerForLane } = await import(join(ROOT, 'src/services/run/resolveOwner.ts'))
  const { BrowserTool } = await import(join(ROOT, 'src/tools/BrowserTool/BrowserTool.ts'))
  const owner = processOwnerForLane('secrets-proof')
  const ctx = { agentId: 'secrets-proof' } as Parameters<typeof BrowserTool.call>[1]
  let liveOrigin = origin
  let driftOnFill = false
  let driftOnFocus = false
  let inputEvents = 0
  class FixtureInput {
    private current = ''
    tagName = 'INPUT'
    id = 'otp'
    name = 'otp'
    type = 'text'
    readOnly = false
    disabled = false
    isConnected = true
    selectionStart = null
    selectionEnd = null
    get value() { return this.current }
    set value(next: string) { this.current = next }
    getAttribute(name: string) { return name === 'autocomplete' ? 'one-time-code' : null }
    closest() { return null }
    contains(el: unknown) { return el === this }
    dispatchEvent() { inputEvents++; return true }
  }
  const field = new FixtureInput()
  let documentFocused = true
  const document = { activeElement: field, body: {}, hasFocus: () => documentFocused }
  const evaluate = (fn: Function, ...args: unknown[]) => runInNewContext(`(${fn.toString()})(...args)`, {
    args,
    document,
    location: { origin: liveOrigin },
    HTMLInputElement: FixtureInput,
    HTMLTextAreaElement: class {},
    InputEvent: class {},
  })
  const handle = {
    focus: async () => {
      document.activeElement = field
      if (driftOnFocus) { liveOrigin = 'https://other.example'; driftOnFocus = false }
    },
    evaluate: async (fn: Function, ...args: unknown[]) => {
      if (driftOnFill && fn.toString().includes('location.origin')) {
        liveOrigin = 'https://other.example'
        driftOnFill = false
      }
      return evaluate(fn, field, ...args)
    },
  }
  const locator = { setTimeout: () => locator, setVisibility: () => locator, waitHandle: async () => handle }
  const page = {
    url: () => `${liveOrigin}/login`,
    on: () => undefined,
    frames: () => [],
    locator: () => locator,
    evaluate: async (fn: Function, ...args: unknown[]) => evaluate(fn, ...args.map(arg => arg === handle ? field : arg)),
    viewport: () => ({ width: 1280, height: 800 }),
    close: async () => undefined,
  }
  session.setBrowserLaunchDriverForProof(async () => ({
    connected: true,
    process: () => null,
    pages: async () => [page],
    on: () => undefined,
    off: () => undefined,
    close: async () => undefined,
  }) as unknown as DriverBrowser)
  try {
    save({ BOUND_OTP: { origin, totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' } })
    const opened = await session.ensureBrowserSession(owner)
    check('the tool integration uses the owned session with a fixture driver', !('state' in opened))
    const input = { op: 'type', selector: '#otp', secretRef: 'BOUND_OTP' } as Parameters<typeof BrowserTool.call>[0]
    const ask = await BrowserTool.checkPermissions(input, ctx)
    check('TOTP keeps the existing secret pairing ask', ask.behavior === 'ask')
    const expected = resolve('BOUND_OTP', { origin })
    const result = (await BrowserTool.call(input, ctx)).data
    const after = resolve('BOUND_OTP', { origin })
    check('fold 46as: the focused document resolves the page origin and fills the code through the bound DOM write', result.outcome === 'succeeded' && [expected, after].some(code => code.state === 'ok' && code.value === field.value) && inputEvents === 1)
    check('the result contains neither the seed nor the minted code', field.value.length === 6 && !result.result.includes(field.value) && !result.result.includes('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'))
    field.value = ''
    documentFocused = false
    await BrowserTool.checkPermissions(input, ctx)
    const unfocused = (await BrowserTool.call(input, ctx)).data
    check('fold 46as: an inactive document refuses the bound fill even when its input is active', unfocused.outcome === 'failed' && unfocused.result.includes('focus did not land') && field.value === '' && inputEvents === 1)
    documentFocused = true
    driftOnFill = true
    await BrowserTool.checkPermissions(input, ctx)
    const drifted = (await BrowserTool.call(input, ctx)).data
    check('the final DOM write refuses origin drift even after resolution and focus checks', drifted.outcome === 'failed' && field.value === '' && inputEvents === 1)
    check('the refused write grants no secret pairing to the new origin', !session.secretPairingApproved(owner, 'BOUND_OTP', liveOrigin))
    session.approveSecretPairing(owner, 'BOUND_OTP', liveOrigin)
    await BrowserTool.checkPermissions(input, ctx)
    const wrong = (await BrowserTool.call(input, ctx)).data
    check('an explicit pairing grant cannot override the seed origin', wrong.outcome === 'failed' && field.value === '' && inputEvents === 1)
    save({ BOUND_OTP: { origin: 'https://other.example', totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' } })
    liveOrigin = origin
    driftOnFocus = true
    await BrowserTool.checkPermissions(input, ctx)
    const focusDrift = (await BrowserTool.call(input, ctx)).data
    check('navigation during target focus cannot borrow the earlier origin consent', focusDrift.outcome === 'failed' && field.value === '' && inputEvents === 1)
  } finally {
    await session.closeBrowserSession(owner)
    session.setBrowserLaunchDriverForProof(null)
    delete process.env.MERCURY_BROWSER_PATH
    if (originalHome === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = originalHome
  }
} finally {
  Object.defineProperty(process, 'platform', originalPlatform)
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  delete process.env.MERCURY_BROWSER_SECRET_CHILD_SENTINEL
  mock.restore()
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`${checks} checks, ${failures} failures`)
process.exitCode = failures === 0 ? 0 : 1
