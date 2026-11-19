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

type Family = { id: string; label: string; mod: string; pathFn: string; write: string; wrote: string; full: Record<string, unknown>; secret: string; aside: RegExp; store: string }
const FAMILIES: Family[] = [
  {
    id: 'gemini',
    label: 'Gemini',
    mod: 'services/providers/gemini/geminiAccounts.ts',
    pathFn: 'geminiAuthPathForDisplay',
    write: `m.writePreferredGeminiSource('api-key')`,
    wrote: `after.preferredSource === 'api-key'`,
    full: { version: 1, tokens: { accessToken: 'fixture-access-gemini', refreshToken: 'fixture-refresh-gemini' }, plan: { tokens: { accessToken: 'fixture-plan-access', refreshToken: 'fixture-plan-refresh' }, projectId: 'fixture-project' }, preferredSource: 'oauth' },
    secret: 'fixture-refresh-gemini',
    aside: /^\.gemini\.corrupt\.\d+-auth\.json$/,
    store: 'gemini-auth',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    mod: 'services/providers/huggingface/huggingfaceAccounts.ts',
    pathFn: 'huggingfaceAuthPathForDisplay',
    write: `m.writeHuggingfaceTokenIdentity('hf_fixturekey01', { username: 'fixture', observedAtMs: 1 })`,
    wrote: `after.tokenIdentity?.username === 'fixture'`,
    full: { version: 1, tokens: { accessToken: 'fixture-access-hf', refreshToken: 'fixture-refresh-hf' }, identity: { username: 'kept', observedAtMs: 1 } },
    secret: 'fixture-refresh-hf',
    aside: /^\.huggingface\.corrupt\.\d+-auth\.json$/,
    store: 'huggingface-auth',
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    mod: 'services/providers/moonshot/moonshotAccounts.ts',
    pathFn: 'moonshotAuthPathForDisplay',
    write: `m.writeMoonshotRegion('mainland-cn')`,
    wrote: `after.region === 'mainland-cn'`,
    full: { version: 1, tokens: { accessToken: 'fixture-access-kimi', refreshToken: 'fixture-refresh-kimi' }, region: 'global' },
    secret: 'fixture-refresh-kimi',
    aside: /^\.moonshot\.corrupt\.\d+-auth\.json$/,
    store: 'moonshot-auth',
  },
]

const FLOOR = `
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
`

function runIn(family: Family, body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'account-file-kept-')))
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
    const m = await import(${JSON.stringify(join(SRC, family.mod))})
    const recovery = await import(${JSON.stringify(join(SRC, 'substrate/storeRecovery.ts'))})
    const file = m.${family.pathFn}()
    const dir = path.dirname(file)
    const FULL = ${JSON.stringify(JSON.stringify(family.full, null, 2) + '\n')}
    const raw = f => { try { return fs.readFileSync(f, 'utf8') } catch (e) { return { err: e.code } } }
    const mode = f => { try { return fs.statSync(f).mode & 0o777 } catch { return null } }
    const asides = () => fs.readdirSync(dir).filter(n => n.includes('.corrupt.')).sort()
    const attempt = fn => { try { fn(); return null } catch (e) { return { code: e.code ?? null, message: String(e.message ?? e) } } }
    const parsed = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
    const write = () => { ${family.write} }
    const wrote = () => { const after = parsed(file) ?? {}; return ${family.wrote} }
    const out = { file }
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file' } })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1500)}`)
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
}
type Threw = { code: string | null; message: string } | null

for (const family of FAMILIES) {
  console.log(`\n${family.label} — an auth file that is there and cannot be read is not replaced`)
  if (!POSIX_MODES) skip('the unreadable file', 'a mode-0200 file needs a POSIX process that is not root')
  else {
    const r = runIn(family, `
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, FULL, { mode: 0o600 })
      fs.chmodSync(file, 0o200)
      out.threw = attempt(write)
      fs.chmodSync(file, 0o600)
      out.same = raw(file) === FULL
      out.asides = asides()
    `)
    const threw = r.threw as Threw
    const words = `The ${family.label} auth file at ${String(r.file)} exists but could not be read (EACCES); nothing was written. Make it readable, or move it away to start a new one, then try again.`
    check('the writer refuses', threw !== null, 'it returned as if it had written')
    check('the file stands byte for byte, its tokens with it', r.same === true, 'the file was replaced: its stored tokens are gone')
    check('the refusal says what could not be read, the code, that nothing was written and what to do', threw?.message === words, `said: ${threw?.message ?? '(nothing)'} — wanted: ${words}`)
    check('the refusal carries the errno code', threw?.code === 'EACCES', `code ${threw?.code}`)
    check('the refusal holds no token', threw !== null && !threw.message.includes(family.secret))
    check('nothing is kept aside for a file that was never read', (r.asides as string[]).length === 0, JSON.stringify(r.asides))
  }

  console.log(`${family.label} — an auth file that is not valid JSON is kept aside before the new one is written`)
  {
    const r = runIn(family, `
      ${FLOOR}
      fs.mkdirSync(dir, { recursive: true })
      const torn = FULL.slice(0, 60)
      fs.writeFileSync(file, torn, { mode: 0o600 })
      out.threw = attempt(write)
      out.asides = asides()
      const aside = out.asides.length === 1 ? path.join(dir, out.asides[0]) : null
      out.aside = aside
      out.asideHoldsTheBytes = aside !== null && raw(aside) === torn
      out.asideMode = aside === null ? null : mode(aside)
      out.wrote = wrote()
      out.events = await recovery.readStoreRecoveryEvents()
      out.floor = aside === null ? null : await floorOf(aside)
      out.floorOfTheFile = await floorOf(file)
    `)
    const asides = r.asides as string[]
    check('the write lands', r.threw === null && r.wrote === true, JSON.stringify(r.threw))
    check('exactly one copy is kept beside the file, under a name that ends in -auth.json', asides.length === 1 && family.aside.test(asides[0]!), `found ${JSON.stringify(asides)} — the old bytes are gone`)
    check('the copy holds the old bytes verbatim', r.asideHoldsTheBytes === true)
    if (POSIX_MODES) check('the copy is mode 0600', r.asideMode === 0o600, `mode ${(r.asideMode as number | null)?.toString(8)}`)
    const events = r.events as Array<{ store?: string; kind?: string; quarantinePath?: string | null; reason?: string }>
    const last = events.at(-1)
    check('the recovery ledger, which the Health Check prints, names the store, the reason and where the copy is', last !== undefined && last.store === family.store && last.reason === 'not valid JSON' && last.quarantinePath === r.aside && (last.kind ?? 'quarantine') === 'quarantine', JSON.stringify(last ?? null))
    const floor = r.floor as Record<string, { read: string; cat: string }> | null
    const fileFloor = r.floorOfTheFile as Record<string, { read: string; cat: string }>
    for (const mode of ['default', 'sovereign']) {
      check(`${mode}: the read floor that refuses the auth file refuses its kept-aside copy, by Read and by cat`, fileFloor[mode]?.read === 'deny' && fileFloor[mode]?.cat === 'deny' && floor?.[mode]?.read === 'deny' && floor?.[mode]?.cat === 'deny', `file ${JSON.stringify(fileFloor[mode])} · copy ${JSON.stringify(floor?.[mode] ?? null)}`)
    }
  }

  console.log(`${family.label} — a second file that cannot be used never clobbers the first copy, and JSON that is no object is kept aside too`)
  {
    const r = runIn(family, `
      fs.mkdirSync(dir, { recursive: true })
      const realNow = Date.now
      Date.now = () => 1763580000000
      fs.writeFileSync(file, 'first torn bytes {', { mode: 0o600 })
      out.first = attempt(write)
      fs.writeFileSync(file, '"a bare string"', { mode: 0o600 })
      out.second = attempt(write)
      fs.writeFileSync(file, '[1, 2]', { mode: 0o600 })
      out.third = attempt(write)
      Date.now = realNow
      out.asides = asides()
      out.held = out.asides.map(name => raw(path.join(dir, name))).sort()
      out.reasons = (await recovery.readStoreRecoveryEvents()).map(event => event.reason)
      out.wrote = wrote()
    `)
    check('with the clock held at one millisecond the three writes land and the three old files are kept, each under its own name', r.first === null && r.second === null && r.third === null && r.wrote === true && (r.asides as string[]).length === 3 && (r.asides as string[]).every(name => family.aside.test(name)) && JSON.stringify(r.held) === JSON.stringify(['"a bare string"', '[1, 2]', 'first torn bytes {']), `${JSON.stringify(r.asides)} holding ${JSON.stringify(r.held)}`)
    check('the ledger says why each was not used', JSON.stringify(r.reasons) === JSON.stringify(['not valid JSON', 'not a JSON object', 'not a JSON object']), JSON.stringify(r.reasons))
  }

  console.log(`${family.label} — a file that is not valid JSON and cannot be kept aside is not replaced`)
  if (!POSIX_MODES) skip('the copy that fails', 'a folder that takes no new file needs a POSIX process that is not root')
  else {
    const r = runIn(family, `
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, 'torn {', { mode: 0o600 })
      fs.chmodSync(dir, 0o500)
      out.threw = attempt(write)
      fs.chmodSync(dir, 0o700)
      out.same = raw(file) === 'torn {'
    `)
    const threw = r.threw as Threw
    const words = `The ${family.label} auth file at ${String(r.file)} is not valid JSON and could not be kept aside (EACCES); nothing was written. Move it away, then try again.`
    check('the writer refuses and the file stands', threw !== null && r.same === true, JSON.stringify(threw))
    check('the refusal says why nothing was written and what to do', threw?.message === words, `said: ${threw?.message ?? '(nothing)'} — wanted: ${words}`)
  }

  console.log(`${family.label} — controls: a file that is not there is a first write, and a file that reads keeps its other fields`)
  {
    const r = runIn(family, `
      out.absent = attempt(write)
      out.wroteAbsent = wrote()
      fs.writeFileSync(file, FULL, { mode: 0o600 })
      out.valid = attempt(write)
      out.wroteValid = wrote()
      out.kept = JSON.stringify(parsed(file) ?? {}).includes(${JSON.stringify(family.secret)})
      out.asides = asides()
      out.mode = mode(file)
    `)
    check('with no file the first write lands', r.absent === null && r.wroteAbsent === true, JSON.stringify(r.absent))
    check('with a file that reads the write lands and the stored tokens stay', r.valid === null && r.wroteValid === true && r.kept === true, JSON.stringify(r.valid))
    check('neither keeps anything aside', (r.asides as string[]).length === 0, JSON.stringify(r.asides))
    if (POSIX_MODES) check('the file is mode 0600', r.mode === 0o600, `mode ${(r.mode as number | null)?.toString(8)}`)
  }
}

console.log('\nMoonshot — the served-model note, whose caller drops the refusal, leaves an unreadable file as it stands')
if (!POSIX_MODES) skip('the dropped refusal', 'a mode-0200 file needs a POSIX process that is not root')
else {
  const family = FAMILIES[2]!
  const r = runIn(family, `
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, FULL, { mode: 0o600 })
    fs.chmodSync(file, 0o200)
    out.recorded = m.recordMoonshotServedModel('kimi-asked', 'kimi-served', { identity: 'fixture-identity' })
    fs.chmodSync(file, 0o600)
    out.same = raw(file) === FULL
  `)
  check('the note answers false and the file stands byte for byte', r.recorded === false && r.same === true, `answered ${JSON.stringify(r.recorded)}, file ${r.same === true ? 'kept' : 'replaced'}`)
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
