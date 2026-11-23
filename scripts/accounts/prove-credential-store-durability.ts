#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) console.log('    fix: the credential store read, quarantine of torn bytes and rename publish are in src/platform/secure-storage/plainTextStorage.ts (store chosen by getSecureStorage in src/platform/secure-storage/index.ts); the provider secrets writers (writeStoredOpenaiApiKey and the other writeStored functions) are in src/models/sign-in/account-ledger/providerSecrets.ts; for the keychain checks (L8) look at the other files in src/platform/secure-storage')
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

function runIn(body: string, extraEnv: Record<string, string> = {}, keychainHolds?: Record<string, unknown> | null): Record<string, unknown> {
  const home = mkdtempSync(join(tmpdir(), 'cred-durability-'))
  const onKeychain = keychainHolds !== undefined
  const bin = join(home, 'keychain-bin')
  if (onKeychain) {
    mkdirSync(bin)
    writeFileSync(join(bin, 'security'), `#!/bin/sh\nif [ "$1" = "-i" ]; then cat > '${bin}/added'; exit 0; fi\nif [ "$1" = "find-generic-password" ] && [ -f '${bin}/held' ]; then cat '${bin}/held'; exit 0; fi\nexit 44\n`)
    chmodSync(join(bin, 'security'), 0o755)
    if (keychainHolds !== null) writeFileSync(join(bin, 'held'), JSON.stringify(keychainHolds))
  }
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    ${onKeychain ? 'delete process.env.MERCURY_CREDENTIAL_STORE' : "process.env.MERCURY_CREDENTIAL_STORE = 'file'"}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    const fs = await import('node:fs')
    const path = await import('node:path')
    const ss = await import(${JSON.stringify(join(SRC, 'platform/secure-storage/index.ts'))})
    const ps = await import(${JSON.stringify(join(SRC, 'models/sign-in/account-ledger/providerSecrets.ts'))})
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
  const env: Record<string, string | undefined> = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file', ...extraEnv }
  if (onKeychain) {
    delete env.MERCURY_CREDENTIAL_STORE
    env.PATH = `${bin}:${process.env.PATH ?? ''}`
  }
  const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1500)}`)
  const line = res.stdout.trim().split('\n').pop() ?? '{}'
  return JSON.parse(line) as Record<string, unknown>
}
type Err = { name: string; code: string | null; message: string } | null

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

console.log('L8 keychain storage — a write never moves the store into the keychain over a credential file it could not read')
if (process.platform !== 'darwin') skip('L8', 'the keychain storage is the Mac one')
else if (!POSIX_MODES) skip('L8', 'mode-0200 shape needs a non-root POSIX process')
else {
  const onKeychain = (file: 'unreadable' | 'readable' | 'absent', keychainHolds: Record<string, unknown> | null): Record<string, unknown> => runIn(`
    fs.mkdirSync(home, { recursive: true })
    const added = path.join(home, 'keychain-bin', 'added')
    ${file === 'absent' ? '' : `fs.writeFileSync(credFile, JSON.stringify(${JSON.stringify(FULL_STORE)}), { mode: 0o600 })`}
    const before = raw(credFile)
    ${file === 'unreadable' ? 'fs.chmodSync(credFile, 0o200)' : ''}
    out.storeName = store.name
    const current = store.read() ?? {}
    out.verdict = store.update({ ...current, trustedDeviceToken: 'device-2' })
    out.stands = fs.existsSync(credFile)
    if (out.stands) { fs.chmodSync(credFile, 0o600); out.same = raw(credFile) === before }
    out.keychainWritten = fs.existsSync(added)
    out.unreadWords = 'The credential store at ' + ss.credentialsPath() + ' exists but could not be read (EACCES); nothing was written.'
  `, {}, keychainHolds)
  type Verdict = { success: boolean; warning?: string; code?: string }
  const told = (r: Record<string, unknown>): string => `write ${(r.verdict as Verdict).success ? 'landed' : 'refused'} · keychain ${r.keychainWritten === true ? 'written' : 'not written'} · file ${r.stands === true ? (r.same === true ? 'stands' : 'changed') : 'not there'}`
  const unread = onKeychain('unreadable', null)
  const v = unread.verdict as Verdict
  check('the storage under test is the keychain with the credential file behind it', unread.storeName === 'keychain-with-plaintext-fallback', String(unread.storeName))
  check('the keychain holds nothing and the credential file cannot be read: update() refuses with the store\'s own sentence and its code', v.success === false && v.warning === unread.unreadWords && v.code === 'EACCES', `verdict=${JSON.stringify(v)}`)
  check('the unreadable credential file stands byte for byte after the refused write', unread.stands === true && unread.same === true, unread.stands === true ? (unread.same === true ? 'stands' : 'its bytes changed') : 'DELETED, its tokens with it')
  check('nothing was put into the keychain by the refused write', unread.keychainWritten === false)
  const absent = onKeychain('absent', null)
  check('control: no credential file, the keychain holds nothing: the write lands in the keychain and makes no file', (absent.verdict as Verdict).success === true && absent.keychainWritten === true && absent.stands === false, told(absent))
  const readable = onKeychain('readable', null)
  check('control: a readable credential file, the keychain holds nothing: the store moves into the keychain and the file goes, as before', (readable.verdict as Verdict).success === true && readable.keychainWritten === true && readable.stands === false, told(readable))
  const signIns = runIn(`
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.env.NODE_ENV = 'test'
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(credFile, JSON.stringify(${JSON.stringify(FULL_STORE)}), { mode: 0o600 })
    const before = raw(credFile)
    fs.chmodSync(credFile, 0o200)
    out.unreadWords = 'The credential store at ' + ss.credentialsPath() + ' exists but could not be read (EACCES); nothing was written.'
    const mcp = await import(${JSON.stringify(join(SRC, 'integrations/mcp/auth.ts'))})
    let opened = null
    out.mcp = await Promise.race([
      mcp.performMCPOAuthFlow('probe', { type: 'http', url: 'http://127.0.0.1:9/mcp' }, url => { opened = url }, undefined, { skipBrowserOpen: true }).then(() => 'resolved', error => 'rejected: ' + error.message),
      new Promise(resolve => setTimeout(() => resolve('still waiting after 4s'), 4000)),
    ])
    out.opened = opened
    const auth = { ...(await import(${JSON.stringify(join(SRC, 'models/sign-in/credentials/auth.ts'))})), ...(await import(${JSON.stringify(join(SRC, 'models/sign-in/lifecycle/oauthLifecycle.ts'))})) }
    out.claude = auth.saveOAuthTokensIfNeeded({ accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: 4102444800000, scopes: ['user:inference'], subscriptionType: 'pro', rateLimitTier: null })
    fs.chmodSync(credFile, 0o600)
    out.same = raw(credFile) === before
    out.keychainWritten = fs.existsSync(path.join(home, 'keychain-bin', 'added'))
    process.stdout.write(JSON.stringify(out))
    process.exit(0)
  `, {}, null)
  check('an MCP sign-in on that store refuses at its start with the store\'s own sentence and shows no sign-in address', signIns.mcp === `rejected: ${signIns.unreadWords}` && signIns.opened === null, `${signIns.mcp} · address ${signIns.opened === null ? 'not shown' : 'shown'}`)
  check('a Claude sign-in on that store is answered the store\'s own sentence where it saves its tokens', (signIns.claude as Verdict).success === false && (signIns.claude as Verdict).warning === signIns.unreadWords, JSON.stringify(signIns.claude))
  check('after both sign-ins the unreadable file stands byte for byte and the keychain was not written', signIns.same === true && signIns.keychainWritten === false, `file ${signIns.same === true ? 'stands' : 'changed'} · keychain ${signIns.keychainWritten === true ? 'written' : 'not written'}`)
  const held = onKeychain('unreadable', { trustedDeviceToken: 'device-1' })
  check('control: the keychain already holds the store: the write lands there and the unreadable file stands byte for byte', (held.verdict as Verdict).success === true && held.keychainWritten === true && held.stands === true && held.same === true, told(held))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
