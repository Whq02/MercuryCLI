#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
const OLD_KEY = 'fixture-old-tensorfold-key-0123456789abcdef'
const OLD_LINE = `mercury[inference]: ${OLD_KEY}\n`

function runIn(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tensorfold-key-kept-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  for (const dir of [home, project]) mkdirSync(dir, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const fs = await import('node:fs')
    const path = await import('node:path')
    const keyFile = await import(${JSON.stringify(join(SRC, 'services/providers/local/tensorfoldKeyFile.ts'))})
    const recovery = await import(${JSON.stringify(join(SRC, 'substrate/storeRecovery.ts'))})
    const { getEmptyToolPermissionContext } = await import(${JSON.stringify(join(SRC, 'Tool.ts'))})
    const { decideToolPermission } = await import(${JSON.stringify(join(SRC, 'utils/permissions/decision/engine.ts'))})
    const { FileReadTool } = await import(${JSON.stringify(join(SRC, 'tools/FileReadTool/FileReadTool.ts'))})
    const { BashTool } = await import(${JSON.stringify(join(SRC, 'tools/BashTool/BashTool.tsx'))})
    const ctx = (mode, allow) => {
      const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, alwaysAllowRules: { userSettings: allow }, alwaysAskRules: { userSettings: [] } }, tasks: {}, sessionHooks: new Map() }
      return { getAppState: () => state, setAppState: () => {}, abortController: new AbortController(), readFileState: new Map(), messages: [], options: { tools: [] } }
    }
    const floorOf = async target => {
      const answers = {}
      for (const mode of ['default', 'sovereign']) {
        const read = (await decideToolPermission(FileReadTool, { file_path: target }, ctx(mode, ['Read']))).decision
        const cat = (await decideToolPermission(BashTool, { command: "cat '" + target + "'" }, ctx(mode, ['Bash']))).decision
        answers[mode] = { read: read.behavior, cat: cat.behavior }
      }
      return answers
    }
    const home = ${JSON.stringify(home)}
    const file = keyFile.tensorFoldKeyFilePath()
    const dir = path.dirname(file)
    const OLD = ${JSON.stringify(OLD_LINE)}
    const raw = f => { try { return fs.readFileSync(f, 'utf8') } catch (e) { return { err: e.code } } }
    const mode = f => { try { return fs.statSync(f).mode & 0o777 } catch { return null } }
    const copies = () => [...fs.readdirSync(home).map(n => path.join(home, n)), ...fs.readdirSync(dir).map(n => path.join(dir, n))].filter(p => p.includes('.corrupt.')).sort()
    const attempt = fn => { try { return { answered: fn() } } catch (e) { return { threw: { code: e.code ?? null, message: String(e.message ?? e) } } } }
    const out = { file, home }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file' } })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1500)}`)
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
}
type Attempt = { answered?: { path: string; key: string; line: string }; threw?: { code: string | null; message: string } }
type Floor = Record<string, { read: string; cat: string }> | null
type Event = { store?: string; kind?: string; quarantinePath?: string | null; reason?: string }
const COPY = /[\\/]\.tensorfold-key\.corrupt\.\d+-auth\.json$/
const WIN32_MINTS_OVER = 'on win32 every file reads as open to other users, so the key is minted over the old file and no copy is kept'

console.log('the TensorFold key file — there and unreadable: no new key is minted over it')
if (!POSIX_MODES) skip('the unreadable key file', 'a mode-0200 file needs a POSIX process that is not root')
else {
  const r = runIn(`
    fs.writeFileSync(file, OLD, { mode: 0o600 })
    fs.chmodSync(file, 0o200)
    out.share = attempt(() => keyFile.writeTensorFoldKeyFile())
    fs.chmodSync(file, 0o600)
    out.same = raw(file) === OLD
    out.copies = copies()
  `)
  const share = r.share as Attempt
  const words = `The TensorFold key file at ${String(r.file)} exists but could not be read (EACCES); nothing was written. Make it readable, or move it away to mint a new key, then share again.`
  check('the share refuses and the key file stands byte for byte', share.threw !== undefined && r.same === true, share.threw === undefined ? `a new key was minted over it (${share.answered?.key.slice(0, 8)}…): the clients paired with the old one lose it` : JSON.stringify(share.threw))
  check('the refusal says what could not be read, the code, that nothing was written and what to do', share.threw?.message === words && share.threw.code === 'EACCES', `said: ${share.threw?.message ?? '(nothing)'} — wanted: ${words}`)
  check('the refusal holds no key and nothing is kept aside', share.threw !== undefined && !share.threw.message.includes(OLD_KEY) && (r.copies as string[]).length === 0)
}

for (const [title, fixture, fixtureMode, reason] of [
  ['a key file other users can read', OLD_LINE, 0o644, 'can be read by other users'],
  ['a key file whose key line is commented out', `# ${OLD_LINE}`, 0o600, 'holds no key'],
  ['a key file with a space in its key', `mercury[inference]: ${OLD_KEY.slice(0, 20)} ${OLD_KEY.slice(20)}\n`, 0o600, 'holds no key'],
] as const) {
  console.log(`the TensorFold key file — ${title}: the old file is kept aside before a new key is minted`)
  if (fixtureMode !== 0o600 && !POSIX_MODES) {
    skip(title, 'file modes are a POSIX fact')
    continue
  }
  const r = runIn(`
    const FIXTURE = ${JSON.stringify(fixture)}
    fs.writeFileSync(file, FIXTURE, { mode: 0o600 })
    fs.chmodSync(file, ${fixtureMode})
    out.share = attempt(() => keyFile.writeTensorFoldKeyFile())
    out.copies = copies()
    const copy = out.copies.length === 1 ? out.copies[0] : null
    out.copyHoldsTheBytes = copy !== null && raw(copy) === FIXTURE
    out.copyMode = copy === null ? null : mode(copy)
    out.fileNow = raw(file)
    out.fileMode = mode(file)
    out.events = await recovery.readStoreRecoveryEvents()
    out.floor = copy === null ? null : await floorOf(copy)
    out.floorOfTheKeyFile = await floorOf(file)
  `)
  const share = r.share as Attempt
  const copies = r.copies as string[]
  check('a new key is minted and written, mode 0600', share.answered !== undefined && share.answered.key !== OLD_KEY && r.fileNow === `${share.answered.line}\n` && (!POSIX_MODES || r.fileMode === 0o600), JSON.stringify(share))
  if (process.platform === 'win32') {
    skip('the copy kept aside, its row in the recovery ledger and its read floor', WIN32_MINTS_OVER)
    continue
  }
  check('one copy of the old file is kept in the Mercury home, under a name the read floors cover, holding its bytes, mode 0600', copies.length === 1 && COPY.test(copies[0]!) && ['/', '\\'].some(separator => copies[0]!.startsWith(`${String(r.home)}${separator}`)) && r.copyHoldsTheBytes === true && (!POSIX_MODES || r.copyMode === 0o600), `${JSON.stringify(copies)} — the old key is on disk nowhere`)
  const last = (r.events as Event[]).at(-1)
  check('the recovery ledger, which the Health Check prints, names the store, the reason and where the copy is', last !== undefined && last.store === 'tensorfold-key' && last.reason === reason && last.quarantinePath === copies[0] && (last.kind ?? 'quarantine') === 'quarantine', JSON.stringify(last ?? null))
  const floor = r.floor as Floor
  for (const mode of ['default', 'sovereign']) check(`${mode}: the read floor refuses the kept-aside copy, by Read and by cat`, floor?.[mode]?.read === 'deny' && floor?.[mode]?.cat === 'deny', JSON.stringify(floor?.[mode] ?? null))
  console.log(`  [INFO] the key file itself, by the same floor: ${JSON.stringify(r.floorOfTheKeyFile)}`)
}

console.log('the TensorFold key file — a file that cannot be used and cannot be kept aside is not replaced')
if (!POSIX_MODES) skip('the copy that fails', 'a folder that takes no new file needs a POSIX process that is not root')
else {
  const r = runIn(`
    fs.writeFileSync(file, OLD, { mode: 0o600 })
    fs.chmodSync(file, 0o644)
    fs.chmodSync(home, 0o500)
    out.share = attempt(() => keyFile.writeTensorFoldKeyFile())
    fs.chmodSync(home, 0o700)
    out.same = raw(file) === OLD && mode(file) === 0o644
  `)
  const share = r.share as Attempt
  const words = `The TensorFold key file at ${String(r.file)} can be read by other users and could not be kept aside (EACCES); nothing was written. Move it away, then share again.`
  check('the share refuses and the key file stands', share.threw !== undefined && r.same === true, share.threw === undefined ? 'a new key was minted over it with no copy' : JSON.stringify(share.threw))
  check('the refusal says why nothing was written and what to do, and carries the code', share.threw?.message === words && share.threw.code === 'EACCES', `said: ${share.threw?.message ?? '(nothing)'} — wanted: ${words}`)
}

console.log('the TensorFold key file — controls: no file mints a key, a private file with a key keeps it, a key handed in is written')
{
  const r = runIn(`
    out.first = attempt(() => keyFile.writeTensorFoldKeyFile())
    out.again = attempt(() => keyFile.writeTensorFoldKeyFile())
    out.read = keyFile.readTensorFoldKeyFile()
    out.given = attempt(() => keyFile.writeTensorFoldKeyFile({ key: 'fixture-key-handed-in' }))
    out.copies = copies()
    out.mode = mode(file)
  `)
  const first = r.first as Attempt
  const again = r.again as Attempt
  check('with no file a key is minted', first.answered !== undefined && first.answered.key.length >= 32, JSON.stringify(first))
  if (process.platform === 'win32') skip('a second share keeps that key', WIN32_MINTS_OVER)
  else check('a second share keeps that key', again.answered?.key === first.answered?.key && (r.read as { key?: string } | null)?.key === first.answered?.key, JSON.stringify(again))
  check('a key handed in is written as it is, and nothing is kept aside', (r.given as Attempt).answered?.key === 'fixture-key-handed-in' && (r.copies as string[]).length === 0, JSON.stringify(r.given))
  if (POSIX_MODES) check('the key file is mode 0600', r.mode === 0o600, `mode ${(r.mode as number | null)?.toString(8)}`)
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
