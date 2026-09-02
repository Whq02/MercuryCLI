#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-activity-verbs-producer.ts — the activity ledger's
//  verb counter has a producer (FC-137). The verb:<name> kind was declared
//  and never constructed anywhere, so a config home that had just answered
//  six mercury health invocations read verbs 0 · no headless activity
//  recorded. One commander preAction hook now stamps every subcommand
//  (nested spelled verb:parent:child); the bare default action stays
//  classified in print.ts.
//
//  §1 the ledger accepts and folds the kind (module drive).
//  §2 the BUILT artifact: repeated health verbs land in the row.
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-activity-verbs-producer.ts
//  (build dist/mercury.mjs first)
// ============================================================================
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'verbs-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')

console.log('§1 the ledger folds the verb kind')
{
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const ledger = await import('../../src/utils/activityLedger.ts')
  ledger.noteHeadlessActivity('verb:health')
  ledger.noteHeadlessActivity('verb:health')
  ledger.noteHeadlessActivity('verb:mcp:list')
  const a = ledger.getHeadlessActivity()
  check('two health stamps fold to verbs.health = 2', a.verbs['health'] === 2, JSON.stringify(a.verbs))
  check('a nested verb keeps its path spelling', a.verbs['mcp:list'] === 1, JSON.stringify(a.verbs))
  check('the last kind is recorded', a.lastKind === 'verb:mcp:list')
}

console.log('\n§2 the artifact records its own verbs')
{
  const DIST = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(DIST)) {
    check('dist/mercury.mjs exists (build first — this leg drives the artifact)', false)
  } else {
    const H2 = realpathSync(mkdtempSync(join(tmpdir(), 'verbs-live-')))
    const run = (args: string[]): string => {
      try {
        return execFileSync('node', [DIST, ...args], {
          env: { ...process.env, MERCURY_CONFIG_DIR: H2, NODE_ENV: undefined } as NodeJS.ProcessEnv,
          encoding: 'utf8',
          timeout: 60000,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (e) {
        return (e as { stdout?: string }).stdout ?? ''
      }
    }
    for (let i = 0; i < 3; i++) run(['health', '--only', 'build-identity', '--json'])
    const out = run(['health', '--only', 'activity', '--json'])
    let evidence = ''
    try {
      const cert = JSON.parse(out) as { sections: Array<{ checks: Array<{ id: string; evidence: string }> }> }
      evidence = cert.sections.flatMap(s => s.checks).find(c => c.id === 'activity')?.evidence ?? ''
    } catch {
      evidence = '(unparseable)'
    }
    const m = evidence.match(/verbs (\d+)/)
    check(
      'after four health invocations the row counts them (never verbs 0)',
      m !== null && Number(m[1]) >= 3,
      evidence,
    )
    check('the last-activity clause names the verb', evidence.includes('verb:health'), evidence)
  }
}

console.log(failures === 0 ? '\nprove-activity-verbs-producer: all green' : `\nprove-activity-verbs-producer: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
