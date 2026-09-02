#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-foreground-budget.ts — item 8: (a) the shared
//  foreground→background blocking-budget owner is REAL (the promise both
//  shell tools carried while their timer blocks sat empty), with exact
//  cleanup/races; (b) harness-injected instruction files seed the
//  read-before-write gate (the AVS MEMORY.md round-trip).
//
//  The guarded field classes: a `gh run watch` hanging the foreground until
//  an operator SIGKILL (exit 137) — a 15s assistant budget existing only as
//  a comment + schema field + message; and MEMORY.md's first Write refused
//  "File has not been read yet" for content the system prompt carries.
//
//  Run:  ~/.bun/bin/bun run scripts/longrun-invariants/prove-foreground-budget.ts
//  Timing legs use REAL timers with wide margins (time IS the contract);
//  everything else is deterministic. OS-neutral (bun timers + child_process).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const { armForegroundBudget, isAssistantModeActive, setAssistantModeActive } = await import(
  '../../src/tasks/LocalShellTask/LocalShellTask.js'
)

// ── A. the owner's semantics (real timers, wide margins) ──
console.log('\n=== A. armForegroundBudget — fire-once, exact cleanup, races ===')
{
  // (1) The latency truth with a REAL hung watcher: a gh-run-watch-shaped
  // child that never exits on its own. The budget must fire while the
  // watcher still runs — the foreground is released at ~budget, not at the
  // watcher's leisure.
  const watcher = spawn('sleep', ['600'], { stdio: 'ignore' })
  const started = Date.now()
  let firedAt = 0
  const never = new Promise(() => {}) // the watcher's "result": never settles
  const h = armForegroundBudget({
    budgetMs: 150,
    enabled: true,
    resultPromise: never,
    onBudgetExceeded: () => {
      firedAt = Date.now()
    },
  })
  await sleep(600)
  check('the budget FIRED while the watcher still runs', firedAt > 0 && watcher.exitCode === null)
  check('…at ~budget latency (≤2s), not the watcher lifetime', firedAt - started >= 100 && firedAt - started < 2000, `${firedAt - started}ms`)
  check('handle reports fired', h.fired === true)
  const before = firedAt
  h.disarm() // post-fire disarm is a no-op
  await sleep(200)
  check('fire-once: no second fire, disarm-after-fire is a no-op', firedAt === before)
  watcher.kill('SIGKILL')

  // (2) Settlement first ⇒ never fires.
  let fired2 = false
  let settle: (v: unknown) => void = () => {}
  const result2 = new Promise(r => {
    settle = r
  })
  armForegroundBudget({ budgetMs: 150, enabled: true, resultPromise: result2, onBudgetExceeded: () => (fired2 = true) })
  settle('done')
  await sleep(400)
  check('a command that settles before the budget never backgrounds', fired2 === false)

  // (3) Abort first ⇒ never fires.
  let fired3 = false
  const ac = new AbortController()
  armForegroundBudget({ budgetMs: 150, enabled: true, resultPromise: new Promise(() => {}), signal: ac.signal, onBudgetExceeded: () => (fired3 = true) })
  ac.abort()
  await sleep(400)
  check('an abort before the budget never backgrounds', fired3 === false)

  // (4) Explicit disarm ⇒ never fires; idempotent.
  let fired4 = false
  const h4 = armForegroundBudget({ budgetMs: 150, enabled: true, resultPromise: new Promise(() => {}), onBudgetExceeded: () => (fired4 = true) })
  h4.disarm()
  h4.disarm()
  await sleep(400)
  check('disarm cancels; double-disarm is safe', fired4 === false && h4.fired === false)

  // (5) enabled:false ⇒ inert.
  let fired5 = false
  const h5 = armForegroundBudget({ budgetMs: 50, enabled: false, resultPromise: new Promise(() => {}), onBudgetExceeded: () => (fired5 = true) })
  await sleep(250)
  check('enabled:false arms nothing', fired5 === false && h5.fired === false)

  // (6) A throwing callback is contained (the owner never breaks the turn).
  const h6 = armForegroundBudget({
    budgetMs: 50,
    enabled: true,
    resultPromise: new Promise(() => {}),
    onBudgetExceeded: () => {
      throw new Error('boom')
    },
  })
  await sleep(300)
  check('a throwing callback is contained; fired still records', h6.fired === true)

  // (7) The assistant-mode seam: boot constant, read live.
  const prev = isAssistantModeActive()
  setAssistantModeActive(true)
  check('setAssistantModeActive flips the seam', isAssistantModeActive() === true)
  setAssistantModeActive(prev)
}

// ── B. wiring pins (both tools arm the ONE owner; main.tsx mirrors the boot constant) ──
console.log('\n=== B. wiring — one owner, both shells, boot mirror ===')
{
  const REPO = join(new URL('.', import.meta.url).pathname, '../..')
  const src = (p: string) => readFileSync(join(REPO, p), 'utf8')
  const bash = src('src/tools/BashTool/BashTool.tsx')
  const pwsh = src('src/tools/PowerShellTool/PowerShellTool.tsx')
  const main = src('src/main.tsx')
  const owner = src('src/tasks/LocalShellTask/LocalShellTask.tsx')
  check('BashTool arms armForegroundBudget with the assistant budget', /armForegroundBudget\(\{\s*budgetMs: ASSISTANT_BLOCKING_BUDGET_MS/.test(bash))
  check('BashTool gates on isAssistantModeActive + shouldAutoBackground', /enabled: shouldAutoBackground && isAssistantModeActive\(\)/.test(bash))
  check('PowerShellTool arms the SAME owner (Windows parity by construction)', /armForegroundBudget\(\{\s*budgetMs: ASSISTANT_BLOCKING_BUDGET_MS/.test(pwsh))
  check('PowerShellTool gates identically', /enabled: shouldAutoBackground && isAssistantModeActive\(\)/.test(pwsh))
  check('main.tsx mirrors the assistant boot constant into the seam', /setAssistantModeActive\(assistantBootActive\)/.test(main))
  check('the owner lives in LocalShellTask (one implementation)', /export function armForegroundBudget/.test(owner))
  check('no other implementation exists (no second timer body in the tools)', !/ASSISTANT_BLOCKING_BUDGET_MS\)?\s*;?\s*setTimeout/.test(bash) && !/ASSISTANT_BLOCKING_BUDGET_MS\)?\s*;?\s*setTimeout/.test(pwsh))
}

// ── C. injected-instruction file knowledge seeds the Write gate ──
console.log('\n=== C. harness-known files need no redundant Read (AVS MEMORY.md) ===')
{
  // The discovery pass reads config — allowed at the REAL call sites (both
  // seeding calls run at session boot, after config unlock); the proof pins
  // the same post-boot posture explicitly.
  process.env.NODE_ENV = 'test'
  // Proof hygiene (gate 31947814980, the ambient-state law): this section
  // would otherwise assert against THE REPO'S OWN cwd guide layout — on this
  // machine an untracked MERCURY.local.md stub (@CLAUDE.md) made the root
  // guide compose natively, while the runner's bare tracked checkout
  // composed nothing and the section red'd hosted-only. The subject is the
  // SEEDING LAW (injected instruction files enter readFileState with real
  // disk bytes + mtime), not this repo's guide politics — drive it against
  // a scratch fixture project with its own native guide.
  const fixtureProject = mkdtempSync(join(tmpdir(), 'vigil-seed-project-'))
  const nativeGuide = join(fixtureProject, 'MERCURY.md')
  writeFileSync(nativeGuide, '# fixture guide\n\nseeding-law fixture content.\n')
  const { setOriginalCwd } = await import('../../src/bootstrap/state.js')
  const restoreCwd = process.cwd()
  setOriginalCwd(fixtureProject)
  process.chdir(fixtureProject)
  const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.js')
  const { seedFileKnowledgeFromInjectedInstructions } = await import('../../src/services/instructions/engine.js')
  const cache = createFileStateCacheWithSizeLimit(1000)
  await seedFileKnowledgeFromInjectedInstructions(cache)
  process.chdir(restoreCwd)
  setOriginalCwd(restoreCwd)
  const guide = nativeGuide
  const seeded = cache.get(guide)
  check('the injected root guide is seeded into readFileState', seeded !== undefined)
  check('…with the CURRENT disk bytes (honest knowledge, not a guess)', seeded?.content === readFileSync(guide, 'utf8'))
  check('…and a real mtime stamp', typeof seeded?.timestamp === 'number' && seeded.timestamp > 0)

  // The gate itself now passes a first Write to a seeded file: drive the
  // REAL FileWriteTool.validate with the seeded cache + a default AppState.
  const { getDefaultAppState } = await import('../../src/state/AppState.js')
  const appState = getDefaultAppState()
  const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.js')
  const verdict = await FileWriteTool.validateInput(
    { file_path: guide, content: 'x' },
    { readFileState: cache, getAppState: () => appState } as never,
  )
  check('FileWriteTool.validate PASSES on the seeded file (no forced Read)', verdict.result === true, JSON.stringify(verdict))
  // validateInput is content-free — the blind-write gate lives
  // in call(), which refuses an unread CHANGING write before any mutation.
  // Exercise it on a scratch fixture, never the repo guide.
  const scratch = mkdtempSync(join(tmpdir(), 'vigil-blind-write-'))
  const blindPath = join(scratch, 'existing.txt')
  writeFileSync(blindPath, 'original\n')
  const empty = createFileStateCacheWithSizeLimit(10)
  const blindCtx = {
    readFileState: empty,
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => appState,
  } as never
  const blind = await FileWriteTool.validateInput({ file_path: blindPath, content: 'changed\n' }, blindCtx)
  check('validateInput is content-free — the gate moved to call', blind.result === true)
  let refusal = ''
  try {
    await (FileWriteTool as { call: Function }).call({ file_path: blindPath, content: 'changed\n' }, blindCtx, null, {
      uuid: '00000000-0000-0000-0000-0000000000b1',
      message: { id: 'msg_vigil_blind' },
    })
  } catch (err) {
    refusal = err instanceof Error ? err.message : String(err)
  }
  // Pin follows the current UNREAD_FILE_MESSAGE spelling (the deliberate
  // refusal-copy re-word; the repetition-guard W5/W6 re-true's sibling).
  check('an UNSEEDED existing file still refuses a blind CHANGING Write at call() (the gate stands)', /prior read of the current content is required/.test(refusal), refusal || 'settled?!')
  check('nothing was written on the refusal', readFileSync(blindPath, 'utf8') === 'original\n')
}

console.log(`\n${failures === 0 ? '✅ ALL PASS — the promised budget is real; harness knowledge is shared' : `❌ ${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
