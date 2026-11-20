#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.env.BUN ?? (process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun'))
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')

function runScenario(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn17-')))
  const home = join(scratch, 'home')
  mkdirSync(home, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    const SRC = ${JSON.stringify(SRC)}
    const HOME = ${JSON.stringify(home)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  const res = spawnSync(BUN, ['-e', src], {
    encoding: 'utf8',
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file' },
  })
  if (res.status !== 0) throw new Error(`scenario exited ${res.status}: ${res.stderr.slice(-1200)}`)
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
}

console.log('anthropicUsageState — dropIfAccountMoved lets reset bugs throw')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const authPath = SRC + '/utils/auth.ts'
    const realAuth = await import(authPath)
    mock.module(authPath, () => ({
      ...realAuth,
      dropCredentialMemos: () => { throw new Error('memo-reset-boom') },
    }))
    const state = await import(SRC + '/services/providers/anthropic/anthropicUsageState.ts')
    try {
      await state.refreshAnthropicUsage({ reason: 'sign-in' })
      out.threw = null
    } catch (e) {
      out.threw = e instanceof Error ? e.message : String(e)
    }
  `)
  check('anthropicUsageState:dropCredentialMemos throws on sign-in reset bug', r.threw === 'memo-reset-boom', `got ${JSON.stringify(r.threw)}`)
}
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const authPath = SRC + '/utils/auth.ts'
    const limitsPath = SRC + '/services/anthropicLimits.ts'
    const realAuth = await import(authPath)
    const realLimits = await import(limitsPath)
    mock.module(authPath, () => ({
      ...realAuth,
      dropCredentialMemos: () => {},
      getClaudeAIOAuthTokens: () => ({ accessToken: 'tok-switched-account', refreshToken: null, expiresAt: null, scopes: [] }),
    }))
    mock.module(limitsPath, () => ({
      ...realLimits,
      resetLimitsForCredentialSwitch: () => { throw new Error('limits-reset-boom') },
    }))
    const state = await import(SRC + '/services/providers/anthropic/anthropicUsageState.ts')
    try {
      await state.refreshAnthropicUsage({ reason: 'sign-in' })
      out.threw = null
    } catch (e) {
      out.threw = e instanceof Error ? e.message : String(e)
    }
  `)
  check('anthropicUsageState:resetLimitsForCredentialSwitch throws on sign-in reset bug', r.threw === 'limits-reset-boom', `got ${JSON.stringify(r.threw)}`)
}

console.log('modelRefusal — readModelRefusals throws on unreadable directory instead of answering empty')
{
  const r = runScenario(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const mod = await import(SRC + '/services/providers/anthropic/modelRefusal.ts')
    out.absentStanding = mod.standingModelRefusals().length
    out.absentForget = mod.forgetModelRefusals(HOME)
    const dir = path.join(HOME, 'model-refusals')
    fs.writeFileSync(dir, 'not-a-directory')
    try {
      mod.standingModelRefusals()
      out.standingCode = null
    } catch (e) {
      out.standingCode = e?.code ?? String(e)
    }
    try {
      mod.forgetModelRefusals(HOME)
      out.forgetCode = null
    } catch (e) {
      out.forgetCode = e?.code ?? String(e)
    }
  `)
  check(
    'modelRefusal:readModelRefusals throws on non-ENOENT directory error and returns empty on ENOENT',
    r.absentStanding === 0 && r.absentForget === 0 && r.standingCode === 'ENOTDIR' && r.forgetCode === 'ENOTDIR',
    JSON.stringify(r),
  )
}

console.log('prefixLedger — ownsSessionRecord lets processMainOwner bugs throw')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const ownerPath = SRC + '/services/run/resolveOwner.ts'
    const realOwner = await import(ownerPath)
    mock.module(ownerPath, () => ({
      ...realOwner,
      processMainOwner: () => { throw new Error('owner-getter-boom') },
    }))
    const ledger = await import(SRC + '/services/providers/anthropic/prefixLedger.ts')
    try {
      ledger.persistedDropState('owner-a')
      out.threw = null
    } catch (e) {
      out.threw = e instanceof Error ? e.message : String(e)
    }
  `)
  check('prefixLedger:ownsSessionRecord throws on processMainOwner bug', r.threw === 'owner-getter-boom', `got ${JSON.stringify(r.threw)}`)
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
