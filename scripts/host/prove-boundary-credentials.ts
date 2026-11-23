import assert from 'node:assert/strict'
import { ownerOnlyFile } from '../lib/ownerOnly.ts'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const childAt = process.argv.indexOf('--child')
const expected = 'fixture-hf-selected-token'
if (childAt !== -1) {
  assert.equal(process.env.HF_TOKEN, undefined)
  const { enableConfigs } = await import('../../src/platform/settings/config.ts'); enableConfigs()
  if (process.argv[childAt + 1] === 'queue-command') {
    const { HOST_RECIPES } = await import('../../src/models/hosting/recipes.ts')
    const { queueHostBank } = await import('../../src/models/hosting/jobs.ts')
    const { resolveHuggingfaceApiKey } = await import('../../src/models/roads/huggingface/huggingfaceAccounts.ts')
    assert.equal(resolveHuggingfaceApiKey()?.key, expected)
    const row = queueHostBank({ id: 'command', name: 'Command credential', recipe: HOST_RECIPES[0]!.id, recipeRow: HOST_RECIPES[0], price: 0, status: 'QUEUED', startedAt: new Date().toISOString(), bankFolder: join(process.env.MERCURY_CONFIG_DIR!, 'bank') })
    console.log(JSON.stringify({ captured: row.huggingfaceCredential?.source === 'captured' }))
    process.exit(0)
  }
  const { readHostRecord } = await import('../../src/models/hosting/store.ts')
  const { runHostJob } = await import('../../src/models/hosting/worker.ts')
  const record = readHostRecord(process.argv[childAt + 1]!)!
  let received = false
  let called = false
  await runHostJob(record.id, record.generation!, { pauseMs: 5, runner: {
    async run(_command, _args, _signal, _timeout, env) { called = true; received = env?.HF_TOKEN === expected; throw new Error('fixture downloader refused ' + (env?.HF_TOKEN ?? 'without-token')) },
    tunnel() { throw new Error('No tunnel in a Bank download') },
  } })
  const log = readFileSync(record.log!, 'utf8')
  console.log(JSON.stringify({ called, received, redacted: !log.includes(expected), missing: log.includes('credential for this job is unavailable') }))
} else {
  const outer = process.env.MERCURY_CONFIG_DIR
  mkdirSync(outer, { recursive: true })
  const home = mkdtempSync(join(outer, 'credentials-'))
  process.env.MERCURY_CONFIG_DIR = home
  process.env.HOME = home
  if (process.platform === 'win32') process.env.USERPROFILE = home
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  delete process.env.MERCURY_HOME
  delete process.env.HF_TOKEN
  const { enableConfigs } = await import('../../src/platform/settings/config.ts'); enableConfigs()
  const { writeStoredHuggingfaceApiKey, readStoredHuggingfaceApiKey } = await import('../../src/models/sign-in/account-ledger/providerSecrets.ts')
  const { setAuthScope, clearAuthScope } = await import('../../src/platform/environment/envUtils.ts')
  const { HOST_RECIPES } = await import('../../src/models/hosting/recipes.ts')
  const { queueHostBank, queueHostWatch, queueHostSetup } = await import('../../src/models/hosting/jobs.ts')
  const { removeHostRecord } = await import('../../src/models/hosting/store.ts')
  let checks = 0
  let failures = 0
  const check = (name: string, truth: unknown, hint = '') => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name + (!truth && hint ? ' — ' + hint : '')) }
  const record = (id: string) => ({ id, name: 'Credential boundary', recipe: HOST_RECIPES[0]!.id, recipeRow: HOST_RECIPES[0]!, price: 0, status: 'QUEUED', startedAt: new Date().toISOString(), bankFolder: join(home, 'bank'), sessionId: 'credential-session' })
  const child = async (id: string, cwd = home) => {
    const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', id], { cwd, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true', ...(process.env.BUN_OPTIONS ? { BUN_OPTIONS: process.env.BUN_OPTIONS } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; let err = ''
    worker.stdout.on('data', c => { out += c }); worker.stderr.on('data', c => { err += c })
    const timer = setTimeout(() => worker.kill('SIGTERM'), 15000)
    try { const code = await new Promise<number | null>((resolve, reject) => { worker.once('error', reject); worker.once('close', resolve) }); assert.equal(code, 0, out + err); return JSON.parse(out.trim().split('\n').at(-1)!) } finally { clearTimeout(timer) }
  }
  const secretPath = (row: any) => row.huggingfaceCredential?.id ? join(row.huggingfaceCredential.home, '.host-credentials', row.huggingfaceCredential.id + '.json') : undefined
  try {
    writeStoredHuggingfaceApiKey(expected)
    queueHostBank(record('stored'))
    check('the existing stored-key path works in a fresh worker without env', (await child('stored')).received, 'a worker with no HF_TOKEN must read the saved key; check resolveHuggingfaceApiKey and the credential capture in src/models/hosting/jobCredentials.ts and queueHostBank in src/models/hosting/jobs.ts')
    writeStoredHuggingfaceApiKey('fixture-other-stored-token')
    process.env.HF_TOKEN = expected
    const selected = queueHostBank(record('selected'))
    const secret = secretPath(selected)
    check('an env-selected credential becomes a private reference, never job-record plaintext', Boolean(secret) && !JSON.stringify(selected).includes(expected) && selected.huggingfaceCredential?.source === 'captured', 'queueHostBank in src/models/hosting/jobs.ts must store a captured reference (src/models/hosting/jobCredentials.ts), never the token itself')
    check('the private capture is owner-only and does not overwrite the saved sign-in', Boolean(secret && ownerOnlyFile(secret)) && readStoredHuggingfaceApiKey() === 'fixture-other-stored-token', 'the capture file under .host-credentials must be owner-only and the saved key must stay untouched; check src/models/hosting/jobCredentials.ts')
    const delivered = await child('selected')
    check('the far side uses the selected token, not an unrelated saved account', delivered.received, 'runHostJob in src/models/hosting/worker.ts must pass the captured token as HF_TOKEN to the runner; check src/models/hosting/jobCredentials.ts')
    check('downloader errors cannot leak the selected token into job logs', delivered.redacted, 'the job log written by runHostJob in src/models/hosting/worker.ts contains the token; redact it before writing')
    check('removing the completed or failed job removes its private capture', Boolean(secret) && !existsSync(secret!), 'removeHostRecord in src/models/hosting/store.ts must delete the private capture file for the job')
    const watch = queueHostWatch(record('watch'))
    const setup = queueHostSetup({ ...watch, id: 'setup' })
    const watchSecret = secretPath(watch)
    const setupSecret = secretPath(setup)
    removeHostRecord(watch.id)
    check('watch-to-setup gives each job its own reference so removing the watch cannot revoke setup', Boolean(watchSecret && setupSecret && watchSecret !== setupSecret && !existsSync(watchSecret) && existsSync(setupSecret)), 'queueHostSetup in src/models/hosting/jobs.ts must capture a new reference rather than reuse the watch job one')
    removeHostRecord(setup.id)
    delete process.env.HF_TOKEN
    const scope = join(home, 'other-account')
    setAuthScope(scope); writeStoredHuggingfaceApiKey(expected)
    const scoped = queueHostBank(record('scoped'))
    clearAuthScope()
    check('a stored credential reference carries its auth home without copying the key', scoped.huggingfaceCredential?.home === scope && scoped.huggingfaceCredential?.source === 'stored', 'queueHostBank in src/models/hosting/jobs.ts must record the auth home with a stored reference; check src/models/hosting/jobCredentials.ts')
    check('a fresh worker resolves the original auth scope instead of the default account', (await child('scoped')).received, 'the worker must resolve the key from the recorded auth home; check src/models/hosting/jobCredentials.ts')
    process.env.HF_TOKEN = expected
    const missing = queueHostBank(record('missing'))
    const missingSecret = secretPath(missing)
    if (missingSecret) unlinkSync(missingSecret)
    const absent = await child('missing')
    check('a missing captured credential refuses rather than falling back to another account', Boolean(missingSecret) && !absent.called && absent.missing, 'runHostJob in src/models/hosting/worker.ts must refuse with the credential-unavailable message and never call the runner when the capture file is gone')
    delete process.env.HF_TOKEN
    const caller = join(home, 'caller')
    mkdirSync(caller)
    writeFileSync(join(caller, 'credential.txt'), expected)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ credentials: { keyCommands: { huggingface: 'cat credential.txt' } } }))
    check('a directory-dependent key command is captured where it was resolved', (await child('queue-command', caller)).captured, 'queueHostBank must run the keyCommands command in the caller directory and store the result as a captured reference; check src/models/hosting/jobCredentials.ts')
    check('the detached worker receives the command credential without rerunning it in another directory', (await child('command')).received, 'the worker must read the captured command credential instead of rerunning the command; check src/models/hosting/jobCredentials.ts')
    check('all captures created by these completed jobs have been removed', !existsSync(join(home, '.host-credentials')) || readdirSync(join(home, '.host-credentials')).length === 0, 'a capture file under .host-credentials was left behind; check removal in src/models/hosting/jobCredentials.ts and removeHostRecord in src/models/hosting/store.ts')
    console.log('BOUNDARY CREDENTIALS ' + (failures ? 'RED' : 'GREEN') + ' — ' + (checks - failures) + '/' + checks + '; synthetic credentials, actual spawned workers, no network')
  } finally { clearAuthScope(); delete process.env.HF_TOKEN; process.env.MERCURY_CONFIG_DIR = outer; rmSync(home, { recursive: true, force: true }) }
  process.exitCode = failures ? 1 : 0
}
