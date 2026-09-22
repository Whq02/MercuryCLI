#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally, transcriptFiles } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type ScriptedTurn, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-worktree-hop-cwd-drive')
const KEEP = process.argv.includes('--keep')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'worktree-hop-cwd-')))
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

const ASK = 'worktree-hop-probe'
const LANE = 'hop-lane'
const RESET_NOTICE = 'Shell cwd was reset to'

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
const repo = join(scratch, 'repo')
mkdirSync(repo)
git(repo, 'init', '-q', '-b', 'main')
writeFileSync(join(repo, 'README.md'), '# fixture\n')
writeFileSync(join(repo, '.gitignore'), '.mercury/\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-q', '-m', 'first')
const lane = join(repo, '.mercury', 'worktrees', LANE)

const firstLine = (r: SeenResult | undefined): string => (r?.text ?? '').split('\n')[0]!.trim()
const show = (label: string, r: SeenResult | undefined, turn: ScriptedTurn): void => {
  console.log(`\n── ${label} ──`)
  if (!r) {
    console.log(`│ (no tool result reached the wire; run exit ${turn.exitCode ?? '?'}: ${turn.stderr.slice(-400)})`)
    return
  }
  console.log(`│ is_error: ${r.isError}`)
  for (const line of r.text.split('\n').slice(0, 8)) console.log(`│ ${line}`)
}

const seen: Record<string, SeenResult | undefined> = {}
const fixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  const last = req.results[req.results.length - 1]
  switch (req.step) {
    case 0:
      return [{ type: 'tool_use', name: 'EnterWorktree', input: { name: LANE } }]
    case 1:
      seen.enter = last
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd', description: 'the first shell command after the hop' } }]
    case 2:
      seen.afterEnter = last
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd', description: 'the second shell command after the hop' } }]
    case 3:
      seen.afterEnterSecond = last
      return [{ type: 'tool_use', name: 'ExitWorktree', input: { action: 'keep' } }]
    case 4:
      seen.exit = last
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd', description: 'the first shell command after the exit' } }]
    default:
      if (req.step === 5) seen.afterExit = last
      return [{ type: 'text', text: 'done' }]
  }
})
let turn: ScriptedTurn = { result: null, exitCode: null, stderr: '' }
try {
  turn = await runScriptedTurn({ runHome: join(scratch, 'home'), cwd: repo, base: fixture.base, ask: ASK, timeoutMs: 240_000, extraArgv: ['--dangerously-bypass-permissions'] })
} finally {
  await fixture.close()
}

show('the EnterWorktree call', seen.enter, turn)
show('the first shell command after the hop', seen.afterEnter, turn)
show('the second shell command after the hop', seen.afterEnterSecond, turn)
show('the ExitWorktree call', seen.exit, turn)
show('the first shell command after the exit', seen.afterExit, turn)

tally.section('the hop: the very next shell command runs in the worktree')
tally.check('EnterWorktree created the worktree under the repository worktrees home', seen.enter !== undefined && !seen.enter.isError && seen.enter.text.includes(`Created worktree ${lane}`), seen.enter?.text.slice(0, 300))
tally.check('the first shell command after the hop ran in the worktree', firstLine(seen.afterEnter) === lane, `ran in ${JSON.stringify(firstLine(seen.afterEnter))}, the worktree is ${lane}`)
tally.check('the first shell command after the hop carried no working-directory reset notice', seen.afterEnter !== undefined && !seen.afterEnter.text.includes(RESET_NOTICE), seen.afterEnter?.text.slice(0, 300))
tally.check('the second shell command after the hop ran in the worktree', firstLine(seen.afterEnterSecond) === lane, firstLine(seen.afterEnterSecond))

tally.section('the exit: the very next shell command runs in the checkout')
tally.check('ExitWorktree kept the worktree and returned the session to the checkout', seen.exit !== undefined && !seen.exit.isError && seen.exit.text.includes(`The session is back in ${repo}`), seen.exit?.text.slice(0, 300))
tally.check('the first shell command after the exit ran in the checkout', firstLine(seen.afterExit) === repo, `ran in ${JSON.stringify(firstLine(seen.afterExit))}, the checkout is ${repo}`)
tally.check('the first shell command after the exit carried no working-directory reset notice', seen.afterExit !== undefined && !seen.afterExit.text.includes(RESET_NOTICE), seen.afterExit?.text.slice(0, 300))
tally.check('the run settled with a result', turn.result !== null, turn.stderr.slice(-300))

tally.section('the session records name the branch of their working directory')
const stamps = transcriptFiles(join(scratch, 'home', 'projects')).flatMap(file => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { annotations?: { cwd?: string; gitBranch?: string } })).map(row => row.annotations).filter(row => row?.cwd !== undefined)
const inWorktree = stamps.filter(row => row!.cwd === lane)
const branch = git(lane, 'branch', '--show-current')
tally.check('records written in the worktree carry its branch', inWorktree.length > 0 && inWorktree.every(row => row!.gitBranch === branch), JSON.stringify(inWorktree))
const last = stamps.at(-1)
tally.check('the final record is back on the checkout branch', last?.cwd === repo && last.gitBranch === 'main', JSON.stringify(last))

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
