#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const key of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME', 'OPENAI_API_KEY', 'MERCURY_USAGE_SEED']) delete process.env[key]
const HOME = mkdtempSync(join(tmpdir(), 'prove-concurrent-windows-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const REPO = join(import.meta.dir, '..', '..')
const SRC = join(REPO, 'src')

console.log('============================================================')
console.log(' PROVAUTH — two sessions on two sign-ins of one family keep separate usage windows')
console.log('============================================================')

const pocketBob = join(HOME, 'sign-ins', 'openai', 'bob@work.example')
mkdirSync(pocketBob, { recursive: true })
const tokens = (who: string): Record<string, unknown> => ({
  version: 1,
  tokens: { idToken: 'h.e30.s', accessToken: `${who}-access`, refreshToken: `${who}-refresh`, accountId: `acct-${who}`, email: `${who}@${who === 'alice' ? 'home' : 'work'}.example`, accessTokenExpiresAtMs: Date.now() + 3_600_000 },
  preferredSource: 'chatgpt-subscription',
})
writeFileSync(join(HOME, '.openai-auth.json'), JSON.stringify(tokens('alice')))
writeFileSync(join(pocketBob, '.openai-auth.json'), JSON.stringify(tokens('bob')))
writeFileSync(join(HOME, '.sign-ins.json'), JSON.stringify({ version: 1, signIns: { openai: { at: 1, kind: 'subscription' } }, entries: { openai: { 'alice@home.example': { at: 1, kind: 'subscription' }, 'bob@work.example': { at: 2, kind: 'subscription', pocket: 'bob@work.example' } } } }))

const child = `
;(globalThis).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const who = process.argv[2]
const pockets = await import(${JSON.stringify(join(SRC, 'utils/accounts/signInPockets.ts'))})
const openai = await import(${JSON.stringify(join(SRC, 'services/providers/openai/openaiAccounts.ts'))})
const limits = await import(${JSON.stringify(join(SRC, 'services/providers/openai/openaiLimitState.ts'))})
if (who === 'bob') pockets.setSessionSignIn('openai', { identity: 'bob@work.example', dir: ${JSON.stringify(pocketBob)}, kind: 'chatgpt-subscription' })
const identity = openai.openaiSourceIdentity('chatgpt-subscription')
limits.noteOpenaiSourceIdentity('chatgpt-subscription', identity)
limits.recordOpenaiUsageLimit(Date.now() + (who === 'bob' ? 7_200_000 : 1_800_000), 'chatgpt-subscription')
await new Promise(resolve => setTimeout(resolve, 400))
const window = limits.openaiLimitWindow('chatgpt-subscription')
console.log(JSON.stringify({ who, identity, account: openai.resolveOpenaiAccount()?.email, state: window.state, resetsAtMs: window.state === 'limited' ? window.resetsAtMs : null }))
`
const childPath = join(HOME, 'session.mjs')
writeFileSync(childPath, child)

const run = (who: string) => spawnSync(process.execPath, [childPath, who], { cwd: REPO, encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: HOME, MERCURY_CREDENTIAL_STORE: 'file' }, timeout: 60_000 })
const alice = run('alice')
const bob = run('bob')
const parse = (out: string): Record<string, unknown> => {
  const line = out.trim().split('\n').filter(l => l.startsWith('{')).pop() ?? '{}'
  return JSON.parse(line) as Record<string, unknown>
}
const a = parse(alice.stdout)
const b = parse(bob.stdout)
check('both sessions ran', alice.status === 0 && bob.status === 0, `${alice.stderr.slice(-300)} ${bob.stderr.slice(-300)}`)
check('each session resolves its own account', a.account === 'alice@home.example' && b.account === 'bob@work.example', JSON.stringify([a, b]))
check('the two sign-ins have different credential identities', typeof a.identity === 'string' && typeof b.identity === 'string' && a.identity !== b.identity)
check('each session is limited by its own window only', a.state === 'limited' && b.state === 'limited' && typeof a.resetsAtMs === 'number' && typeof b.resetsAtMs === 'number' && (b.resetsAtMs as number) - (a.resetsAtMs as number) > 3_000_000, JSON.stringify([a.resetsAtMs, b.resetsAtMs]))

console.log('§2 — in one session, moving the choice to the other sign-in never carries the first one\'s window along')
{
  const pockets = await import('../../src/utils/accounts/signInPockets.ts')
  const openai = await import('../../src/services/providers/openai/openaiAccounts.ts')
  const limits = await import('../../src/services/providers/openai/openaiLimitState.ts')
  limits.noteOpenaiSourceIdentity('chatgpt-subscription', openai.openaiSourceIdentity('chatgpt-subscription'))
  limits.recordOpenaiUsageLimit(Date.now() + 3_600_000, 'chatgpt-subscription')
  check('alice\'s window is limited', limits.openaiLimitWindow('chatgpt-subscription').state === 'limited')
  pockets.setSessionSignIn('openai', { identity: 'bob@work.example', dir: pocketBob, kind: 'chatgpt-subscription' })
  const moved = limits.noteOpenaiSourceIdentity('chatgpt-subscription', openai.openaiSourceIdentity('chatgpt-subscription'))
  check('the identity latch sees the other sign-in and forgets the first one\'s window', moved && limits.openaiLimitWindow('chatgpt-subscription').state !== 'limited')
  pockets.setSessionSignIn('openai', null)
  limits.noteOpenaiSourceIdentity('chatgpt-subscription', openai.openaiSourceIdentity('chatgpt-subscription'))
  check('back on alice the window is read fresh, never bob\'s', limits.openaiLimitWindow('chatgpt-subscription').state !== 'limited')
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ CONCURRENT WINDOWS GREEN' : `\n❌ CONCURRENT WINDOWS RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
