#!/usr/bin/env bun

import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const { seedFirstRun, FIXTURE_API_KEY, GATE_API_KEY } = await import('../lib/firstRunSeed.ts')
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
  check('the same key on both sides is approved ONCE (no duplicate row), beside the gate key the seed always approves', approved2.length === 2 && approved2[0] === FIXTURE_API_KEY.slice(-20) && approved2[1] === GATE_API_KEY.slice(-20), JSON.stringify(approved2))
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = saved
  rmSync(home, { recursive: true, force: true })
  rmSync(home2, { recursive: true, force: true })
}

console.log('§3 absent-only: an existing config file is never touched')
{
  const home = mkdtempSync(join(tmpdir(), 'first-run-seed-'))
  mkdirSync(home, { recursive: true })
  const before = JSON.stringify({ theme: 'not-a-theme', operator: true })
  writeFileSync(join(home, '.mercury.json'), before)
  seedFirstRun(home, [home])
  check('the operator-shaped file is byte-identical after the seed', readFileSync(join(home, '.mercury.json'), 'utf8') === before)
  rmSync(home, { recursive: true, force: true })
}

console.log('§4 a capture cwd reached through a symlink is trusted under the spelling the product keys (its real path)')
{
  const base = mkdtempSync(join(tmpdir(), 'first-run-seed-'))
  const real = join(base, 'real-project')
  mkdirSync(real, { recursive: true })
  const link = join(base, 'link-to-project')
  symlinkSync(real, link)
  const home = join(base, 'home')
  seedFirstRun(home, [link])
  const projects = (JSON.parse(readFileSync(join(home, '.mercury.json'), 'utf8')) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }).projects ?? {}
  check('the raw spelling is trusted', projects[link]?.hasTrustDialogAccepted === true, Object.keys(projects).join(' · '))
  check('the real path is trusted too (process.cwd() under /var/folders reads /private/var/folders — the trust walk keys the real path)', projects[realpathSync(link)]?.hasTrustDialogAccepted === true, Object.keys(projects).join(' · '))
  check('a folder that is its own real path is keyed once', Object.keys(projects).filter(key => key === real || key === realpathSync(real)).length <= 1, Object.keys(projects).join(' · '))
  rmSync(base, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nfirst-run seed: GREEN' : `\nfirst-run seed: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
