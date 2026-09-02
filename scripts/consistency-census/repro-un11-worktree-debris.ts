#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'unison-un11-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'unison-un11-home-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.MERCURY_CACHE_CLOCK
delete process.env.MERCURY_CACHE_TTL

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const repo = mkdtempSync(join(tmpdir(), 'unison-un11-repo-'))
git(repo, 'init', '-q', '-b', 'main')
git(repo, 'config', 'user.email', 'unison@fixture')
git(repo, 'config', 'user.name', 'unison')
writeFileSync(join(repo, 'README.md'), 'fixture\n')
git(repo, 'add', '.')
git(repo, 'commit', '-q', '-m', 'seed')
const headSha = git(repo, 'rev-parse', 'HEAD')
const lane = join(mkdtempSync(join(tmpdir(), 'unison-un11-lanes-')), 'lane-a')
git(repo, 'worktree', 'add', '-q', '-b', 'unison/lane-a', lane, 'HEAD')
check('§A lane created pristine', git(lane, 'status', '--porcelain') === '')

bootstrap.setOriginalCwd(lane)
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
const clock = await import('../../src/utils/cache/cacheClock.ts')
clock.resetCacheClockForTesting()
const t0 = Date.now()
runWithCwdOverride(lane, () => {
  clock.cacheClockTtlDecision({ eligible: true, lastCompletionAt: null, now: t0 })
  for (let i = 0; i < 3; i++) {
    clock.cacheClockObserve({
      cacheReadTokens: 100,
      cacheCreationTotal: 10,
      cacheCreation5m: 10,
      cacheCreation1h: 0,
      uncachedInputTokens: 5,
      now: t0 + i,
    })
  }
})
const rollupDir = join(lane, '.mercury', 'cache-clock', 'sessions')
const flushed = existsSync(rollupDir) && readdirSync(rollupDir).some(f => f.endsWith('.json'))
check('§B rollup flushed INSIDE the lane', flushed, rollupDir)

const { hasWorktreeChanges } = await import('../../src/utils/worktree.ts')
const dirty = await hasWorktreeChanges(lane, headSha)
check('§C REPRODUCED: pristine-authored lane blocked by Mercury bookkeeping', dirty === true)

console.log(
  failed === 0
    ? '\n REPRODUCED — UN-11/13 red recorded (runtime debris blocks settlement)'
    : '\n NOT REPRODUCED',
)
process.exit(failed === 0 ? 0 : 1)
