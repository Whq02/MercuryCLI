#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond ? ' — hint: change the store writers and their kept-aside copy in src/models/sign-in/account-ledger/providerSecrets.ts (writeStoredOpenaiApiKey) or src/models/roads/meta/metaAccounts.ts (writePreferredMetaSource), the ledger in src/platform/substrate/storeRecovery.ts, or the sign-out words in src/commands/verbs/providerAuth.ts (providerAuthLogout)' : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

const FULL_SECRETS = { version: 1, zaiApiKey: 'fixture-zai-key', openaiApiKey: 'fixture-openai-old', braveSearchApiKey: 'fixture-brave-key' }
const FULL_META = { version: 1, museCode: { accessToken: 'fixture-muse-access', apiKey: 'fixture-muse-key', observedAtMs: 1 }, preferredSource: 'muse-code' }

const FLOOR = `
    const { floorOf } = await import(${JSON.stringify(join(HERE, '../lib/permissionFloor.ts'))})
`

function runIn(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'secrets-store-kept-')))
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
    const ps = await import(${JSON.stringify(join(SRC, 'models/sign-in/account-ledger/providerSecrets.ts'))})
    const meta = await import(${JSON.stringify(join(SRC, 'models/roads/meta/metaAccounts.ts'))})
    const recovery = await import(${JSON.stringify(join(SRC, 'platform/substrate/storeRecovery.ts'))})
    const secretsFile = ps.providerSecretsPathForDisplay()
    const metaFile = meta.metaAuthPathForDisplay()
    const dir = path.dirname(secretsFile)
    const raw = f => { try { return fs.readFileSync(f, 'utf8') } catch (e) { return { err: e.code } } }
    const mode = f => { try { return fs.statSync(f).mode & 0o777 } catch { return null } }
    const copies = () => fs.readdirSync(dir).filter(n => n.includes('.corrupt.') && fs.statSync(path.join(dir, n)).isFile()).sort()
    const attempt = fn => { try { fn(); return null } catch (e) { return { code: e.code ?? null, message: String(e.message ?? e) } } }
    const parsed = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
    const out = { secretsFile, metaFile }
    fs.mkdirSync(dir, { recursive: true })
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file' } })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1500)}`)
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
}
type Threw = { code: string | null; message: string } | null
type Floor = Record<string, { read: string; cat: string }> | null
type Event = { store?: string; kind?: string; quarantinePath?: string | null; reason?: string }
const floorRefuses = (floor: Floor, mode: string): boolean => floor?.[mode]?.read === 'deny' && floor?.[mode]?.cat === 'deny'

console.log('the secrets store — a store that is not valid JSON is kept aside, and a person can find where')
{
  const r = runIn(`
    ${FLOOR}
    const torn = ${JSON.stringify(JSON.stringify(FULL_SECRETS))}.slice(0, 60)
    fs.writeFileSync(secretsFile, torn, { mode: 0o600 })
    out.threw = attempt(() => ps.writeStoredOpenaiApiKey('fixture-openai-new'))
    out.copies = copies()
    const copy = out.copies.length === 1 ? path.join(dir, out.copies[0]) : null
    out.copy = copy
    out.copyHoldsTheBytes = copy !== null && raw(copy) === torn
    out.copyMode = copy === null ? null : mode(copy)
    out.after = parsed(secretsFile)
    out.events = await recovery.readStoreRecoveryEvents()
    out.floor = copy === null ? null : await floorOf(copy)
    out.floorOfTheStore = await floorOf(secretsFile)
  `)
  const copies = r.copies as string[]
  check('the write lands and one copy holds the old bytes, mode 0600', r.threw === null && (r.after as Record<string, unknown> | null)?.openaiApiKey === 'fixture-openai-new' && copies.length === 1 && /^\.provider-secrets\.json\.corrupt\.\d+$/.test(copies[0]!) && r.copyHoldsTheBytes === true && (!POSIX_MODES || r.copyMode === 0o600), JSON.stringify({ threw: r.threw, copies, mode: r.copyMode }))
  const last = (r.events as Event[]).at(-1)
  check('the recovery ledger, which the Health Check prints, names the store, the reason and where the copy is', last !== undefined && last.store === 'provider-secrets' && last.reason === 'not valid JSON' && last.quarantinePath === r.copy && (last.kind ?? 'quarantine') === 'quarantine', `${JSON.stringify(last ?? null)} — nobody is told where the old keys are`)
  for (const mode of ['default', 'sovereign']) check(`${mode}: the read floor that refuses the store refuses its kept-aside copy, by Read and by cat`, floorRefuses(r.floorOfTheStore as Floor, mode) && floorRefuses(r.floor as Floor, mode), `store ${JSON.stringify((r.floorOfTheStore as Floor)?.[mode])} · copy ${JSON.stringify((r.floor as Floor)?.[mode] ?? null)}`)
}

console.log('the secrets store — a copy never clobbers an earlier one, and a name that is taken is passed over')
{
  const r = runIn(`
    const realNow = Date.now
    Date.now = () => 1763580000000
    fs.writeFileSync(secretsFile, 'first torn store {', { mode: 0o600 })
    out.first = attempt(() => ps.writeStoredOpenaiApiKey('fixture-one'))
    fs.writeFileSync(secretsFile, 'second torn store {', { mode: 0o600 })
    out.second = attempt(() => ps.writeStoredOpenaiApiKey('fixture-two'))
    Date.now = realNow
    out.held = copies().map(name => raw(path.join(dir, name))).sort()
  `)
  check('two stores that are not valid JSON in one millisecond: both writes land and both old stores are kept', r.first === null && r.second === null && JSON.stringify(r.held) === JSON.stringify(['first torn store {', 'second torn store {']), `kept ${JSON.stringify(r.held)} — the second copy overwrote the first`)
  const taken = runIn(`
    const realNow = Date.now
    Date.now = () => 1763580000000
    fs.mkdirSync(secretsFile + '.corrupt.1763580000000')
    fs.writeFileSync(secretsFile, 'torn store whose copy name is taken {', { mode: 0o600 })
    out.threw = attempt(() => ps.writeStoredOpenaiApiKey('fixture-new'))
    Date.now = realNow
    out.held = copies().map(name => raw(path.join(dir, name)))
    out.after = parsed(secretsFile)
  `)
  check('the name of the copy taken by a folder: the old store is still kept, under the next name, before it is replaced', taken.threw === null && JSON.stringify(taken.held) === JSON.stringify(['torn store whose copy name is taken {']) && (taken.after as Record<string, unknown> | null)?.openaiApiKey === 'fixture-new', `kept ${JSON.stringify(taken.held)} — the store was replaced with no copy`)
}

console.log('the secrets store — a store that is not valid JSON and cannot be kept aside is not replaced')
if (!POSIX_MODES) skip('the copy that fails', 'a folder that takes no new file needs a POSIX process that is not root')
else {
  const r = runIn(`
    fs.writeFileSync(secretsFile, 'torn {', { mode: 0o600 })
    fs.chmodSync(dir, 0o500)
    out.threw = attempt(() => ps.writeStoredOpenaiApiKey('fixture-new'))
    fs.chmodSync(dir, 0o700)
    out.same = raw(secretsFile) === 'torn {'
  `)
  const threw = r.threw as Threw
  const words = `The provider secrets store at ${String(r.secretsFile)} is not valid JSON and could not be kept aside (EACCES); nothing was written. Move it away, then try again.`
  check('the writer refuses and the store stands', threw !== null && r.same === true, JSON.stringify(threw))
  check('the refusal says why nothing was written and what to do, and carries the code', threw?.message === words && threw.code === 'EACCES', `said: ${threw?.message ?? '(nothing)'} — wanted: ${words}`)
}

console.log('the secrets store — there and unreadable: the sign-out of one provider says so in the store\'s own sentence and exits 1')
if (!POSIX_MODES) skip('the unreadable store', 'a mode-0200 file needs a POSIX process that is not root')
else {
  const r = runIn(`
    const cli = await import(${JSON.stringify(join(SRC, 'commands/verbs/providerAuth.ts'))})
    const STORE = ${JSON.stringify(JSON.stringify({ ...FULL_SECRETS, deepseekApiKey: 'fixture-deepseek-key' }, null, 2) + '\n')}
    fs.writeFileSync(secretsFile, STORE, { mode: 0o600 })
    fs.chmodSync(secretsFile, 0o200)
    const said = { out: '', err: '', exit: null }
    await cli.providerAuthLogout('deepseek', { writeOut: text => { said.out += text }, writeErr: text => { said.err += text }, exit: code => { said.exit = code } })
    fs.chmodSync(secretsFile, 0o600)
    out.said = said
    out.same = raw(secretsFile) === STORE
  `)
  const said = r.said as { out: string; err: string; exit: number | null }
  check('mercury auth logout deepseek names the store it could not read on the error stream, exits 1, and the store stands with its key', said.err.startsWith(`Could not sign out: The provider secrets store at ${String(r.secretsFile)} exists but could not be read (EACCES); nothing was written.`) && said.out === '' && said.exit === 1 && r.same === true, `${JSON.stringify(said)} · store ${r.same === true ? 'kept' : 'changed'}`)
}

console.log('the secrets store — there and it takes no write: every sign-out road says so with the file as the subject and the code alone in brackets')
{
  const r = runIn(`
    const cli = await import(${JSON.stringify(join(SRC, 'commands/verbs/providerAuth.ts'))})
    const removal = await import(${JSON.stringify(join(SRC, 'models/roads/account-slots/removal.ts'))})
    const STORE = ${JSON.stringify(JSON.stringify({ ...FULL_SECRETS, deepseekApiKey: 'fixture-deepseek-key' }, null, 2) + '\n')}
    fs.writeFileSync(secretsFile, STORE, { mode: 0o600 })
    process.env.MERCURY_FAULT_INJECT = 'rename@.provider-secrets.json:eperm'
    const said = { out: '', err: '', exit: null }
    await cli.providerAuthLogout('deepseek', { writeOut: text => { said.out += text }, writeErr: text => { said.err += text }, exit: code => { said.exit = code } })
    out.said = said
    out.slot = removal.executeSlotRemoval({ id: 'deepseek:api-key', family: 'deepseek', kind: 'api-key', signedIn: true, removal: { route: 'deepseek-stored-key' } })
    out.every = removal.signOutEveryEngineCredential()
    delete process.env.MERCURY_FAULT_INJECT
    out.same = raw(secretsFile) === STORE
    out.residue = fs.readdirSync(dir).filter(n => n.includes('.tmp'))
  `)
  const words = `Could not sign out: ${String(r.secretsFile)} could not be written (EPERM); nothing was written. Close what holds the file, then try again.`
  const said = r.said as { out: string; err: string; exit: number | null }
  const slot = r.slot as { note?: string; mutated?: boolean; refused?: boolean }
  check('mercury auth logout deepseek says the file could not be written on the error stream and exits 1', said.err === `${words}\n` && said.out === '' && said.exit === 1, JSON.stringify(said))
  check('the /accounts slot answers the same words and changes nothing', slot.note === words && slot.mutated === false && slot.refused === true, JSON.stringify(slot))
  check('the sign-out of every provider says it once, in the same words', JSON.stringify(r.every) === JSON.stringify([words]), JSON.stringify(r.every))
  check('the store stands with its keys and no temporary file is left beside it', r.same === true && (r.residue as string[]).length === 0, `store ${r.same === true ? 'kept' : 'changed'} · ${JSON.stringify(r.residue)}`)
}

console.log('the auth file beside it (publishAuthScopedJson, the Meta auth file) — there and unreadable: not replaced')
if (!POSIX_MODES) skip('the unreadable file', 'a mode-0200 file needs a POSIX process that is not root')
else {
  const r = runIn(`
    const FULL = ${JSON.stringify(JSON.stringify(FULL_META, null, 2) + '\n')}
    fs.writeFileSync(metaFile, FULL, { mode: 0o600 })
    fs.chmodSync(metaFile, 0o200)
    out.threw = attempt(() => meta.writePreferredMetaSource('api-key'))
    fs.chmodSync(metaFile, 0o600)
    out.same = raw(metaFile) === FULL
    out.copies = copies()
  `)
  const threw = r.threw as Threw
  const words = `The auth file at ${String(r.metaFile)} exists but could not be read (EACCES); nothing was written. Make it readable, or move it away to start a new one, then try again.`
  check('the writer refuses and the file stands byte for byte, its grant with it', threw !== null && r.same === true, threw === null ? 'it returned as if it had written, and the grant is gone' : JSON.stringify(threw))
  check('the refusal says what could not be read, the code, that nothing was written and what to do', threw?.message === words && threw.code === 'EACCES', `said: ${threw?.message ?? '(nothing)'} — wanted: ${words}`)
  check('the refusal holds no secret and nothing is kept aside', threw !== null && !threw.message.includes('fixture-muse') && (r.copies as string[]).length === 0)
  const activate = runIn(`
    const login = await import(${JSON.stringify(join(SRC, 'models/roads/meta/metaLogin.ts'))})
    const FULL = ${JSON.stringify(JSON.stringify(FULL_META, null, 2) + '\n')}
    fs.writeFileSync(metaFile, FULL, { mode: 0o600 })
    fs.chmodSync(metaFile, 0o200)
    out.outcome = attempt(() => { out.answered = login.activateMetaSource('api-key') })
    fs.chmodSync(metaFile, 0o600)
    out.same = raw(metaFile) === FULL
  `)
  const answered = activate.answered as { ok?: boolean; receipt?: string } | undefined
  const signIn = runIn(`
    const login = await import(${JSON.stringify(join(SRC, 'models/roads/meta/metaLogin.ts'))})
    const FULL = ${JSON.stringify(JSON.stringify(FULL_META, null, 2) + '\n')}
    fs.writeFileSync(metaFile, FULL, { mode: 0o600 })
    fs.chmodSync(metaFile, 0o200)
    out.outcome = await login.storeMetaApiKeyLogin('fixture-new-meta-key-0123', { fetchImpl: async () => { throw new Error('the fixture has no network') }, env: {} })
    fs.chmodSync(metaFile, 0o600)
    out.same = raw(metaFile) === FULL
    out.storedKey = (parsed(secretsFile) ?? {}).metaApiKey ?? null
    out.ledger = Object.keys((parsed(path.join(dir, '.sign-ins.json')) ?? {}).signIns ?? {})
  `)
  const refused = signIn.outcome as { ok?: boolean; stored?: boolean; receipt?: string } | undefined
  check('a Meta key sign-in that the auth file refuses says so, and the file stands', refused?.ok === false && refused.stored === false && refused.receipt === `Could not store the key: ${words.replace(String(r.metaFile), String(signIn.metaFile))}` && signIn.same === true, JSON.stringify(refused))
  check('…and nothing of it is stored: no key in the secrets store, no sign-in in the ledger', signIn.storedKey === null && (signIn.ledger as string[]).length === 0, `the secrets store holds the key (${JSON.stringify(signIn.storedKey)}) and the ledger records ${JSON.stringify(signIn.ledger)}: "nothing was written" is not true`)
  check('making a Meta source active answers a receipt that says why and is not ok, and the file stands', activate.outcome === null && answered?.ok === false && answered.receipt === `Could not make it the active source: ${words.replace(String(r.metaFile), String(activate.metaFile))}` && activate.same === true, `${JSON.stringify(activate.outcome ?? answered)} · file ${activate.same === true ? 'kept' : 'replaced'}`)
}

console.log('the auth file beside it — not valid JSON, or JSON that is no object: kept aside before the new one is written')
{
  const r = runIn(`
    ${FLOOR}
    const torn = ${JSON.stringify(JSON.stringify(FULL_META))}.slice(0, 50)
    fs.writeFileSync(metaFile, torn, { mode: 0o600 })
    out.first = attempt(() => meta.writePreferredMetaSource('api-key'))
    out.copiesAfterFirst = copies()
    const copy = out.copiesAfterFirst.length === 1 ? path.join(dir, out.copiesAfterFirst[0]) : null
    out.copy = copy
    out.copyHoldsTheBytes = copy !== null && raw(copy) === torn
    out.copyMode = copy === null ? null : mode(copy)
    out.floor = copy === null ? null : await floorOf(copy)
    out.floorOfTheFile = await floorOf(metaFile)
    fs.writeFileSync(metaFile, '["an", "array"]', { mode: 0o600 })
    out.second = attempt(() => meta.writePreferredMetaSource('api-key'))
    out.held = copies().map(name => raw(path.join(dir, name))).sort()
    out.after = parsed(metaFile)
    out.events = await recovery.readStoreRecoveryEvents()
  `)
  const first = r.copiesAfterFirst as string[]
  check('the write lands and one copy holds the old bytes, under a name that ends in -auth.json, mode 0600', r.first === null && first.length === 1 && /^\.meta\.corrupt\.\d+-auth\.json$/.test(first[0]!) && r.copyHoldsTheBytes === true && (!POSIX_MODES || r.copyMode === 0o600), `${JSON.stringify(first)} — the old grant is on disk nowhere`)
  check('an array is kept aside too, beside the first copy', r.second === null && (r.held as string[]).length === 2 && (r.held as string[]).includes('["an", "array"]') && (r.after as Record<string, unknown> | null)?.preferredSource === 'api-key', JSON.stringify(r.held))
  const events = r.events as Event[]
  check('the recovery ledger names the store, each reason and where each copy is', events.length === 2 && events.every(event => event.store === 'meta-auth' && typeof event.quarantinePath === 'string') && events[0]!.reason === 'not valid JSON' && events[1]!.reason === 'not a JSON object' && events[0]!.quarantinePath === r.copy, JSON.stringify(events))
  for (const mode of ['default', 'sovereign']) check(`${mode}: the read floor that refuses the auth file refuses its kept-aside copy, by Read and by cat`, floorRefuses(r.floorOfTheFile as Floor, mode) && floorRefuses(r.floor as Floor, mode), `file ${JSON.stringify((r.floorOfTheFile as Floor)?.[mode])} · copy ${JSON.stringify((r.floor as Floor)?.[mode] ?? null)}`)
}

console.log('the auth file beside it — controls: no file is a first write, and a file that reads keeps its other fields')
{
  const r = runIn(`
    out.absent = attempt(() => meta.writePreferredMetaSource('api-key'))
    out.afterAbsent = parsed(metaFile)
    fs.writeFileSync(metaFile, ${JSON.stringify(JSON.stringify(FULL_META, null, 2) + '\n')}, { mode: 0o600 })
    out.valid = attempt(() => meta.writePreferredMetaSource('api-key'))
    out.afterValid = parsed(metaFile)
    out.copies = copies()
  `)
  check('with no file the first write lands', r.absent === null && (r.afterAbsent as Record<string, unknown> | null)?.preferredSource === 'api-key', JSON.stringify(r.absent))
  const after = r.afterValid as { preferredSource?: string; museCode?: { apiKey?: string } } | null
  check('with a file that reads the write lands and the grant stays', r.valid === null && after?.preferredSource === 'api-key' && after.museCode?.apiKey === 'fixture-muse-key', JSON.stringify(r.valid))
  check('neither keeps anything aside', (r.copies as string[]).length === 0, JSON.stringify(r.copies))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
