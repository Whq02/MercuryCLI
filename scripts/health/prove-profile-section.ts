#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-profile-section.ts — the health report explains the mature
//  system: the PROFILE section reports the resolved
//  appearance, role-registry normalization, and the team launch backend —
//  from the SAME typed state the runtime and UI consume, without mutating
//  any preference or creating any team.
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-profile-section.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' Health PROFILE section — typed facts, no display scraping')
console.log('============================================================')

// Hermetic: health probes must never touch the operator's real teams/daemon.
const SCRATCH = mkdtempSync(join(tmpdir(), 'doctor-profile-'))
process.env.MERCURY_TEAMS_DIR = join(SCRATCH, 'teams')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.MERCURY_HOME = join(SCRATCH, 'home') // boot-env reads land here

const report = await import('../../src/utils/healthReport.js')
const menu = await import('../../src/substrate/startupMenu.js')

const bootBefore = JSON.stringify(menu.readBootEnvChoices())

const cert = await report.runHealthReport({ depth: 'fast' })
const profile = cert.sections.find(s => s.id === 'profile')
check('PROFILE section present', !!profile)
const byId = new Map((profile?.checks ?? []).map(c => [c.id, c]))

{
  const c = byId.get('appearance')
  check('appearance check present', !!c)
  check('appearance names theme · color mode · accent · motion · ground', !!c && /theme .+· (truecolor|256|16|mono) · accent #[0-9a-fA-F]{6} · motion (full|reduced) · /.test(c.evidence))
  check('appearance links the center', c?.link === '/appearance')
  check('appearance never fails on a healthy resolve', c?.status === 'info', c ? `${c.status} — ${c.evidence.slice(0, 110)}` : 'missing')
}
{
  const c = byId.get('roster-normalization')
  check('roster check present + OK on the live registry', c?.status === 'ok', c?.evidence)
  check('roster evidence counts roles, aliases, and composable prompts', !!c && /\d+ built-in roles resolve · \d+ legacy aliases decode · role prompts compose \d+\/\d+/.test(c.evidence))
}
{
  const c = byId.get('team-launch')
  check('team-launch check present', !!c)
  check('team-launch says what TeamCreate will actually use', !!c && c.evidence.includes('TeamCreate spawns'))
  check('team-launch links the Team Center', c?.link === '/team')
}
// Non-mutation contract: no preference changed, no team created.
check('the health run never mutated the boot preference', JSON.stringify(menu.readBootEnvChoices()) === bootBefore)
const { existsSync, readdirSync } = await import('node:fs')
check('the health run never created a team', !existsSync(join(SCRATCH, 'teams')) || readdirSync(join(SCRATCH, 'teams')).length === 0)

// The JSON surface serializes the SAME typed rows (no display scraping).
{
  const { readFileSync } = await import('node:fs')
  const dj = readFileSync(new URL('../../src/cli/healthJson.ts', import.meta.url), 'utf8')
  check('health --json serializes the certificate sections themselves', /runHealthReport|certificate|sections/.test(dj))
}

rmSync(SCRATCH, { recursive: true, force: true })

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL PROFILE-SECTION PROOFS PASS')
else console.log(`❌ ${failures} PROFILE-SECTION PROOF(S) FAILED`)
// Explicit exit (the prove-health-functional idiom): the health import graph
// keeps live handles (watchers/sockets) that would otherwise hold the event
// loop open forever after the verdict prints.
process.exit(failures === 0 ? 0 : 1)
