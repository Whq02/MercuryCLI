#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, bootRunner, bound, childEnv, isOutcome, makeTally } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type Script } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-git-plan-provenance-headless')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist`)
  tally.finish()
}
console.log(`  build under proof: ${DIST}`)
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'git-plan-provenance-')))
const runHome = join(root, 'home')
const cwd = join(root, 'work')
seedScratchHome(runHome, cwd)
const git = (args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@local', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@local' } })
git(['init', '--quiet', '--initial-branch=main'])
writeFileSync(join(cwd, 'README.md'), '# seed\n')
git(['add', 'README.md'])
git(['commit', '--quiet', '-m', 'seed'])
writeFileSync(join(cwd, 'outside.txt'), 'written by the operator, not this session\n')

const script: Script = req => {
  if (req.step === 0) return [{ type: 'tool_use', name: 'Write', input: { file_path: join(cwd, 'notes.md'), content: 'written by Mercury this session\n' } }]
  if (req.step === 1) return [{ type: 'tool_use', name: 'Git', input: { op: 'plan', groups: [{ files: ['notes.md'], message: 'add the notes' }] } }]
  return [{ type: 'text', text: 'planned' }]
}
const fixture = await startScriptedFixture(script)
const port = Number(new URL(fixture.base).port)
const runner = bootRunner({ cwd, env: childEnv(runHome, port) })
await runner.host.request('queue/add', { type: 'prompt', content: 'write the notes and plan the commit', id: randomUUID() }, bound(60_000))
const outcome = await runner.waitFor('the turn settles', isOutcome, bound(90_000))
tally.check('the headless turn settled', outcome !== null && outcome.status === 'completed', JSON.stringify(outcome).slice(0, 200))
const planResult = fixture.requests.flatMap(r => r.results).map(x => x.text).find(t => t.includes('[proposed]')) ?? ''
tally.check('the Git plan was prepared on the file this session wrote', planResult.includes('notes.md') && planResult.includes('[proposed]'), planResult.slice(0, 300))
tally.check('a file this session wrote is never called external', !planResult.includes('notes.md [EXTERNAL]'), planResult)
tally.check('no CAUTION about work Mercury did not write rides a plan of its own Write', !planResult.includes('CAUTION: group(s) include work Mercury did not write this session'), planResult)
tally.check('the operator file stays an exclusion, uncommitted', planResult.includes('exclusions (stay uncommitted): outside.txt'), planResult)
await runner.stop(bound(5_000))
await fixture.close()
rmSync(root, { recursive: true, force: true })
tally.finish()
