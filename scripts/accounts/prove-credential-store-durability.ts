#!/usr/bin/env bun
// ============================================================================
//  scripts/accounts/prove-credential-store-durability.ts — the credential
//  store and the provider-secret store never lose their contents on a
//  failed read or an interrupted write (release-hardening audit rank 15).
//
//  The class, two entrances. (1) plainTextStorage.update() was a truncating
//  in-place writeFileSync with flushing disabled — no temp sibling, no
//  rename, no fsync — so an interruption between the open-with-truncate and
//  the completed write left a store that reads as "no sign-in, no MCP
//  sessions, no extension secrets" on the next launch. (2) Every writer of
//  both stores is a read-modify-write of one field over a reader that
//  answers null for ABSENT, UNREADABLE and UNPARSEABLE alike — so one
//  failed read rewrote the file containing only that field, dropping the
//  sign-in plus every MCP session and extension secret (the credential
//  store), or every other engine key and both search keys (the provider
//  secrets). The fix sits at the two store owners; the writers are
//  untouched.
//
//   L1  credential store, failed read: a store the process can WRITE but
//       not READ (mode 0200 — the read-refused/write-allowed shape a
//       sharing violation gives on Windows) plus a one-field writer →
//       update() REFUSES with the errno on `code`; the bytes are identical
//   L2  credential store, unparseable bytes: a torn store plus a one-field
//       writer → the torn bytes are quarantined beside the store before
//       the rewrite (nothing is destroyed)
//   L3  credential store, the publish is atomic: an existing store's
//       inode changes across update() (a rename, never an in-place
//       truncate), no temp residue remains, the mode is 0600
//   L4  provider secrets, failed read: the same 0200 shape plus
//       writeStoredOpenaiApiKey → the writer THROWS (its documented
//       contract) with the errno; every other key survives on disk
//   L5  provider secrets, unparseable bytes: quarantined before the rewrite
//   L6  provider secrets, the publish is atomic (inode moves, no residue,
//       mode 0600)
//   L7  controls: an absent store is created; a healthy round-trip keeps
//       every field; a refused publish (fault-injected rename) leaves the
//       old bytes and reports the errno class
//
//  Each scenario runs in its own fresh bun subprocess with its own scratch
//  MERCURY_CONFIG_DIR and MERCURY_CREDENTIAL_STORE=file (the hermeticity
//  seam: no path to the machine's keychain). The mode-0200 legs are POSIX
//  facts and are skipped (not failed) on win32 or as root. PROVE_SRC names
//  another checkout's src (the A/B control: against the pre-fix tree
//  L1–L6 read red while L7's absent/round-trip legs stay green).
// ============================================================================
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

const FULL_STORE = {
  claudeAiOauth: { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 4102444800000, scopes: ['user:inference'], subscriptionType: 'pro' },
  mcpOAuth: { 'srv-a|https://a.example': { accessToken: 'mcp-a', refreshToken: 'mcp-ra' } },
  mcpOAuthClientConfig: { 'srv-a': { clientId: 'cid' } },
  extensionSecrets: { 'ext-1': { apiKey: 'ext-secret' } },
  trustedDeviceToken: 'device-1',
}
const FULL_SECRETS = {
  version: 1,
  zaiApiKey: 'zai-1',
  zaiKeyPlan: 'coding',
  openaiApiKey: 'oa-old',
  braveSearchApiKey: 'brave-1',
  tavilyApiKey: 'tav-1',
  futureField: 'kept',
}

/** Run a scenario body in a fresh process against a scratch home; the body
 *  prints ONE JSON line the scenario asserts on. */
function runIn(body: string, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const home = mkdtempSync(join(tmpdir(), 'cred-durability-'))
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    const fs = await import('node:fs')
    const path = await import('node:path')
    const ss = await import(${JSON.stringify(join(SRC, 'utils/secureStorage/index.ts'))})
    const ps = await import(${JSON.stringify(join(SRC, 'utils/router/providerSecrets.ts'))})
    const home = ${JSON.stringify(home)}
    const credFile = path.join(home, '.credentials.json')
    const secretsFile = ps.providerSecretsPathForDisplay()
    const store = ss.getSecureStorage()
    const raw = (f) => { try { return fs.readFileSync(f, 'utf8') } catch (e) { return { err: e.code } } }
    const ino = (f) => { try { return fs.statSync(f).ino } catch { return null } }
    const mode = (f) => { try { return fs.statSync(f).mode & 0o777 } catch { return null } }
    const residue = () => fs.readdirSync(home).filter(n => n.includes('.tmp'))
    const quarantines = (base) => fs.readdirSync(home).filter(n => n.startsWith(base + '.corrupt.'))
    const errOf = (e) => e ? { name: e.name, code: e.code ?? null, message: String(e.message ?? e) } : null
    const out = {}
    ${body}
    process.stdout.write(JSON.stringify(out))
  `
  const res = spawnSync(BUN, ['-e', src], {
    encoding: 'utf8',
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file', ...extraEnv },
  })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1500)}`)
  const line = res.stdout.trim().split('\n').pop() ?? '{}'
  return JSON.parse(line) as Record<string, unknown>
}
type Err = { name: string; code: string | null; message: string } | null

// ── L1: credential store, failed read ──────────────────────────────────────
console.log('L1 credential store — an unreadable-but-writable store is never replaced by a one-field rewrite')
if (!POSIX_MODES) skip('L1', 'mode-0200 shape needs a non-root POSIX process')
else {
  const r = runIn(`
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(credFile, JSON.stringify(${JSON.stringify(FULL_STORE)}), { mode: 0o600 })
    const before = raw(credFile)
    fs.chmodSync(credFile, 0o200)
    // The writer shape every credential writer has: read-modify-write of one field.
    const current = store.read() ?? {}
    out.readAnswered = current
    out.verdict = store.update({ ...current, trustedDeviceToken: 'device-2' })
    fs.chmodSync(credFile, 0o600)
    out.same = raw(credFile) === before
    out.after = JSON.parse(raw(credFile))
  `)
  const v = r.verdict as { success: boolean; code?: string }
  check('read() answered null for the unreadable store (the writer shape that drops everything)', Object.keys(r.readAnswered as object).length === 0)
  check('update() refuses (success:false)', v.success === false, `verdict=${JSON.stringify(v)}`)
  check('the refusal names the errno class on code', v.code === 'EACCES', `code=${v.code}`)
  const after = r.after as Record<string, unknown>
  check('the store is byte-identical after the refused write', r.same === true, `after holds ${Object.keys(after).join(',')} — sign-in ${after.claudeAiOauth ? 'kept' : 'GONE'}, MCP sessions ${after.mcpOAuth ? 'kept' : 'GONE'}, extension secrets ${after.extensionSecrets ? 'kept' : 'GONE'}`)
}

// ── L2: credential store, unparseable bytes ────────────────────────────────
console.log('L2 credential store — torn bytes are quarantined before the rewrite')
{
  const r = runIn(`
    fs.mkdirSync(home, { recursive: true })
    const torn = JSON.stringify(${JSON.stringify(FULL_STORE)}).slice(0, 120)
    fs.writeFileSync(credFile, torn, { mode: 0o600 })
    const current = store.read() ?? {}
    out.verdict = store.update({ ...current, trustedDeviceToken: 'device-2' })
    out.quarantines = quarantines('.credentials.json')
    out.quarantineBytesMatch = out.quarantines.length === 1 && raw(path.join(home, out.quarantines[0])) === torn
    out.after = JSON.parse(raw(credFile))
  `)
  check('the rewrite lands (the bytes were unparseable; the store is usable again)', (r.verdict as { success: boolean }).success === true)
  check('exactly one quarantine copy sits beside the store', (r.quarantines as string[]).length === 1, `found ${JSON.stringify(r.quarantines)}`)
  check('the quarantine holds the torn bytes verbatim (a refresh token stays hand-recoverable)', r.quarantineBytesMatch === true)
}

// ── L3: credential store, atomic publish ───────────────────────────────────
console.log('L3 credential store — the publish is a rename, never an in-place truncate')
{
  const r = runIn(`
    fs.mkdirSync(home, { recursive: true })
    store.update(${JSON.stringify(FULL_STORE)})
    const inoBefore = ino(credFile)
    store.update({ ...store.read(), trustedDeviceToken: 'device-2' })
    out.inoMoved = inoBefore !== null && ino(credFile) !== inoBefore
    out.residue = residue()
    out.mode = mode(credFile)
    out.after = JSON.parse(raw(credFile))
  `)
  if (process.platform === 'win32') skip('inode moves across update()', 'inode identity is a POSIX fact')
  else check('the inode changes across update() (a rename publish; an in-place write keeps it)', r.inoMoved === true)
  check('no temp residue remains beside the store', (r.residue as string[]).length === 0, JSON.stringify(r.residue))
  if (POSIX_MODES) check('the published store is mode 0600', r.mode === 0o600, `mode=${(r.mode as number)?.toString(8)}`)
  check('every field survives the round-trip', (r.after as Record<string, unknown>).claudeAiOauth !== undefined && (r.after as Record<string, unknown>).trustedDeviceToken === 'device-2')
}

// ── L4: provider secrets, failed read ──────────────────────────────────────
console.log('L4 provider secrets — an unreadable-but-writable store is never replaced by a one-field rewrite')
if (!POSIX_MODES) skip('L4', 'mode-0200 shape needs a non-root POSIX process')
else {
  const r = runIn(`
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(secretsFile, JSON.stringify(${JSON.stringify(FULL_SECRETS)}, null, 2) + '\\n', { mode: 0o600 })
    const before = raw(secretsFile)
    fs.chmodSync(secretsFile, 0o200)
    try { ps.writeStoredOpenaiApiKey('oa-new'); out.threw = null } catch (e) { out.threw = errOf(e) }
    fs.chmodSync(secretsFile, 0o600)
    out.same = raw(secretsFile) === before
    out.after = JSON.parse(raw(secretsFile))
  `)
  const t = r.threw as Err
  check('the writer throws (its contract: the caller surfaces a failed secret write)', t !== null, t ? '' : 'returned quietly')
  check('the throw names the errno class', t?.code === 'EACCES' && t.message.includes('EACCES'), `code=${t?.code}`)
  check('the throw never carries the key value', !!t && !t.message.includes('oa-new'))
  const after = r.after as Record<string, unknown>
  check('every other key survives on disk (byte-identical)', r.same === true, `after: zai ${after.zaiApiKey ? 'kept' : 'GONE'}, brave ${after.braveSearchApiKey ? 'kept' : 'GONE'}, tavily ${after.tavilyApiKey ? 'kept' : 'GONE'}`)
}

// ── L5: provider secrets, unparseable bytes ────────────────────────────────
console.log('L5 provider secrets — torn bytes are quarantined before the rewrite')
{
  const r = runIn(`
    fs.mkdirSync(home, { recursive: true })
    const torn = JSON.stringify(${JSON.stringify(FULL_SECRETS)}).slice(0, 60)
    fs.writeFileSync(secretsFile, torn, { mode: 0o600 })
    try { ps.writeStoredOpenaiApiKey('oa-new'); out.threw = null } catch (e) { out.threw = errOf(e) }
    out.quarantines = quarantines('.provider-secrets.json')
    out.quarantineBytesMatch = out.quarantines.length === 1 && raw(path.join(home, out.quarantines[0])) === torn
    out.after = JSON.parse(raw(secretsFile))
  `)
  check('the rewrite lands', r.threw === null, r.threw ? `threw ${(r.threw as Err)?.message}` : '')
  check('exactly one quarantine copy sits beside the store', (r.quarantines as string[]).length === 1, JSON.stringify(r.quarantines))
  check('the quarantine holds the torn bytes verbatim', r.quarantineBytesMatch === true)
  check('the new key is on disk', (r.after as Record<string, unknown>).openaiApiKey === 'oa-new')
}

// ── L6: provider secrets, atomic publish ───────────────────────────────────
console.log('L6 provider secrets — the publish is a rename, never an in-place truncate')
{
  const r = runIn(`
    fs.mkdirSync(home, { recursive: true })
    ps.writeStoredZaiApiKey('zai-1', 'coding')
    ps.writeStoredBraveSearchApiKey('brave-1')
    const inoBefore = ino(secretsFile)
    ps.writeStoredOpenaiApiKey('oa-new')
    out.inoMoved = inoBefore !== null && ino(secretsFile) !== inoBefore
    out.residue = residue()
    out.mode = mode(secretsFile)
    out.after = JSON.parse(raw(secretsFile))
    out.readBack = { zai: ps.readStoredZaiApiKey(), plan: ps.readStoredZaiKeyPlan(), brave: ps.readStoredBraveSearchApiKey(), openai: ps.readStoredOpenaiApiKey() }
  `)
  if (process.platform === 'win32') skip('inode moves across the write', 'inode identity is a POSIX fact')
  else check('the inode changes across the write (a rename publish)', r.inoMoved === true)
  check('no temp residue remains beside the store', (r.residue as string[]).length === 0, JSON.stringify(r.residue))
  if (POSIX_MODES) check('the published store is mode 0600', r.mode === 0o600, `mode=${(r.mode as number)?.toString(8)}`)
  const rb = r.readBack as Record<string, unknown>
  check('every key reads back after the round-trip', rb.zai === 'zai-1' && rb.plan === 'coding' && rb.brave === 'brave-1' && rb.openai === 'oa-new', JSON.stringify(rb))
}

// ── L7: controls ───────────────────────────────────────────────────────────
console.log('L7 controls — absent store created; healthy round-trip; a refused publish keeps the old bytes')
{
  const r = runIn(`
    out.readAbsent = store.read()
    out.created = store.update({ trustedDeviceToken: 'first' })
    out.afterCreate = store.read()
    ps.writeStoredTavilyApiKey('tav-1')
    out.tav = ps.readStoredTavilyApiKey()
  `)
  check('absent credential store: read() is null and the first update creates it', r.readAbsent === null && (r.created as { success: boolean }).success === true && (r.afterCreate as Record<string, unknown>)?.trustedDeviceToken === 'first')
  check('absent provider secrets: the first write creates the store', r.tav === 'tav-1')

  // The refused-publish leg: the durable writer's fault seam fails the
  // rename for the credential path; the old bytes must survive and the
  // verdict must name the class.
  const f = runIn(`
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(credFile, JSON.stringify(${JSON.stringify(FULL_STORE)}), { mode: 0o600 })
    const before = raw(credFile)
    out.verdict = store.update({ ...store.read(), trustedDeviceToken: 'device-2' })
    out.same = raw(credFile) === before
    out.residue = residue()
  `, { MERCURY_FAULT_INJECT: 'rename@.credentials.json:eperm' })
  const v = f.verdict as { success: boolean; code?: string }
  check('a refused publish reports success:false with the errno class', v.success === false && v.code === 'EPERM', JSON.stringify(v))
  check('the old bytes survive a refused publish', f.same === true)
  check('the refused publish leaves no temp residue', (f.residue as string[]).length === 0, JSON.stringify(f.residue))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
