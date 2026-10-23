#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const FIXTURE = 'zz-SECRETBYTES-0f9e8d7c6b5a4321'
const scratch = mkdtempSync(join(tmpdir(), 'proof-home-wall-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'proof-home')
let checks = 0
const check = (label: string, ok: unknown, detail = ''): void => {
  assert(ok, `${label}${detail ? ` — ${detail}` : ''}`)
  checks++
  console.log(`PASS ${label}`)
}

type Outcome = {
  threw: boolean
  message: string
  code: string
  login?: { ok: boolean; stored: boolean; receipt: string }
  host?: { threw: boolean; message: string }
  auth?: { threw: boolean; message: string }
  readBack?: string
  proof: string | null
}

const childSource = `
const secrets = await import(${JSON.stringify(join(ROOT, 'src/services/providers/providerSecrets.ts'))})
const { storeHuggingfaceTokenLogin } = await import(${JSON.stringify(join(ROOT, 'src/services/providers/huggingface/huggingfaceLogin.ts'))})
let proofProcessName = () => undefined
try { ({ proofProcessName } = await import(${JSON.stringify(join(ROOT, 'src/utils/proofHomeGuard.ts'))})) } catch {}
const key = process.argv[2]
const mode = process.argv[3]
const out = { threw: false, message: '', code: '', proof: proofProcessName() ?? null }
try {
  secrets.writeStoredHuggingfaceApiKey(key)
  out.readBack = secrets.readStoredHuggingfaceApiKey()
} catch (error) {
  out.threw = true
  out.message = String(error && error.message || error)
  out.code = String(error && error.code || '')
}
if (mode === 'all') {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const env = { MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID: 'c', MERCURY_HUGGINGFACE_HUB_BASE: 'https://hub.test' }
  const login = await storeHuggingfaceTokenLogin(key, { env, fetchImpl: async () => json(200, { name: 'op' }) }, async () => null)
  out.login = { ok: login.ok, stored: login.stored, receipt: login.receipt }
  const home = process.env.MERCURY_CONFIG_DIR || (process.env.HOME + '/.mercury')
  try { secrets.writeHostCredential(home, '0f9e8d7c-6b5a-4321-8f9e-0f9e8d7c6b5a', key); out.host = { threw: false, message: '' } } catch (error) { out.host = { threw: true, message: String(error && error.message || error) } }
  try { secrets.publishAuthScopedJson('.huggingface-auth.json', file => ({ ...file, accessToken: key })); out.auth = { threw: false, message: '' } } catch (error) { out.auth = { threw: true, message: String(error && error.message || error) } }
}
console.log(JSON.stringify(out))
`
const marked = join(scratch, 'prove-child-writer.ts')
const unmarked = join(scratch, 'child-writer.ts')
writeFileSync(marked, childSource)
writeFileSync(unmarked, childSource)

function run(script: string, env: Record<string, string | undefined>, mode = 'key'): Outcome {
  const account = mkdtempSync(join(scratch, 'account-'))
  const base: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: account, USERPROFILE: account, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none' }
  const child: Record<string, string> = { ...base }
  for (const [name, value] of Object.entries(env)) if (value !== undefined) child[name] = value.replace('{account}', account)
  const result = spawnSync(process.execPath, ['run', script, FIXTURE, mode], { encoding: 'utf8', env: child, cwd: scratch })
  assert.equal(result.status, 0, `${script}: ${result.stderr}`)
  const line = result.stdout.trim().split('\n').pop() ?? ''
  const out = JSON.parse(line) as Outcome
  const store = join(account, '.mercury', '.provider-secrets.json')
  return Object.assign(out, { account, storeExists: existsSync(store) })
}

try {
  {
    const r = run(marked, {}) as Outcome & { account: string; storeExists: boolean }
    check('a prove-* script with no pin at all (the account home resolves) is refused by the provider secrets writer', r.threw && r.code === 'EPROOFHOME', r.message)
    check('the refusal names the proof and the home, never the key', r.message.includes('prove-child-writer.ts') && r.message.includes(join(r.account, '.mercury')) && !r.message.includes(FIXTURE), r.message)
    check('nothing landed in the account store', !r.storeExists && !existsSync(join(r.account, '.mercury')))
    check('the process reads itself as that proof', r.proof === 'prove-child-writer.ts', String(r.proof))
  }
  {
    const r = run(marked, { MERCURY_CONFIG_DIR: '{account}/.mercury' }, 'all') as Outcome & { account: string; storeExists: boolean }
    check("a prove-* script whose shell pins the account's own home (the lane-seat shape of 2026-09-07) is refused", r.threw && r.code === 'EPROOFHOME', r.message)
    check('the login driver reports the refusal honestly: not stored, the receipt names the proof and carries no token bytes', r.login?.ok === false && r.login.stored === false && r.login.receipt.includes('prove-child-writer.ts') && !r.login.receipt.includes('SECRETBYTES'), r.login?.receipt)
    check('the host-credential writer refuses the same home', r.host?.threw === true && r.host.message.includes('a host credential'), r.host?.message)
    check('the auth-file writer refuses the same home', r.auth?.threw === true && r.auth.message.includes('.huggingface-auth.json'), r.auth?.message)
    check('the account home holds no store, no host credential and no auth file', !existsSync(join(r.account, '.mercury')))
  }
  {
    const account = mkdtempSync(join(scratch, 'account-'))
    mkdirSync(join(account, '.mercury'))
    const alias = join(scratch, `alias-${readdirSync(scratch).length}`)
    symlinkSync(join(account, '.mercury'), alias, 'dir')
    const base: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: account, USERPROFILE: account, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_CONFIG_DIR: alias }
    const result = spawnSync(process.execPath, ['run', marked, FIXTURE, 'key'], { encoding: 'utf8', env: base, cwd: scratch })
    const out = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}') as Outcome
    check('a pin that reaches the account home through a symlink is refused too', out.threw && out.code === 'EPROOFHOME', out.message)
    check('nothing landed behind the symlink', readdirSync(join(account, '.mercury')).length === 0)
  }
  {
    const r = run(marked, { MERCURY_CONFIG_DIR: '{account}/.mercury/nested/scope' }) as Outcome & { account: string }
    check('a pin inside the account home is still the account home', r.threw && r.code === 'EPROOFHOME', r.message)
  }
  {
    const r = run(marked, { MERCURY_CONFIG_DIR: join(scratch, 'own-home') }) as Outcome & { account: string; storeExists: boolean }
    check('the same proof under a scratch home of its own writes and reads back', !r.threw && r.readBack === FIXTURE, r.message)
    check('the write landed in the scratch home, not the account', existsSync(join(scratch, 'own-home', '.provider-secrets.json')) && !r.storeExists)
  }
  {
    const r = run(marked, { MERCURY_CONFIG_DIR: `${join(scratch, 'own-home')}-sibling` }) as Outcome
    check('a sibling that merely shares the prefix of the account home is not the account home', !r.threw, r.message)
  }
  {
    const r = run(unmarked, { MERCURY_PROOF: '1' }) as Outcome & { account: string; storeExists: boolean }
    check("a child under another name carrying the suite runner's mark (MERCURY_PROOF=1) is refused", r.threw && r.code === 'EPROOFHOME' && r.message.includes('child-writer.ts'), r.message)
    check('nothing landed', !r.storeExists)
  }
  {
    const r = run(unmarked, { MERCURY_PROOF: 'prove-host-bank-drive.ts' }) as Outcome
    check('a mark that names the proof is reported by that name', r.threw && r.message.startsWith('prove-host-bank-drive.ts must not write'), r.message)
  }
  {
    const r = run(unmarked, { MERCURY_PROOF: '0' }) as Outcome & { storeExists: boolean }
    check('MERCURY_PROOF=0 is no mark: an unmarked child is an ordinary run', !r.threw && r.proof === null && r.storeExists, r.message)
  }
  {
    const r = run(unmarked, {}) as Outcome & { storeExists: boolean }
    check('an ordinary run (no mark, no prove-* name) is never refused: the wall is for proofs only', !r.threw && r.readBack === FIXTURE && r.storeExists, r.message)
  }
  {
    const runner = Bun.file(join(ROOT, 'scripts/gate/run-suite.sh'))
    const text = await runner.text()
    check('the suite runner marks every child it starts (MERCURY_PROOF, an inherited value honoured)', /^export MERCURY_PROOF="\$\{MERCURY_PROOF:-1\}"$/m.test(text))
    const secrets = await Bun.file(join(ROOT, 'src/services/providers/providerSecrets.ts')).text()
    const doors = (secrets.match(/refuseProofWriteIntoAccountStore\(/g) ?? []).length
    check('the three credential doors in providerSecrets.ts (the secrets store, a host credential, an auth file) each call the wall', doors === 3, String(doors))
  }
  console.log(`PASS the credential writers refuse a proof's write into the account's own home (${checks} checks)`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
