#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-first-run-seed.ts — the ONE first-run seed approves the
//  key the capture's CHILD boots with (scripts/lib/firstRunSeed.ts).
//
// THE FIND: prove-split-view-look's
//  first real run stalled on "Detected a custom API key … use it?" — the seed
//  approved the SEEDER's ANTHROPIC_API_KEY (unset on the box; the CI gate's
//  proof key on the runner) while the prover handed its child
//  'fixture-key-000'; every gated send then sat undelivered behind the card.
//  Three look provers (split-view · broadcast · exit-everywhere) rode the
//  seed alone; the rest of the ~40 fixture-key captures each wrote their own
//  approval by hand.
//
//  LAWS: §1 a seeded home approves the canonical fixture key's tail (the
//  product's normalizeApiKeyForConfig shape: the last 20 chars) whether or
//  not the seeder carries a key; §2 the seeder's own key is approved beside
//  it, once; §3 ABSENT-ONLY holds — an existing config file is never touched
//  (no operator home ever carries the proof approval).
// ============================================================================
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const { seedFirstRun, FIXTURE_API_KEY } = await import('../lib/firstRunSeed.ts')
type Cfg = { customApiKeyResponses?: { approved?: string[]; rejected?: string[] }; hasCompletedOnboarding?: boolean }
const readCfg = (home: string): Cfg => JSON.parse(readFileSync(join(home, '.mercury.json'), 'utf8')) as Cfg

console.log('§1 the fixture key is approved with no key in the seeder env')
{
  const home = mkdtempSync(join(tmpdir(), 'first-run-seed-'))
  const saved = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  seedFirstRun(home, [home])
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
  const cfg = readCfg(home)
  check('the canonical fixture key tail is approved', (cfg.customApiKeyResponses?.approved ?? []).includes(FIXTURE_API_KEY.slice(-20)), JSON.stringify(cfg.customApiKeyResponses))
  check('the fixture key is the scripts-wide spelling', FIXTURE_API_KEY === 'fixture-key-000')
  check('the home is onboarded (the walk never covers a capture)', cfg.hasCompletedOnboarding === true)
  rmSync(home, { recursive: true, force: true })
}

console.log("§2 the seeder's own key is approved beside it, once")
{
  const home = mkdtempSync(join(tmpdir(), 'first-run-seed-'))
  const saved = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
  seedFirstRun(home, [home])
  const approved = readCfg(home).customApiKeyResponses?.approved ?? []
  check('both tails approved', approved.includes('proof-key-ci-gate-not-a-real-key'.slice(-20)) && approved.includes(FIXTURE_API_KEY.slice(-20)), JSON.stringify(approved))
  process.env.ANTHROPIC_API_KEY = FIXTURE_API_KEY
  const home2 = mkdtempSync(join(tmpdir(), 'first-run-seed-'))
  seedFirstRun(home2, [home2])
  const approved2 = readCfg(home2).customApiKeyResponses?.approved ?? []
  check('the same key on both sides is approved ONCE (no duplicate row)', approved2.length === 1 && approved2[0] === FIXTURE_API_KEY.slice(-20), JSON.stringify(approved2))
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = saved
  rmSync(home, { recursive: true, force: true })
  rmSync(home2, { recursive: true, force: true })
}

console.log('§3 absent-only: an existing config file is never touched')
{
  const home = mkdtempSync(join(tmpdir(), 'first-run-seed-'))
  mkdirSync(home, { recursive: true })
  const before = JSON.stringify({ theme: 'light', operator: true })
  writeFileSync(join(home, '.mercury.json'), before)
  seedFirstRun(home, [home])
  check('the operator-shaped file is byte-identical after the seed', readFileSync(join(home, '.mercury.json'), 'utf8') === before)
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nfirst-run seed: GREEN' : `\nfirst-run seed: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
