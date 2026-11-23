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
    mod: 'models/roads/gemini/geminiAccounts.ts',
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
    mod: 'models/roads/huggingface/huggingfaceAccounts.ts',
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
    mod: 'models/roads/moonshot/moonshotAccounts.ts',
    pathFn: 'moonshotAuthPathForDisplay',
    write: `m.writeMoonshotRegion('mainland-cn')`,
    wrote: `after.region === 'mainland-cn'`,
    full: { version: 1, tokens: { accessToken: 'fixture-access-kimi', refreshToken: 'fixture-refresh-kimi' }, region: 'global' },
    secret: 'fixture-refresh-kimi',
    aside: /^\.moonshot\.corrupt\.\d+-auth\.json$/,
    store: 'moonshot-auth',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    mod: 'models/roads/openai/openaiAccounts.ts',
    pathFn: 'openaiAuthPathForDisplay',
    write: `m.writePreferredOpenaiSource('api-key')`,
    wrote: `after.preferredSource === 'api-key'`,
    full: { version: 1, tokens: { idToken: '', accessToken: 'fixture-access-openai', refreshToken: 'fixture-refresh-openai', accountId: 'acct_fixture', planType: 'plus' }, preferredSource: 'chatgpt-subscription' },
    secret: 'fixture-refresh-openai',
    aside: /^\.openai\.corrupt\.\d+-auth\.json$/,
    store: 'openai-auth',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    mod: 'models/roads/openrouter/openrouterAccounts.ts',
    pathFn: 'openrouterAuthPathForDisplay',
    write: `m.disconnectOpenrouterOauthKey()`,
    wrote: `after.version === 1 && after.minted === undefined`,
    full: { version: 1, minted: { key: 'sk-or-fixture-minted-key', mintedAtMs: 1, label: 'Mercury' }, refused: { fingerprint: 'fixture-refusal-mark', source: 'stored', status: 401, message: 'kept', observedAtMs: 1 } },
    secret: 'fixture-refusal-mark',
    aside: /^\.openrouter\.corrupt\.\d+-auth\.json$/,
    store: 'openrouter-auth',
  },
  {
    id: 'xai',
    label: 'xAI',
    mod: 'models/roads/xai/xaiOauth.ts',
    pathFn: 'xaiAuthPathForDisplay',
    write: `m.writePreferredXaiSource('api-key')`,
    wrote: `after.preferredSource === 'api-key'`,
    full: { version: 1, tokens: { accessToken: 'fixture-access-xai', refreshToken: 'fixture-refresh-xai' }, preferredSource: 'grok-subscription' },
    secret: 'fixture-refresh-xai',
    aside: /^\.xai\.corrupt\.\d+-auth\.json$/,
    store: 'xai-auth',
  },
  {
    id: 'nous',
    label: 'Nous',
    mod: 'models/roads/nous/nousOauth.ts',
    pathFn: 'nousAuthPathForDisplay',
    write: `m.writePreferredNousSource('api-key')`,
    wrote: `after.preferredSource === 'api-key'`,
    full: { version: 1, tokens: { accessToken: 'fixture-access-nous', refreshToken: 'fixture-refresh-nous' }, preferredSource: 'signin' },
    secret: 'fixture-refresh-nous',
    aside: /^\.nous\.corrupt\.\d+-auth\.json$/,
    store: 'nous-auth',
  },
]

const FLOOR = `
    const { floorOf } = await import(${JSON.stringify(join(HERE, '../lib/permissionFloor.ts'))})
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
    const recovery = await import(${JSON.stringify(join(SRC, 'platform/substrate/storeRecovery.ts'))})
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
    check('the writer refuses', threw !== null, `it returned as if it had written · the ${family.label} writer in src/${family.mod} must throw when the auth file exists but cannot be read, never write over it`)
    check('the file stands byte for byte, its tokens with it', r.same === true, `the file was replaced: its stored tokens are gone · the ${family.label} writer in src/${family.mod} must leave an unreadable file untouched`)
    check('the refusal says what could not be read, the code, that nothing was written and what to do', threw?.message === words, `said: ${threw?.message ?? '(nothing)'} — wanted: ${words} · change the refusal text of the ${family.label} writer in src/${family.mod} (or the store-read helper it calls) to match`)
    check('the refusal carries the errno code', threw?.code === 'EACCES', `code ${threw?.code} · the refusal thrown by the ${family.label} writer in src/${family.mod} must keep the errno code EACCES`)
    check('the refusal holds no token', threw !== null && !threw.message.includes(family.secret), `the refusal thrown by the ${family.label} writer in src/${family.mod} must not include file contents`)
    check('nothing is kept aside for a file that was never read', (r.asides as string[]).length === 0, `${JSON.stringify(r.asides)} · the ${family.label} writer in src/${family.mod} must keep a copy aside only for a file it read and found not valid`)
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
    check('the write lands', r.threw === null && r.wrote === true, `${JSON.stringify(r.threw)} · the ${family.label} writer in src/${family.mod} must keep the torn file aside and then write the new one`)
    check('exactly one copy is kept beside the file, under a name that ends in -auth.json', asides.length === 1 && family.aside.test(asides[0]!), `found ${JSON.stringify(asides)} — the old bytes are gone · the keep-aside step of the ${family.label} writer in src/${family.mod} (see src/platform/substrate/storeRecovery.ts) must leave exactly one copy named like .${family.id}.corrupt.<time>-auth.json`)
    check('the copy holds the old bytes verbatim', r.asideHoldsTheBytes === true, `the keep-aside step of the ${family.label} writer in src/${family.mod} must copy the old file byte for byte`)
    if (POSIX_MODES) check('the copy is mode 0600', r.asideMode === 0o600, `mode ${(r.asideMode as number | null)?.toString(8)} · the kept-aside copy of the ${family.label} writer in src/${family.mod} must be created with mode 0600`)
    const events = r.events as Array<{ store?: string; kind?: string; quarantinePath?: string | null; reason?: string }>
    const last = events.at(-1)
    check('the recovery ledger, which the Health Check prints, names the store, the reason and where the copy is', last !== undefined && last.store === family.store && last.reason === 'not valid JSON' && last.quarantinePath === r.aside && (last.kind ?? 'quarantine') === 'quarantine', `${JSON.stringify(last ?? null)} · the keep-aside step of the ${family.label} writer in src/${family.mod} must record an event in src/platform/substrate/storeRecovery.ts with store ${family.store}, reason not valid JSON and the copy path`)
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
      out.keys = Object.keys(parsed(file) ?? {})
    `)
    check('with the clock held at one millisecond the three writes land and the three old files are kept, each under its own name', r.first === null && r.second === null && r.third === null && r.wrote === true && (r.asides as string[]).length === 3 && (r.asides as string[]).every(name => family.aside.test(name)) && JSON.stringify(r.held) === JSON.stringify(['"a bare string"', '[1, 2]', 'first torn bytes {']), `${JSON.stringify(r.asides)} holding ${JSON.stringify(r.held)} · the keep-aside step of the ${family.label} writer in src/${family.mod} must give each copy its own name even within one millisecond`)
    check('the ledger says why each was not used', JSON.stringify(r.reasons) === JSON.stringify(['not valid JSON', 'not a JSON object', 'not a JSON object']), JSON.stringify(r.reasons))
    check('no item of the list that stood in the file is carried into the new one', !(r.keys as string[]).some(key => /^\d+$/.test(key)), JSON.stringify(r.keys))
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
    check('the writer refuses and the file stands', threw !== null && r.same === true, `${JSON.stringify(threw)} · the ${family.label} writer in src/${family.mod} must refuse and leave the file as it is when the copy cannot be kept aside`)
    check('the refusal says why nothing was written and what to do', threw?.message === words, `said: ${threw?.message ?? '(nothing)'} — wanted: ${words} · change the could-not-be-kept-aside refusal text of the ${family.label} writer in src/${family.mod} to match`)
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
    check('with no file the first write lands', r.absent === null && r.wroteAbsent === true, `${JSON.stringify(r.absent)} · the ${family.label} writer in src/${family.mod} must write a new file when none exists`)
    check('with a file that reads the write lands and the stored tokens stay', r.valid === null && r.wroteValid === true && r.kept === true, `${JSON.stringify(r.valid)} · the ${family.label} writer in src/${family.mod} must keep the stored tokens when it rewrites a file that reads`)
    check('neither keeps anything aside', (r.asides as string[]).length === 0, JSON.stringify(r.asides))
    if (POSIX_MODES) check('the file is mode 0600', r.mode === 0o600, `mode ${(r.mode as number | null)?.toString(8)}`)
  }
}

console.log('\nthe sign-out of a slot and the choice of the active source — the refusal reaches the screen as the note, and the file stands')
if (!POSIX_MODES) skip('the refused sign-out', 'a mode-0200 file needs a POSIX process that is not root')
else {
  for (const [family, route] of [[FAMILIES[0]!, 'gemini-oauth'], [FAMILIES[1]!, 'huggingface-oauth'], [FAMILIES[2]!, 'moonshot-oauth']] as const) {
    const r = runIn(family, `
      const removal = await import(${JSON.stringify(join(SRC, 'models/roads/account-slots/removal.ts'))})
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, FULL, { mode: 0o600 })
      fs.chmodSync(file, 0o200)
      out.outcome = attempt(() => { out.answered = removal.executeSlotRemoval({ id: 'fixture-slot', family: ${JSON.stringify(family.id)}, kind: 'oauth', removal: { route: ${JSON.stringify(route)} } }) })
      fs.chmodSync(file, 0o600)
      out.same = raw(file) === FULL
    `)
    const answered = r.answered as { note?: string; mutated?: boolean; refused?: boolean } | undefined
    const words = `Could not sign out: The ${family.label} auth file at ${String(r.file)} exists but could not be read (EACCES); nothing was written. Make it readable, or move it away to start a new one, then try again.`
    check(`${family.label}: the sign-out answers a note that says why, changes nothing and says it was refused`, r.outcome === null && answered?.note === words && answered.mutated === false && answered.refused === true && r.same === true, `${JSON.stringify(r.outcome ?? answered)} · file ${r.same === true ? 'kept' : 'replaced'} · executeSlotRemoval in src/models/roads/account-slots/removal.ts must turn the store refusal into a refused note and change nothing`)
  }
  const gemini = FAMILIES[0]!
  const fault = runIn(gemini, `
    const removal = await import(${JSON.stringify(join(SRC, 'models/roads/account-slots/removal.ts'))})
    out.threw = attempt(() => removal.executeSlotRemoval({ id: 'fixture-slot', family: 'gemini', kind: 'oauth', removal: { route: 'gemini-oauth' } }, { disconnectGeminiOauth: () => { throw new TypeError('a fault of the code, not a refusal') } }))
  `)
  check('a throw that is not a refusal of the store still leaves the sign-out as a throw, as before', (fault.threw as Threw)?.message === 'a fault of the code, not a refusal', `${JSON.stringify(fault.threw)} · executeSlotRemoval in src/models/roads/account-slots/removal.ts must turn only store refusals into notes and rethrow any other error`)
  const r = runIn(gemini, `
    const login = await import(${JSON.stringify(join(SRC, 'models/roads/gemini/geminiLogin.ts'))})
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, FULL, { mode: 0o600 })
    fs.chmodSync(file, 0o200)
    out.outcome = attempt(() => { out.answered = login.activateGeminiSource('api-key') })
    fs.chmodSync(file, 0o600)
    out.same = raw(file) === FULL
  `)
  const answered = r.answered as { ok?: boolean; receipt?: string } | undefined
  check('Gemini: making a source active answers a receipt that says why and is not ok', r.outcome === null && answered?.ok === false && answered.receipt === `Could not make it the active source: The Gemini auth file at ${String(r.file)} exists but could not be read (EACCES); nothing was written. Make it readable, or move it away to start a new one, then try again.` && r.same === true, `${JSON.stringify(r.outcome ?? answered)} · file ${r.same === true ? 'kept' : 'replaced'} · activateGeminiSource in src/models/roads/gemini/geminiLogin.ts must answer ok false with the refusal as its receipt and leave the file alone`)
}

console.log('\nan auth file that reads and takes no write — the sign-out says which file could not be written, on each road, and nothing is thrown')
if (process.platform !== 'darwin' || !POSIX_MODES) skip('the write that fails', 'a file that takes no rename is made here with the immutable flag of macOS')
else {
  for (const [family, route] of [[FAMILIES[0]!, 'gemini-oauth'], [FAMILIES[1]!, 'huggingface-oauth'], [FAMILIES[2]!, 'moonshot-oauth']] as const) {
    const r = runIn(family, `
      const removal = await import(${JSON.stringify(join(SRC, 'models/roads/account-slots/removal.ts'))})
      const cli = await import(${JSON.stringify(join(SRC, 'commands/verbs/providerAuth.ts'))})
      const child = await import('node:child_process')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, FULL, { mode: 0o600 })
      child.spawnSync('/usr/bin/chflags', ['uchg', file])
      out.slot = attempt(() => { out.answered = removal.executeSlotRemoval({ id: 'fixture-slot', family: ${JSON.stringify(family.id)}, kind: 'oauth', removal: { route: ${JSON.stringify(route)} } }) })
      const said = { out: '', err: '', exit: null }
      out.verbThrew = await cli.providerAuthLogout(${JSON.stringify(family.id)}, { writeOut: text => { said.out += text }, writeErr: text => { said.err += text }, exit: code => { said.exit = code } }).then(() => null, error => String(error.message ?? error))
      out.said = said
      out.every = attempt(() => { out.everyAnswered = removal.signOutEveryEngineCredential() })
      child.spawnSync('/usr/bin/chflags', ['nouchg', file])
      out.same = raw(file) === FULL
    `)
    const words = `Could not sign out: The ${family.label} auth file at ${String(r.file)} could not be written (EPERM); nothing was written. Close what holds the file, then try again.`
    const answered = r.answered as { note?: string; mutated?: boolean; refused?: boolean } | undefined
    const said = r.said as { out: string; err: string; exit: number | null }
    check(`${family.label}: the sign-out of the slot answers the note, refused, and throws nothing`, r.slot === null && answered?.note === words && answered.mutated === false && answered.refused === true, `${JSON.stringify(r.slot ?? answered)} · executeSlotRemoval in src/models/roads/account-slots/removal.ts must answer a refused note when the file cannot be written`)
    check(`${family.label}: the sign-out of the family says it on the error stream and exits 1`, r.verbThrew === null && said.err === `${words}\n` && said.out === '' && said.exit === 1, `${JSON.stringify({ threw: r.verbThrew, said })} · providerAuthLogout in src/commands/verbs/providerAuth.ts must write the refusal to the error stream and exit 1`)
    check(`${family.label}: the sign-out of every provider answers it once, and the file stands byte for byte`, r.every === null && JSON.stringify(r.everyAnswered) === JSON.stringify([words]) && r.same === true, `${JSON.stringify(r.every ?? r.everyAnswered)} · file ${r.same === true ? 'kept' : 'changed'} · signOutEveryEngineCredential in src/models/roads/account-slots/removal.ts must answer the refusal once and leave the file alone`)
  }
  const marked = runIn(FAMILIES[4]!, `
    const child = await import('node:child_process')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, FULL, { mode: 0o600 })
    child.spawnSync('/usr/bin/chflags', ['uchg', file])
    out.threw = attempt(() => m.markOpenrouterKeyRefused({ key: 'sk-or-fixture-refused', source: 'stored' }, 401, 'refused by the fixture'))
    child.spawnSync('/usr/bin/chflags', ['nouchg', file])
    out.same = raw(file) === FULL
  `)
  check('OpenRouter: the mark of a refused key throws nothing when its file takes no write, so a turn still shows OpenRouter\'s own refusal', marked.threw === null && marked.same === true, `${JSON.stringify(marked.threw)} · markOpenrouterKeyRefused in src/models/roads/openrouter/openrouterAccounts.ts must catch a write failure instead of throwing`)
}

console.log('\nthe terminal sign-out of one family — a file that cannot be read is named with exit 1, and a file that is not valid JSON is kept aside')
if (!POSIX_MODES) skip('the refused terminal sign-out', 'a mode-0200 file needs a POSIX process that is not root')
else {
  for (const family of FAMILIES) {
    const full = JSON.stringify(family.full, null, 2) + '\n'
    const broken = full.slice(0, -9)
    const signOut = (prepare: string): Record<string, unknown> => runIn(family, `
      const cli = await import(${JSON.stringify(join(SRC, 'commands/verbs/providerAuth.ts'))})
      const said = { out: '', err: '', exit: null }
      fs.mkdirSync(dir, { recursive: true })
      ${prepare}
      await cli.providerAuthLogout(${JSON.stringify(family.id)}, { writeOut: text => { said.out += text }, writeErr: text => { said.err += text }, exit: code => { said.exit = code } })
      fs.chmodSync(file, 0o600)
      out.said = said
      out.now = raw(file)
      out.kept = asides().map(name => raw(path.join(dir, name)))
      out.copies = asides().map(name => path.join(dir, name))
    `)
    const unread = signOut(`fs.writeFileSync(file, FULL, { mode: 0o600 }); fs.chmodSync(file, 0o200)`)
    const said = unread.said as { out: string; err: string; exit: number | null }
    const words = `Could not sign out: The ${family.label} auth file at ${String(unread.file)} exists but could not be read (EACCES); nothing was written. Make it readable, or move it away to start a new one, then try again.`
    check(`${family.label}: the sign-out of the family names the file it could not read on the error stream and exits 1, and the file stands`, said.err === `${words}\n` && said.out === '' && said.exit === 1 && unread.now === full, `${JSON.stringify(said)} · file ${unread.now === full ? 'kept' : 'replaced'} · providerAuthLogout in src/commands/verbs/providerAuth.ts must print the refusal on the error stream, exit 1 and leave the file alone`)
    const unusable = signOut(`fs.writeFileSync(file, ${JSON.stringify(broken)}, { mode: 0o600 })`)
    const kept = unusable.kept as unknown[]
    check(`${family.label}: a file that is not valid JSON is kept aside by the sign-out of the family, every byte`, kept.length === 1 && kept[0] === broken && typeof unusable.now === 'string' && !unusable.now.includes(family.secret), `${kept.length} kept aside · ${JSON.stringify(unusable.said)} · providerAuthLogout in src/commands/verbs/providerAuth.ts must keep the invalid file aside byte for byte and then remove the credential`)
    const told = unusable.said as { out: string; err: string; exit: number | null }
    check(`${family.label}: …and the sign-out says so with exit 0: what the file was, where the copy is, and that no credential could be read from it`, told.out === `The ${family.label} auth file at ${String(unusable.file)} was not valid JSON and is kept aside at ${String((unusable.copies as string[])[0])}; no credential could be read from it.\n` && told.err === '' && told.exit === 0, `${JSON.stringify(told)} · change the kept-aside message printed by providerAuthLogout in src/commands/verbs/providerAuth.ts to match`)
  }
}

console.log('\na key sign-in that the auth file refuses — nothing of it is stored, so the receipt is true')
if (!POSIX_MODES) skip('the refused key sign-in', 'a mode-0200 file needs a POSIX process that is not root')
else {
  for (const [family, module, call, field, said] of [
    [FAMILIES[0]!, 'models/roads/gemini/geminiLogin.ts', `login.storeGeminiApiKeyLogin('fixture-new-gemini-key-0123', { refreshCatalogue: async () => null })`, 'geminiApiKey', 'Could not store the key: '],
    [FAMILIES[1]!, 'models/roads/huggingface/huggingfaceLogin.ts', `login.storeHuggingfaceTokenLogin('hf_fixturenewtoken0123', { fetchImpl: async () => new Response(JSON.stringify({ name: 'fixture' }), { status: 200, headers: { 'content-type': 'application/json' } }) }, async () => null)`, 'huggingfaceApiKey', 'Could not store the token: '],
    [FAMILIES[5]!, 'models/roads/xai/xaiLogin.ts', `login.storeXaiApiKeyLogin('fixture-new-xai-key-0123', { fetchImpl: async () => { throw new Error('the fixture has no network') }, env: {} })`, 'xaiApiKey', 'Could not store the key: '],
    [FAMILIES[6]!, 'models/roads/nous/nousLogin.ts', `login.storeNousApiKeyLogin('fixture-new-nous-key-0123', { fetchImpl: async () => { throw new Error('the fixture has no network') }, env: {} })`, 'nousApiKey', 'Could not store the key: '],
  ] as const) {
    const r = runIn(family, `
      const login = await import(${JSON.stringify(join(SRC, module))})
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, FULL, { mode: 0o600 })
      fs.chmodSync(file, 0o200)
      out.outcome = await ${call}
      fs.chmodSync(file, 0o600)
      out.same = raw(file) === FULL
      out.storedKey = (parsed(path.join(dir, '.provider-secrets.json')) ?? {})[${JSON.stringify(field)}] ?? null
      out.ledger = Object.keys((parsed(path.join(dir, '.sign-ins.json')) ?? {}).signIns ?? {})
    `)
    const outcome = r.outcome as { ok?: boolean; stored?: boolean; receipt?: string } | undefined
    const words = `${said}The ${family.label} auth file at ${String(r.file)} exists but could not be read (EACCES); nothing was written. Make it readable, or move it away to start a new one, then try again.`
    check(`${family.label}: the sign-in is refused in the receipt's words, and the auth file stands`, outcome?.ok === false && outcome.stored === false && outcome.receipt === words && r.same === true, `${JSON.stringify(outcome)} · the key sign-in in src/${module} must return ok false, stored false and the refusal as its receipt, and leave the auth file alone`)
    check(`${family.label}: the key is not in the secrets store and the sign-in ledger records no sign-in`, r.storedKey === null && (r.ledger as string[]).length === 0, `the secrets store holds the key (${JSON.stringify(r.storedKey)}) and the ledger records ${JSON.stringify(r.ledger)}: "nothing was written" is not true · the key sign-in in src/${module} must write the key and the ledger entry only after the auth file write succeeds, or undo them`)
    const other = runIn(family, `
      const login = await import(${JSON.stringify(join(SRC, module))})
      fs.mkdirSync(dir, { recursive: true })
      const WITH = JSON.stringify({ ...JSON.parse(FULL), tokenIdentity: { username: 'kept', observedAtMs: 1, keyTail: 'ab12' } }, null, 2) + '\\n'
      fs.writeFileSync(file, WITH, { mode: 0o600 })
      const secrets = path.join(dir, '.provider-secrets.json')
      const SECRETS = JSON.stringify({ version: 1, zaiApiKey: 'fixture-other-key' })
      fs.writeFileSync(secrets, SECRETS, { mode: 0o600 })
      fs.chmodSync(secrets, 0o200)
      out.outcome = await ${call}
      fs.chmodSync(secrets, 0o600)
      out.secretsSame = raw(secrets) === SECRETS
      out.before = JSON.parse(WITH)
      out.after = parsed(file)
      out.byteSame = raw(file) === WITH
      out.ledger = Object.keys((parsed(path.join(dir, '.sign-ins.json')) ?? {}).signIns ?? {})
      fs.unlinkSync(file)
      fs.chmodSync(secrets, 0o200)
      out.again = await ${call}
      fs.chmodSync(secrets, 0o600)
      out.madeAFile = fs.existsSync(file)
    `)
    const refusedBySecrets = other.outcome as { ok?: boolean; stored?: boolean; receipt?: string } | undefined
    check(`${family.label}: refused by the secrets store instead, the sign-in leaves the auth file's fields as they were and records nothing`, refusedBySecrets?.ok === false && refusedBySecrets.stored === false && (refusedBySecrets.receipt ?? '').startsWith(`${said}The provider secrets store at `) && other.secretsSame === true && JSON.stringify(other.after) === JSON.stringify(other.before) && (other.ledger as string[]).length === 0, `${JSON.stringify({ outcome: refusedBySecrets, after: other.after, ledger: other.ledger })} · the key sign-in in src/${module} must refuse and restore the auth file fields when the secrets store cannot be written`)
    check(`${family.label}: …the auth file is byte for byte what it was, the identity kept for another token with it`, other.byteSame === true, `${JSON.stringify(other.after)} · the key sign-in in src/${module} must restore the auth file byte for byte when the secrets store refuses`)
    check(`${family.label}: …and where there was no auth file, the refused sign-in leaves none`, (other.again as { ok?: boolean } | undefined)?.ok === false && other.madeAFile === false, `a refused sign-in left an auth file where there was none (${JSON.stringify(other.again)}) · the key sign-in in src/${module} must remove the auth file it created when the secrets store refuses`)
  }
}

console.log('\na Gemini key that Google refuses — nothing of it stays: no key, and no sign-in in the ledger')
{
  const r = runIn(FAMILIES[0]!, `
    const login = await import(${JSON.stringify(join(SRC, 'models/roads/gemini/geminiLogin.ts'))})
    out.outcome = await login.storeGeminiApiKeyLogin('fixture-key-google-refuses', { refreshCatalogue: async () => ({ models: [], lastError: 'Google refused the credential', lastStatus: 400, lastSaid: 'API key not valid' }) })
    out.ledger = Object.keys((parsed(path.join(dir, '.sign-ins.json')) ?? {}).signIns ?? {})
    out.storedKey = (parsed(path.join(dir, '.provider-secrets.json')) ?? {}).geminiApiKey ?? null
    out.madeAFile = fs.existsSync(file)
  `)
  const outcome = r.outcome as { ok?: boolean; stored?: boolean; receipt?: string } | undefined
  check('the sign-in answers that Google refused the key, stores no key and leaves no sign-in of it in the ledger', outcome?.ok === false && outcome.stored === false && (outcome.receipt ?? '').startsWith('Google refused this key') && r.storedKey === null && (r.ledger as string[]).length === 0, `${JSON.stringify({ outcome, ledger: r.ledger, storedKey: r.storedKey })} · storeGeminiApiKeyLogin in src/models/roads/gemini/geminiLogin.ts must store nothing and record no sign-in when Google refuses the key`)
  check('…and where there was no auth file, the refused key leaves none', r.madeAFile === false, 'an auth file was left where there was none')
  if (process.platform !== 'darwin' || !POSIX_MODES) skip('the restore that cannot be written', 'a file that takes no rename is made here with the immutable flag of macOS')
  else {
    const held = runIn(FAMILIES[0]!, `
      const ps = await import(${JSON.stringify(join(SRC, 'models/sign-in/account-ledger/providerSecrets.ts'))})
      const child = await import('node:child_process')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, FULL, { mode: 0o600 })
      const restore = ps.credentialFileRestorer(file)
      child.spawnSync('/usr/bin/chflags', ['uchg', file])
      out.threw = attempt(restore)
      child.spawnSync('/usr/bin/chflags', ['nouchg', file])
    `)
    check('a restore of the auth file that cannot be written throws nothing, so the sign-in answers its own refusal', held.threw === null, `${JSON.stringify(held.threw)} · credentialFileRestorer in src/models/sign-in/account-ledger/providerSecrets.ts must catch a failed restore instead of throwing`)
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
