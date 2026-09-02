#!/usr/bin/env bun
// ============================================================================
//  scripts/bash/prove-stop-ends-the-tree.ts
//  PROOF: stopping a task ends EVERY process it started, on every platform,
//  and the stop receipt says how many it ended (the tree-kill law).
//
//    §1 the kill owner (utils/processGroup.endProcessTree), live: a
//       three-deep tree whose grandchild leads its OWN process group (the
//       daemonising-helper shape that escapes a pure group signal) — the
//       walk finds it, the strike ends it, the receipt counts all three,
//       zero survivors by pid;
//    §2 the task layer (killTask), live: the same tree under a registered
//       shell task — the KillSettlement carries processesEnded, and every
//       pid is gone;
//    §3 the win32 arm, unit-pinned (it cannot run on a POSIX host): the
//       taskkill invocation is an argv ARRAY for execFile — no arg ever
//       carries a space, so no byte crosses a cmd.exe parse — and the
//       receipt counter reads one process per stdout `PID <n>` line
//       (locale-tolerant; failure lines live on stderr and never count);
//    §4 receipt surfacing pins: TaskStopTool's message and screen line say
//       how many processes the stop ended (source + dist);
//    §5 the stop's PROVENANCE decides the words on both platforms (F-1.1):
//       the settlement receipt carries `interrupted` (live on POSIX), and
//       the stop tool's sentence switches on it — the win32 receipt shape
//       (the field's own: exit code 1 under taskkill /F, five ended) reads
//       "interrupted", never the ordinary-failure "settled with exit code 1";
//       the raw code stays platform-honest as the detail. No win32 box runs
//       here — the shape is pinned, the live taskkill stop is the field's leg.
//
//  Poison control (base A/B): copied into a scratch worktree of the base
//  commit, §1/§2 go red — the out-of-group grandchild survives the stop; §5
//  reds on the base because its sentence switched on nothing (the win32
//  shape read as an ordinary failure).
// ============================================================================

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Proof hygiene: scratch config home BEFORE the imports so task-layer writes
// never land in the operator's real home.
const CONFIG_SCRATCH = mkdtempSync(join(tmpdir(), 'treekill-home-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_SCRATCH
process.on('exit', () => {
  try {
    rmSync(CONFIG_SCRATCH, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

const ROOT = join(import.meta.dir, '..', '..')
const { endProcessTree, win32TaskkillCommand, taskkillActedPids } = await import(
  join(ROOT, 'src/utils/processGroup.ts')
)
const { generateTaskId } = await import(join(ROOT, 'src/Task.ts'))
const { TaskOutput } = await import(join(ROOT, 'src/utils/task/TaskOutput.ts'))
const { wrapSpawn } = await import(join(ROOT, 'src/utils/ShellCommand.ts'))
const { killTask } = await import(join(ROOT, 'src/tasks/LocalShellTask/killShellTasks.ts'))
const { spawnShellTask } = await import(join(ROOT, 'src/tasks/LocalShellTask/LocalShellTask.tsx'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Build the three-deep tree: sh (detached group leader) → a runtime child in
 * the same group that STAYS alive → a grandchild sleep that leads its OWN
 * group (`detached: true`), the shape that escapes a pure group signal while
 * its parent chain is still intact. The middle writes `middlePid:kidPid`.
 */
const MIDDLE = join(CONFIG_SCRATCH, 'middle.cjs')
writeFileSync(
  MIDDLE,
  [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const kid = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })",
    'kid.unref()',
    "writeFileSync(process.env.TREE_PIDS_FILE, process.pid + ':' + kid.pid)",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'),
)

type Tree = { root: number; middle: number; grandchild: number; child: ReturnType<typeof spawn> }
async function spawnEscapeeTree(tag: string): Promise<Tree> {
  const pidsFile = join(CONFIG_SCRATCH, `pids-${tag}`)
  const child = spawn('sh', ['-c', `"${process.execPath}" "${MIDDLE}"; :`], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, TREE_PIDS_FILE: pidsFile },
  })
  for (let i = 0; i < 200 && !existsSync(pidsFile); i++) await sleep(25)
  const [middle, grandchild] = readFileSync(pidsFile, 'utf8').split(':').map(Number)
  return { root: child.pid!, middle: middle!, grandchild: grandchild!, child }
}

console.log('============================================================')
console.log(' Stop ends the tree — proof')
console.log('============================================================')

if (process.platform === 'win32') {
  console.log('  [SKIP] live legs are POSIX-shaped on this host; the win32 arm rides the field task')
}

// ── §1 the kill owner ends the whole tree and counts it ────────────────────
section('§1 endProcessTree — out-of-group grandchild dies; receipt counts 3')
if (process.platform !== 'win32') {
  const tree = await spawnEscapeeTree('owner')
  check('§1 tree is up (root, middle, grandchild all alive)', alive(tree.root) && alive(tree.middle) && alive(tree.grandchild), `pids ${tree.root}/${tree.middle}/${tree.grandchild}`)
  const receipt = await endProcessTree(tree.child)
  check('§1 root ended', !alive(tree.root), `pid ${tree.root}`)
  check('§1 middle ended', !alive(tree.middle), `pid ${tree.middle}`)
  check('§1 GRANDCHILD (own process group) ended — the walk found the escapee', !alive(tree.grandchild), `pid ${tree.grandchild}`)
  check('§1 receipt counts the whole tree', receipt.ended === 3, JSON.stringify(receipt))
  check('§1 zero survivors', receipt.survivors.length === 0, JSON.stringify(receipt.survivors))
}

// ── §2 the task layer: killTask settles with the count ─────────────────────
section('§2 killTask — the settlement receipt says how many the stop ended')
let liveReceipt: { settled: boolean; exitCode?: number; interrupted?: boolean } | null = null
if (process.platform !== 'win32') {
  const tree = await spawnEscapeeTree('task')
  const cmd = wrapSpawn(
    tree.child,
    new AbortController().signal,
    60_000,
    new TaskOutput(generateTaskId('local_bash'), null),
  )
  let state: { tasks: Record<string, any> } = { tasks: {} }
  const setAppState = (f: (prev: any) => any): void => {
    state = f(state)
  }
  const handle = await spawnShellTask(
    { command: 'escapee tree', description: 'tree-kill law', shellCommand: cmd },
    { abortController: new AbortController(), getAppState: () => state, setAppState } as any,
  )
  check('§2 task registered running', state.tasks[handle.taskId]?.status === 'running')
  const receipt = await killTask(handle.taskId, setAppState)
  liveReceipt = receipt
  check("§2 settled, with the stop's provenance (interrupted)", receipt.settled === true && (receipt as any).interrupted === true, JSON.stringify(receipt))
  check('§2 the raw code stays platform-honest (POSIX: 137, the kill signal)', (receipt as any).exitCode === 137, JSON.stringify(receipt))
  check('§2 settlement carries processesEnded === 3', (receipt as any).processesEnded === 3, JSON.stringify(receipt))
  check('§2 no survivor count on a clean sweep', (receipt as any).processSurvivors === undefined, JSON.stringify(receipt))
  check('§2 zero survivors by pid (root, middle, grandchild)', !alive(tree.root) && !alive(tree.middle) && !alive(tree.grandchild), `pids ${tree.root}/${tree.middle}/${tree.grandchild}`)
}

// ── §3 the win32 arm, unit-pinned ──────────────────────────────────────────
section('§3 win32 arm — argv array + locale-tolerant receipt counter (unit pins)')
{
  const { file, args } = win32TaskkillCommand(4242)
  check('§3 file is taskkill (execFile resolves it, no shell)', file === 'taskkill')
  check('§3 argv array is exactly /PID <pid> /T /F', JSON.stringify(args) === JSON.stringify(['/PID', '4242', '/T', '/F']), JSON.stringify(args))
  check('§3 no argv word carries a space (the shell-string poison shape)', args.every(a => !/\s/.test(a)))
  const english = [
    'SUCCESS: The process with PID 4242 (child of PID 17) has been terminated.',
    'SUCCESS: The process with PID 4243 (child of PID 4242) has been terminated.',
    'SUCCESS: The process with PID 17 has been terminated.',
  ].join('\r\n')
  check(
    '§3 English transcript: every acted pid, in order — first PID token per line, the parenthesised parent never joins (FN-015 rank 20: the acted set IS the win32 reap set)',
    JSON.stringify(taskkillActedPids(english)) === JSON.stringify([4242, 4243, 17]),
    JSON.stringify(taskkillActedPids(english)),
  )
  const localised = 'ERFOLGREICH: Der Prozess mit PID 4242 wurde beendet.'
  check('§3 localised transcript still yields its pid (PID token survives)', JSON.stringify(taskkillActedPids(localised)) === '[4242]')
  check('§3 empty / no-PID stdout yields none', taskkillActedPids('').length === 0 && taskkillActedPids('Operation completed.\n').length === 0)
}

// ── §4 receipt surfacing pins (TaskStopTool is not bun-run loadable) ───────
section('§4 the stop receipt on screen — source + dist pins')
{
  const toolSrc = readFileSync(join(ROOT, 'src/tools/TaskStopTool/TaskStopTool.ts'), 'utf8')
  const uiSrc = readFileSync(join(ROOT, 'src/tools/TaskStopTool/UI.tsx'), 'utf8')
  check('§4 tool message says how many the stop ended', toolSrc.includes('The stop ended ') && toolSrc.includes('processes_ended'))
  check('§4 survivors named when the reap could not confirm', toolSrc.includes('did not confirm ending within the reap bound'))
  check('§4 screen line carries the count', uiSrc.includes('ended ${ended} process'))
  const distPath = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(distPath)) {
    console.log('  [SKIP] dist/mercury.mjs not built — dist pins skipped (pool Phase 0 rebuilds it)')
  } else {
    const newestSrc = Math.max(
      statSync(join(ROOT, 'src/tools/TaskStopTool/TaskStopTool.ts')).mtimeMs,
      statSync(join(ROOT, 'src/tools/TaskStopTool/stopSettlement.ts')).mtimeMs,
      statSync(join(ROOT, 'src/utils/processGroup.ts')).mtimeMs,
    )
    if (statSync(distPath).mtimeMs < newestSrc) {
      console.log('  [SKIP] dist/mercury.mjs is OLDER than the pinned sources — stale build; dist pins skipped')
    } else {
      const dist = readFileSync(distPath, 'utf8')
      const pins = ['The stop ended ', 'did not confirm ending within the reap bound']
      const missing = pins.filter(p => !dist.includes(p))
      check('§4 dist carries the counted-receipt literals', missing.length === 0, missing.join(', '))
    }
  }
}

// ── §5 the stop's provenance decides the words, on both platforms ──────────
section("§5 F-1.1 — the receipt says INTERRUPTED on win32 and POSIX alike; the code is the platform's detail")
{
  const { settledStopSentence } = await import(join(ROOT, 'src/tools/TaskStopTool/stopSettlement.ts'))
  if (liveReceipt !== null) {
    const live = settledStopSentence(liveReceipt)
    check('§5 POSIX (live): the sentence reads interrupted, with 137 as the detail', live.includes('interrupted by the stop') && live.includes('(exit code 137)'), live)
  } else {
    console.log('  [SKIP] §5 POSIX live row — no live receipt on this host (win32: the taskkill stop is the field leg)')
  }
  // The win32 receipt shape is the FIELD's (TASK-016 t16-l1 §E, the
  // operator's Windows box): taskkill /F lets cmd.exe settle a real numeric
  // code, 1, and the sweep ended five processes. No win32 box runs here —
  // the shape is pinned, the live taskkill stop stays the field's leg.
  const win32Receipt = { settled: true, exitCode: 1, interrupted: true, processesEnded: 5 }
  const win32 = settledStopSentence(win32Receipt)
  check('§5 win32 shape: reads interrupted', win32.includes('interrupted by the stop'), win32)
  check('§5 win32 shape: the raw code 1 rides as the detail', win32.includes('(exit code 1)'), win32)
  check('§5 win32 shape: NEVER the ordinary-failure spelling', !win32.includes('settled with exit code'), win32)
  const posixShape = settledStopSentence({ settled: true, exitCode: 137, interrupted: true })
  check('§5 one vocabulary: the POSIX and win32 shapes differ ONLY in the number', posixShape.replace(/exit code \d+/, 'exit code N') === win32.replace(/exit code \d+/, 'exit code N'), `${posixShape} vs ${win32}`)
  const plain = settledStopSentence({ settled: true, exitCode: 1, interrupted: false })
  check('§5 a process that settled on its own keeps the plain sentence', plain === ' It settled with exit code 1.', plain)
  const bare = settledStopSentence({ settled: true, exitCode: undefined })
  check('§5 no code, no provenance: the bare settled sentence', bare === ' It settled.', bare)
  // Consumers switch on the provenance, never on the number.
  const toolSrc5 = readFileSync(join(ROOT, 'src/tools/TaskStopTool/TaskStopTool.ts'), 'utf8')
  const sentenceSrc = readFileSync(join(ROOT, 'src/tools/TaskStopTool/stopSettlement.ts'), 'utf8')
  const receiptSrc = readFileSync(join(ROOT, 'src/tasks/LocalShellTask/killShellTasks.ts'), 'utf8')
  check('§5 the sentence switches on `interrupted`', sentenceSrc.includes('settlement.interrupted === true'))
  check('§5 no stop consumer compares the code to 137', !/===\s*137\b/.test(toolSrc5) && !/===\s*137\b/.test(sentenceSrc) && !/===\s*137\b/.test(receiptSrc))
  check('§5 the tool speaks the sentence and carries the provenance in its output', toolSrc5.includes('settledStopSentence(') && toolSrc5.includes('interrupted: z') && toolSrc5.includes('interrupted: result.settlement.interrupted'))
  check("§5 killTask forwards the shell result's provenance into the receipt", receiptSrc.includes('interrupted: result.interrupted'))
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ ALL TREE-KILL LAW PROOFS PASS')
} else {
  console.log(` ❌ ${failures} TREE-KILL LAW PROOF(S) FAILED`)
}
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
