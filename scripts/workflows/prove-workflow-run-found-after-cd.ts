#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
const world = realpathSync(mkdtempSync(join(tmpdir(), 'run-lookup-')))
const A = join(world, 'project-A')
const B = join(world, 'project-B')
mkdirSync(A, { recursive: true })
mkdirSync(B, { recursive: true })

const { getOriginalCwd, setCwdState, setOriginalCwd } = await import('../../src/bootstrap/state.ts')
const { getCwd } = await import('../../src/utils/cwd.ts')
const { listWorkflowRunsDetailed, workflowRunsRoot, writeRunManifest } = await import('../../src/tools/WorkflowTool/runManifest.ts')
const { resolveResource } = await import('../../src/services/resources/registry.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { runsCwd } = await import('../../src/services/resources/adapters/workflow.ts')

section('§1 a session starts in A, its workflow saves a run, then its shell moves to B')
setOriginalCwd(A)
setCwdState(A)
const runId = `wf_${Date.now().toString(36)}`
const runDir = join(workflowRunsRoot(getOriginalCwd()), runId)
mkdirSync(runDir, { recursive: true })
await writeRunManifest({ version: 1, runId, runDir, startTime: Date.now(), status: 'running', ownerPid: process.pid, agentCount: 0, totalTokens: 0, workflowName: 'proof', agents: [] } as never)
check('the run is recorded under the starting folder\'s project store', (await listWorkflowRunsDetailed(getOriginalCwd())).rows.some(r => r.runId === runId))
setCwdState(B)
check('the shell moved: the current folder is B, the starting folder stays A', getCwd() === B && getOriginalCwd() === A, `${getCwd()} / ${getOriginalCwd()}`)
check('the readers\' root differs from the writer\'s when keyed by the current folder', workflowRunsRoot(getCwd()) !== workflowRunsRoot(getOriginalCwd()))

section('§2 every reader finds the run from B')
const owner = makeOwnerKey({ workspace: A, sessionId: 'proof-session', lane: 'main' })
const ctx = { owner, cwd: getCwd() }
const one = await resolveResource(`mercury://workflow/${runId}`, ctx)
check('Inspect mercury://workflow/<id> answers the run, never ABSENT', one.state === 'ok', JSON.stringify(one).slice(0, 300))
const all = await resolveResource('mercury://workflow', ctx)
check('Inspect mercury://workflow lists it', all.state === 'ok' && JSON.stringify(all).includes(runId), JSON.stringify(all).slice(0, 300))
check('the workflow resource anchors on the session\'s starting folder', runsCwd() === A)
const bus = readFileSync(join(ROOT, 'src', 'state', 'telemetryBus.ts'), 'utf8')
check('the telemetry rail sweeps the starting folder\'s runs', bus.includes('listWorkflowRuns(getOriginalCwd()') && !bus.includes('listWorkflowRuns(getCwd()'))
const board = readFileSync(join(ROOT, 'src', 'components', 'tasks', 'WorkflowsBoard.tsx'), 'utf8')
check('the /workflows board sweeps the focused session\'s starting folder', board.includes('useFocusedWorkspaceOriginalCwd()') && !board.includes('const cwd = useFocusedWorkspaceCwd()'))
const hook = readFileSync(join(ROOT, 'src', 'hooks', 'useFocusedWorkspaceCwd.ts'), 'utf8')
check('the focused-workspace hook reads originalCwd off the session facts', hook.includes('workspace().originalCwd'))

rmSync(world, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL LAWS HOLD' : `${failures} FAILURE(S)`} — prove-workflow-run-found-after-cd`)
process.exit(failures === 0 ? 0 : 1)
