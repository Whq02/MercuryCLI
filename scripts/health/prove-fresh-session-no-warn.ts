#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-fresh-session-no-warn.ts — /status never warns
//  about a fresh session (FC-139). The System diagnostics block raised a
//  warn-toned banner on every newborn session — Context usage fresh
//  session — no usage yet — treating the context gauge's DOCUMENTED
//  normal pre-usage state as a degraded read, while the same screen
//  printed the same fact neutrally two rows above.
//
//  §1 the gauge's fresh state carries the exported reason constant.
//  §2 the driven facts: a fresh session composes NO diagnostic while the
//     Context row still names the state neutrally.
//  §3 the banner gate excludes exactly the documented state (call-shaped
//     — a genuinely degraded read still raises it).
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-fresh-session-no-warn.ts
// ============================================================================
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'freshwarn-home-')))
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const gauge = (await import('../../src/utils/cockpit/contextGauge.ts')) as unknown as {
  contextGauge: (messages: unknown[], model: string) => { state: string; reason?: string }
  CONTEXT_FRESH_SESSION_REASON?: string
}

console.log('§1 the documented state is an exported fact')
{
  check(
    'CONTEXT_FRESH_SESSION_REASON is exported',
    typeof gauge.CONTEXT_FRESH_SESSION_REASON === 'string',
  )
  const fresh = gauge.contextGauge([], 'claude-opus-5')
  check(
    'a fresh session reads unavailable with exactly that reason',
    fresh.state === 'unavailable' && fresh.reason === gauge.CONTEXT_FRESH_SESSION_REASON,
    `${fresh.state}: ${fresh.reason}`,
  )
}

console.log('\n§2 a fresh session composes NO diagnostic banner')
{
  const status = (await import('../../src/commands/status/mercuryStatus.tsx')) as unknown as {
    buildFacts?: (messages: unknown[], model: string) => {
      facts: Array<{ k: string; v: string }>
      diagnostic: string | undefined
    }
  }
  check('the composer is exported (buildFacts)', typeof status.buildFacts === 'function')
  const built = status.buildFacts?.([], 'claude-opus-5')
  check(
    'the diagnostic is undefined on the newborn session',
    built !== undefined && built.diagnostic === undefined,
    String(built?.diagnostic),
  )
  const ctx = built?.facts.find(f => f.k === 'Context')
  check(
    'the Context row still names the state neutrally',
    ctx !== undefined && ctx.v.includes('fresh session'),
    JSON.stringify(ctx),
  )
}

console.log('\n§3 a degraded read still raises the banner (call-shaped)')
{
  const src = readFileSync(join(ROOT, 'src', 'commands', 'status', 'mercuryStatus.tsx'), 'utf-8')
  check(
    'the gate excludes exactly the documented reason',
    src.includes("usage.state !== 'live' && usage.reason !== CONTEXT_FRESH_SESSION_REASON"),
  )
  check(
    'the degraded banner text survives for real degradation',
    src.includes('`Context usage ${usage.reason ?? ' + "'unavailable'}`"),
  )
}

console.log(failures === 0 ? '\nprove-fresh-session-no-warn: all green' : `\nprove-fresh-session-no-warn: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
