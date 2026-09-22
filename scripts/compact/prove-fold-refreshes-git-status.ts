#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'fold-git-status-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section("§1 pure: the main fold clears the git-status, system-context and user-context memos; a helper lane's fold leaves them")
{
  const { getGitStatus, getSystemContext, getUserContext } = await import('../../src/context.ts')
  const { runPostCompactCleanup } = await import('../../src/services/compact/postCompactCleanup.ts')
  await getGitStatus()
  await getSystemContext()
  await getUserContext()
  const held = (): string =>
    [getGitStatus.cache.has(undefined) ? 'git' : '', getSystemContext.cache.has(undefined) ? 'system' : '', getUserContext.cache.has(undefined) ? 'user' : ''].filter(Boolean).join('+') || 'none'
  check('a composition memoizes the git status, the system context and the user context', held() === 'git+system+user', held())
  runPostCompactCleanup({ querySource: 'agent:probe', agentId: 'probe' })
  check("a helper lane's fold leaves the main conversation's memos in place", held() === 'git+system+user', held())
  runPostCompactCleanup()
  check('the main fold clears all three, so the next request composes the current git status', held() === 'none', held())
}

section('§2 the built product: after a fold the next request carries the current git status, not the start-of-conversation snapshot')
{
  const { DIST, bootRunner, bound, childEnv, isResult, user } = await import('../daemon/dupline-world.ts')
  const { seedScratchHome, startScriptedFixture } = await import('../lib/scriptedTurn.ts')
  if (!existsSync(DIST)) {
    console.log(`  [SKIP] ${DIST} absent — build first or pass --dist`)
  } else {
    console.log(`  build under proof: ${DIST}`)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fold-git-status-drive-')))
    const runHome = join(root, 'home')
    const cwd = join(root, 'work')
    seedScratchHome(runHome, cwd)
    const git = (...args: string[]): void => {
      const r = spawnSync('git', ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' })
      if (r.status !== 0) console.log(`  git ${args[0]} rc=${r.status}: ${r.stderr.toString().trim().slice(0, 160)}`)
    }
    git('init', '-q')
    writeFileSync(join(cwd, 'README.md'), 'the seed\n')
    git('add', 'README.md')
    git('commit', '-q', '-m', 'seed')
    const FRESH = 'born-after-turn-one.txt'
    const fixture = await startScriptedFixture(() => [{ type: 'text', text: 'answered' }])
    const port = Number(new URL(fixture.base).port)
    const runner = bootRunner({ cwd, env: childEnv(runHome, port) })
    const turn = async (label: string, ask: string): Promise<Record<string, unknown> | null> => {
      const from = runner.frames.length
      runner.send(user(ask, randomUUID()))
      return runner.waitFor(label, isResult, bound(90_000), from)
    }
    const first = await turn('turn 1', 'first turn of the fold probe')
    check('turn 1 settled', first?.subtype === 'success', JSON.stringify(first).slice(0, 160))
    const second = await turn('turn 2', 'second turn of the fold probe')
    check('turn 2 settled', second?.subtype === 'success', JSON.stringify(second).slice(0, 160))
    writeFileSync(join(cwd, FRESH), 'born after turn one\n')
    const framesBeforeFold = runner.frames.length
    const folded = await turn('the fold', '/compact')
    check('the fold settled (a result frame followed /compact)', folded !== null, JSON.stringify(folded).slice(0, 160))
    const boundary = runner.frames.slice(framesBeforeFold).find(f => f.type === 'system' && f.subtype === 'compact_boundary')
    check('the stream carried the fold boundary', boundary !== undefined, runner.frames.slice(framesBeforeFold).map(f => `${String(f.type)}${f.subtype ? ':' + String(f.subtype) : ''}`).join(' '))
    const third = await turn('turn 3', 'third turn of the fold probe, after the fold')
    check('turn 3 settled', third?.subtype === 'success', JSON.stringify(third).slice(0, 160))
    await runner.stop(bound(5_000))
    await fixture.close()
    const firstSystem = fixture.requests[0]?.system ?? ''
    const lastSystem = fixture.requests.at(-1)?.system ?? ''
    check('turn 1 carried the git status block, without the file born later', firstSystem.includes('Current branch') && !firstSystem.includes(FRESH), `block ${firstSystem.includes('Current branch')} · file ${firstSystem.includes(FRESH)}`)
    check('the request after the fold carries the current git status: the file born after turn 1 is listed', lastSystem.includes(FRESH), lastSystem.includes('Current branch') ? 'the block still shows the start-of-conversation snapshot' : 'no git status block at all')
    console.log(`  requests ${fixture.requests.length}; those listing ${FRESH}: ${fixture.requests.filter(r => r.system.includes(FRESH)).length}; stderr tail: ${runner.stderr().trim().split('\n').slice(-2).join(' | ').slice(0, 200)}`)
    rmSync(root, { recursive: true, force: true })
  }
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
