#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' OpenAI auth persistence under multi-process rotation')
console.log('============================================================')

const savedEnv: Record<string, string | undefined> = {}
for (const key of ['OPENAI_API_KEY', 'MERCURY_CONFIG_DIR', 'MERCURY_AUTH_SCOPE_DIR']) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-openai-auth-'))

const accounts = await import('../../src/services/providers/openai/openaiAccounts.js')
const { currentSubscriptionTokens, openaiAuthPathForDisplay, __resetOpenaiAccountsForTest } = accounts

const authPath = openaiAuthPathForDisplay()
const lockPath = `${authPath}.refresh-lock`

function fakeJwt(expMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString('base64url')
  return `h.${payload}.s`
}

function seedAuthFile(o: { refreshToken: string; accessExpMs: number; extra?: Record<string, unknown> }): void {
  writeFileSync(
    authPath,
    JSON.stringify(
      {
        version: 1,
        ...(o.extra ?? {}),
        tokens: {
          idToken: 'h.e30.s',
          accessToken: fakeJwt(o.accessExpMs),
          refreshToken: o.refreshToken,
          accessTokenExpiresAtMs: o.accessExpMs,
        },
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
}

function diskTokens(): { refreshToken?: string; accessTokenExpiresAtMs?: number } {
  return (JSON.parse(readFileSync(authPath, 'utf8')) as { tokens?: Record<string, unknown> }).tokens ?? {}
}

function rotatingFetch(counter: { posts: number }, nextRt: string): typeof fetch {
  return (async () => {
    counter.posts++
    const exp = Date.now() + 60 * 60_000
    return new Response(
      JSON.stringify({ id_token: 'h.e30.s', access_token: fakeJwt(exp), refresh_token: nextRt }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
}

const throwingFetch: typeof fetch = (async () => {
  throw new Error('prover: network must not be touched on this leg')
}) as unknown as typeof fetch

{
  __resetOpenaiAccountsForTest()
  seedAuthFile({ refreshToken: 'RT1', accessExpMs: Date.now() - 1000, extra: { foreignKey: 'preserved' } })
  const counter = { posts: 0 }
  const tokens = await currentSubscriptionTokens({ fetchImpl: rotatingFetch(counter, 'RT2') })
  check('stale store refreshes exactly ONCE', counter.posts === 1)
  check('rotated refresh token returned', tokens?.refreshToken === 'RT2')
  check('rotation persisted to disk', diskTokens().refreshToken === 'RT2')
  const mode = statSync(authPath).mode & 0o777
  check('store stays mode 600', mode === 0o600, `mode ${mode.toString(8)}`)
  const file = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>
  check('unknown keys preserved across the rotation write', file.foreignKey === 'preserved')
  check('refresh lock released', !existsSync(lockPath))
}

{
  __resetOpenaiAccountsForTest()
  seedAuthFile({ refreshToken: 'RT3', accessExpMs: Date.now() + 60 * 60_000 })
  const tokens = await currentSubscriptionTokens({ fetchImpl: throwingFetch })
  check('fresh disk tokens adopted without any refresh POST', tokens?.refreshToken === 'RT3')
}

{
  __resetOpenaiAccountsForTest()
  seedAuthFile({ refreshToken: 'RT4', accessExpMs: Date.now() - 1000 })
  writeFileSync(lockPath, `99999 ${Date.now()}\n`, { mode: 0o600 })
  setTimeout(() => {
    seedAuthFile({ refreshToken: 'RT5', accessExpMs: Date.now() + 60 * 60_000 })
    try {
      require('node:fs').unlinkSync(lockPath)
    } catch {
    }
  }, 400)
  const tokens = await currentSubscriptionTokens({ fetchImpl: throwingFetch })
  check("lock loser adopts the winner's rotation (zero POSTs)", tokens?.refreshToken === 'RT5')
}

{
  __resetOpenaiAccountsForTest()
  seedAuthFile({ refreshToken: 'RT6', accessExpMs: Date.now() - 1000 })
  writeFileSync(lockPath, `99999 ${Date.now() - 120_000}\n`, { mode: 0o600 })
  const counter = { posts: 0 }
  const tokens = await currentSubscriptionTokens({ fetchImpl: rotatingFetch(counter, 'RT7') })
  check('stale lock taken over — refresh proceeds', counter.posts === 1 && tokens?.refreshToken === 'RT7')
  check('takeover leaves no lock behind', !existsSync(lockPath))
}

{
  __resetOpenaiAccountsForTest()
  seedAuthFile({ refreshToken: 'RT8', accessExpMs: Date.now() - 1000 })
  const midFlightWinnerFetch: typeof fetch = (async () => {
    seedAuthFile({ refreshToken: 'RT9', accessExpMs: Date.now() + 60 * 60_000 })
    throw new Error('prover: simulated refresh failure')
  }) as unknown as typeof fetch
  const tokens = await currentSubscriptionTokens({ fetchImpl: midFlightWinnerFetch })
  check("failed refresh returns the store's newer rotation, not the stale snapshot", tokens?.refreshToken === 'RT9')
}

{
  __resetOpenaiAccountsForTest()
  require('node:fs').rmSync(authPath, { force: true })
  const tokens = await currentSubscriptionTokens({ fetchImpl: throwingFetch })
  check('no stored subscription ⇒ undefined (never a throw)', tokens === undefined)
}

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('============================================================')
if (failures > 0) {
  console.error(`❌ ${failures} auth-persistence proof(s) failed`)
  process.exit(1)
}
console.log('✅ OPENAI AUTH PERSISTENCE PROVEN (multi-process rotation discipline)')
