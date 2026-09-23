#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-workflow-run-filed-under-workspace')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)

const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'workflow-run-filed-')))
const runHome = join(scratch, 'home')
const work = join(scratch, 'work')
const sub = join(work, 'sub')
mkdirSync(sub, { recursive: true })
writeFileSync(join(work, 'README.md'), '# fixture\n')
writeFileSync(join(sub, 'README.md'), '# a folder below the session folder\n')

const ASK = 'step into the folder below, then start a workflow'
const WF_SCRIPT = [
  "export const meta = { name: 'filed-run', description: 'a run with no agents, launched after the shell moved' }",
  "return 'filed'",
].join('\n')
let bashResult = ''
const fixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  switch (req.step) {
    case 0:
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'cd sub && pwd', description: 'move the shell one folder down' } }]
    case 1:
      bashResult = req.results[0]?.text ?? ''
      return [{ type: 'tool_use', name: 'Workflow', input: { script: WF_SCRIPT } }]
    default:
      return [{ type: 'text', text: 'done' }]
  }
})

const turn = await runScriptedTurn({ runHome, cwd: work, base: fixture.base, ask: ASK, timeoutMs: 180_000, extraEnv: { MERCURY_TASKS: '1' }, extraArgv: ['--dangerously-bypass-permissions'] })
await fixture.close()

tally.section('the shell moved below the session folder before the launch')
tally.check('the turn settled', turn.result !== null && turn.result.subtype === 'success', `${String(turn.result?.subtype)} · ${turn.stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}`)
tally.check("the shell's cwd was the folder below when the workflow launched", /[\\/]sub\s*$/m.test(bashResult.trim()), bashResult.slice(0, 120))
tally.check('the Workflow tool was called', fixture.requests.some(r => r.step >= 2), `steps: ${fixture.requests.map(r => r.step).join(' ')}`)

tally.section('the run record is filed in the session folder, where the board and the resource look')
const projectsRoot = join(runHome, 'projects')
const projectDirs = existsSync(projectsRoot) ? readdirSync(projectsRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : []
const sessionId = String(turn.result?.session_id ?? '')
const transcriptProject = projectDirs.find(name => existsSync(join(projectsRoot, name, `${sessionId}.jsonl`)))
const runProjects = projectDirs.filter(name => {
  const runs = join(projectsRoot, name, 'workflows', 'runs')
  return existsSync(runs) && readdirSync(runs).some(run => run.startsWith('wf_') && existsSync(join(runs, run, 'run.json')))
})
tally.check('the session transcript names one project folder', transcriptProject !== undefined, `session ${sessionId.slice(0, 8)} · projects: ${projectDirs.join(', ')}`)
tally.check('exactly one project folder holds the run record', runProjects.length === 1, runProjects.join(', ') || 'none')
tally.check('the run record sits in the same project folder as the session transcript', runProjects.length === 1 && runProjects[0] === transcriptProject, `run under ${runProjects.join(', ') || 'none'} · transcript under ${String(transcriptProject)}`)
console.log(`  exit ${String(turn.exitCode)}`)
rmSync(scratch, { recursive: true, force: true })
tally.finish()
