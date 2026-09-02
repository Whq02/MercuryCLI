#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-execution-origin.ts — execution origin.
//
//  What the code did vs the invariant it missed: a workflow's descendants
//  resolved the working directory at USE time — the live getCwd was handed
//  to the executor, agents re-read it per shell command, nested workflow()
//  lookups resolved against it, and isolated-agent worktrees were created
//  from whatever root it named at that moment. An operator entering a
//  worktree or running /clear mid-run (both mutate the live cwd; /clear
//  deliberately preserves running workflows) moved later work — including
//  in-flight agents — to the new location; and resume re-derived the run
//  store from the CURRENT location, so it could miss the journal and start
//  a full re-run under a duplicate run id.
//
//  The invariant: the origin is captured ONCE at launch; the whole
//  background run executes under runWithCwdOverride(origin) so every
//  descendant resolves against it; the manifest records origin{cwd,repoRoot}
//  additively; resume resolves from the recorded origin or REFUSES.
//
//  Seams: real makeWorkflowHooks under the real ALS override (§A), the real
//  WorkflowTool.call in child processes with a mid-run cwd mutation (§B) and
//  a wrong-directory resume (§C), plus wiring pins (§D).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'exec-origin-home-'))
const scratch = mkdtempSync(join(tmpdir(), 'exec-origin-'))
const REPO = join(new URL('.', import.meta.url).pathname, '../..')
const BUN = process.env.BUN ?? join(homedir(), '.bun/bin/bun')

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── §A the ALS override reaches the agent leg (real hooks, fake spawn) ──────
section('§A runWithCwdOverride reaches a spawned agent (the descendants law)')
{
  const { makeWorkflowHooks } = await import('../../src/tools/WorkflowTool/agentHooks.js')
  const { runWithCwdOverride, getCwd } = await import('../../src/utils/cwd.js')
  const seenCwds: string[] = []
  const hooks = makeWorkflowHooks({
    toolUseContext: {
      abortController: new AbortController(),
      getAppState: () => ({
        toolPermissionContext: {
          mode: 'default',
          additionalWorkingDirectories: new Map(),
          alwaysAllowRules: {},
          alwaysDenyRules: {},
        },
        mcp: { tools: [] },
      }),
      options: { agentDefinitions: { activeAgents: [] }, mainLoopModel: 'claude-opus-5' },
    },
    canUseTool: async () => ({ behavior: 'allow' }),
    emitProgress: () => {},
    workflowRunId: undefined,
    onAgentController: () => {},
    seedPhaseTitles: [],
    args: undefined,
    spawnSubagentStream: (async function* () {
      // The seam every real agent attempt passes through — record what a
      // descendant resolves as its working directory at SPAWN time.
      seenCwds.push(getCwd())
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
          usage: { output_tokens: 1 },
        },
      }
    }) as never,
  } as never) as { agent: (p: string, o?: Record<string, unknown>) => Promise<unknown> }

  const origin = mkdtempSync(join(tmpdir(), 'exec-origin-als-'))
  const res = await runWithCwdOverride(origin, () => hooks.agent('probe', { stallMs: 30_000 }))
  check('the agent resolved', String(res).includes('done'))
  check(
    'the agent attempt saw the ORIGIN cwd, not the live global one',
    seenCwds.length === 1 && seenCwds[0] === origin,
    JSON.stringify({ seenCwds, origin }),
  )
  rmSync(origin, { recursive: true, force: true })
}

// ── child harness: the REAL WorkflowTool.call with a mid-run cwd mutation ───
const CHILD = String.raw`
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'exec-origin-child-home-'))
await import('${REPO}/src/tasks.js')
const { WorkflowTool } = await import('${REPO}/src/tools/WorkflowTool/WorkflowTool.js')
const { setCwdState } = await import('${REPO}/src/bootstrap/state.js')
const emit = (o: unknown) => console.log('@@' + JSON.stringify(o))
const state: any = { tasks: {} }
const ctx: any = {
  getAppState: () => state,
  setAppState: (fn: any) => { const next = typeof fn === 'function' ? fn(state) : fn; for (const k of Object.keys(next)) (state as any)[k] = (next as any)[k] },
  options: { mainLoopModel: 'claude-opus-4-8' },
  abortController: new AbortController(),
  toolUseId: 'origin-tool-use',
}
const mode = process.env.ORIGIN_MODE
try {
  if (mode === 'wrap') {
    // Launch under cwd A a script whose SECOND act is a nested workflow()
    // lookup; mutate the live cwd to B (no registry there) right after
    // launch. Origin-pinned ⇒ the lookup still resolves under A.
    const script = [
      "export const meta = { name: 'outer', description: 'origin probe' }",
      'await new Promise(r => setTimeout(r, 1200))',
      "const r = await workflow('inner')",
      'return r',
    ].join('\n')
    const res = await WorkflowTool.call({ script }, ctx, async () => ({ behavior: 'allow' }))
    const runDir = (res as any).data.transcriptDir
    setCwdState(process.env.ORIGIN_CWD_B!)
    emit({ ev: 'launched', runId: (res as any).data.runId, runDir })
    for (let i = 0; i < 300; i++) {
      const t: any = Object.values(state.tasks)[0]
      if (t && t.status !== 'running' && t.status !== 'pending') {
        const manifest = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
        emit({ ev: 'settled', task: t.status, result: t.result, error: t.error ?? null, origin: manifest.origin ?? null, manifestStatus: manifest.status })
        process.exit(0)
      }
      await new Promise(r => setTimeout(r, 100))
    }
    emit({ ev: 'timeout' })
    process.exit(1)
  }
  if (mode === 'resume-elsewhere') {
    // Standing in B, resume a run id whose record lives under A's store —
    // the call must REFUSE, never launch a duplicate run here.
    const res = await WorkflowTool.call(
      { scriptPath: process.env.ORIGIN_SCRIPT_PATH, resumeFromRunId: process.env.ORIGIN_RESUME_RUN },
      ctx, async () => ({ behavior: 'allow' }),
    )
    emit({ ev: 'launched-anyway', data: (res as any).data.status, runDir: (res as any).data.transcriptDir })
    process.exit(0)
  }
} catch (e) {
  emit({ ev: 'threw', name: (e as Error).name, message: (e as Error).message })
  process.exit(0)
}
`
writeFileSync(join(scratch, 'child.ts'), CHILD)

interface ChildEvents {
  lines: Array<Record<string, unknown>>
  status: number | null
}
function runChild(cwd: string, env: Record<string, string>, timeoutMs = 60_000): Promise<ChildEvents> {
  return new Promise(resolve => {
    const child = spawn(BUN, ['run', join(scratch, 'child.ts')], {
      cwd,
      env: { ...process.env, ...env },
    })
    const lines: Array<Record<string, unknown>> = []
    let buf = ''
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      for (const line of buf.split('\n')) {
        if (line.startsWith('@@')) {
          try {
            const parsed = JSON.parse(line.slice(2))
            if (!lines.some(l => JSON.stringify(l) === JSON.stringify(parsed))) lines.push(parsed)
          } catch {
            /* partial */
          }
        }
      }
    })
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', status => {
      clearTimeout(killer)
      resolve({ lines, status })
    })
  })
}

section('§B mid-run cwd mutation: descendants stay pinned to the launch origin')
const cwdA = join(scratch, 'proj-a')
const cwdB = join(scratch, 'proj-b')
mkdirSync(join(cwdA, '.mercury', 'workflows'), { recursive: true })
mkdirSync(cwdB, { recursive: true })
writeFileSync(
  join(cwdA, '.mercury', 'workflows', 'inner.js'),
  "export const meta = { name: 'inner', description: 'origin fixture' }\nreturn 'inner-ok'\n",
)
let wrapRunDir = ''
{
  const { lines } = await runChild(cwdA, { ORIGIN_MODE: 'wrap', ORIGIN_CWD_B: cwdB })
  const settled = lines.find(l => l.ev === 'settled')
  const launched = lines.find(l => l.ev === 'launched')
  wrapRunDir = String(launched?.runDir ?? '')
  check('the run settled', settled !== undefined, JSON.stringify(lines))
  check(
    "nested workflow() resolved under the ORIGIN after the cwd moved (result 'inner-ok')",
    settled?.task === 'completed' && settled?.result === 'inner-ok',
    JSON.stringify(settled),
  )
  const origin = settled?.origin as { cwd?: string } | null
  check(
    'the manifest records origin{cwd} = realpath(launch cwd) — additive field',
    !!origin && origin.cwd === realpathSync(cwdA),
    JSON.stringify(origin),
  )
}

section('§C resume from the wrong directory REFUSES (no duplicate run id)')
{
  const runId = wrapRunDir.split('/').pop()!
  const { lines } = await runChild(cwdB, {
    ORIGIN_MODE: 'resume-elsewhere',
    ORIGIN_SCRIPT_PATH: join(wrapRunDir, 'workflow.js'),
    ORIGIN_RESUME_RUN: runId,
  })
  const threw = lines.find(l => l.ev === 'threw')
  check(
    'the wrong-directory resume threw the refuse-guard error',
    threw !== undefined && /no run record under/.test(String(threw.message)),
    JSON.stringify(lines),
  )
  check(
    'no duplicate run dir was created under the wrong store',
    !readdirHas(join(cwdB), runId),
    '',
  )
}
function readdirHas(root: string, needle: string): boolean {
  try {
    const { execSync } = require('node:child_process') as typeof import('node:child_process')
    const out = execSync(`find ${JSON.stringify(root)} -maxdepth 6 -name ${JSON.stringify(needle)} -type d`, {
      encoding: 'utf8',
    })
    return out.trim().length > 0
  } catch {
    return false
  }
}

section('§D wiring pins')
{
  const src = readFileSync(join(REPO, 'src', 'tools', 'WorkflowTool', 'WorkflowTool.tsx'), 'utf8')
  check('the background run is wrapped in runWithCwdOverride(executionCwd)',
    src.includes('runWithCwdOverride(executionCwd, driveRun)'))
  check('resume adopts the RECORDED origin when it differs and still exists',
    src.includes('executionCwd = recordedReal'))
  check('a vanished recorded origin refuses (never a silent relocation)',
    src.includes('which no longer exists — cannot resume against a missing origin'))
  check('origin comparisons realpath both sides',
    src.includes('const originCwd = realCanonicalPath(getCwd())') && src.includes('realCanonicalPath(recorded)'))
}

rmSync(scratch, { recursive: true, force: true })
rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} EXECUTION-ORIGIN PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL EXECUTION-ORIGIN PROOFS PASS')
