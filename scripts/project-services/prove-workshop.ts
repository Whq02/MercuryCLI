#!/usr/bin/env bun
// ============================================================================
//  scripts/project-services/prove-workshop.ts — the Workshop
//  runtime + tool, proved against the PRODUCTION worker/runtime/bridge with
//  real fixtures (no mocks of the execution machinery itself).
//
//  Laws:
//    P. persistence — state survives across cells AND across calls
//    T. top-level await — TLA cells run; simple const bindings persist
//    I. local imports — require() re-reads changed files on later cells
//    G. reset — explicit, generation-bumping, state visibly gone
//    O. timeout — a busy cell is terminated; state loss REPORTED
//    W. idle-pause — a slow bridge call pauses the idle budget (the cell
//       survives a nested wait longer than its timeout)
//    D. display/parallel/pipeline — in-cell composition helpers
//    S. output spill — big output tails bounded + artifact ref
//    X. ts lane — workspace TypeScript transpiles; an absent one REFUSES
//    B. the tool boundary — WorkshopTool.call runs cells, nested
//       mercury.tool routes through the REAL runToolUse transaction,
//       recursive Workshop refuses, cancellation kills + reports
//
//  Run:  ~/.bun/bin/bun run scripts/project-services/prove-workshop.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'vanguard-workshop-'))
delete process.env.MERCURY_WORKSHOP

const { runWorkshopCell, resetWorkshopRuntime, workshopGeneration } = await import(
  '../../src/services/workshop/runtime.ts'
)
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — workshop proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const workDir = mkdtempSync(join(tmpdir(), 'vanguard-workshop-work-'))
const owner = makeOwnerKey({
  workspace: workDir,
  sessionId: 'workshop-session',
  lane: 'main',
} as never)

const noBridge = {
  inspect: async () => 'inspect-unused',
  tool: async () => 'tool-unused',
  agent: async () => 'agent-unused',
}

function run(code: string, extras: Record<string, unknown> = {}) {
  return runWorkshopCell({
    owner,
    cwd: workDir,
    cell: { language: 'js', code, ...extras } as never,
    bridge: (extras.bridge as typeof noBridge) ?? noBridge,
    signal: extras.signal as AbortSignal | undefined,
  })
}

// ── P. persistence ──────────────────────────────────────────────────────────
section('P. state persistence across cells and calls')
{
  const c1 = await run('const alpha = 40\nlet beta = 1\nclass Thing { size() { return 1 } }\nfunction bump(n) { return n + 1 }\nalpha')
  check('P1 first cell succeeds with the completion value', c1.state === 'succeeded' && c1.valuePreview === '40')
  const c2 = await run('bump(alpha + beta) + new Thing().size()')
  check('P2 const/let/class/function persist to the NEXT CALL',
    c2.state === 'succeeded' && c2.valuePreview === '43', JSON.stringify(c2))
  check('P3 same generation across the two calls', c1.generation === c2.generation)
}

// ── T. top-level await ──────────────────────────────────────────────────────
section('T. top-level await')
{
  const t1 = await run('const fromAwait = await Promise.resolve(41)\nfromAwait')
  check('T1 a TLA cell runs and returns its value', t1.state === 'succeeded' && t1.valuePreview === '41')
  const t2 = await run('fromAwait + 1')
  check('T2 simple const bindings from a TLA cell persist', t2.state === 'succeeded' && t2.valuePreview === '42')
}

// ── I. local imports observe changes ────────────────────────────────────────
section('I. require() freshness from cwd')
{
  writeFileSync(join(workDir, 'mod.js'), 'module.exports = { n: 1 }\n')
  const i1 = await run("require('./mod.js').n")
  check('I1 local require resolves from the session cwd', i1.state === 'succeeded' && i1.valuePreview === '1')
  writeFileSync(join(workDir, 'mod.js'), 'module.exports = { n: 2 }\n')
  const i2 = await run("require('./mod.js').n")
  check('I2 a LATER cell observes the changed file (cache dropped)',
    i2.state === 'succeeded' && i2.valuePreview === '2')
}

// ── G. reset ────────────────────────────────────────────────────────────────
section('G. explicit reset')
{
  const before = workshopGeneration(owner, 'js')
  resetWorkshopRuntime(owner, 'js')
  check('G1 reset bumps the generation', workshopGeneration(owner, 'js') === before + 1)
  const g = await run('typeof alpha')
  check('G2 retained state is visibly gone after reset',
    g.state === 'succeeded' && g.valuePreview === "'undefined'")
}

// ── O. timeout ──────────────────────────────────────────────────────────────
section('O. timeout terminates + reports state loss')
{
  const genBefore = workshopGeneration(owner, 'js')
  const o = await run('while (true) {}', { timeoutMs: 400 })
  check('O1 a busy cell is terminated as timed-out with the loss REPORTED',
    o.state === 'timed-out' && o.runtimeKilled && /RETAINED STATE WAS LOST/i.test(o.error ?? ''))
  check('O2 the generation bumped', workshopGeneration(owner, 'js') === genBefore + 1)
}

// ── W. idle-pause during nested waits ───────────────────────────────────────
section('W. a nested bridge wait pauses the idle budget')
{
  const slowBridge = {
    ...noBridge,
    tool: async () => {
      await new Promise(r => setTimeout(r, 700))
      return 'slow-tool-result'
    },
  }
  const w = await run("await mercury.tool('Slow', {})", {
    timeoutMs: 300,
    bridge: slowBridge,
  })
  check('W1 the cell SURVIVES a bridge wait longer than its timeout (idle paused)',
    w.state === 'succeeded' && w.valuePreview.includes('slow-tool-result') && w.nestedCalls === 1,
    JSON.stringify({ state: w.state, err: w.error }))
}

// ── D. display + composition helpers ───────────────────────────────────────
section('D. display / parallel / pipeline')
{
  const d = await run(
    "mercury.display({ answer: 42 })\nmercury.display('# heading')\nconst doubled = await mercury.pipeline([1,2,3], async v => v * 2)\nconst both = await mercury.parallel([() => 1, () => 2])\nJSON.stringify([doubled, both])",
  )
  check('D1 displays detect shape (json + markdown)',
    d.displays.some(x => x.kind === 'json' && x.value.includes('42')) &&
    d.displays.some(x => x.kind === 'markdown'))
  check('D2 pipeline + parallel compose in-cell',
    d.valuePreview.includes('[[2,4,6],[1,2]]'))
}

// ── S. output spill ─────────────────────────────────────────────────────────
section('S. output tail bound + artifact spill')
{
  const s = await run("for (let i = 0; i < 300; i++) console.log('line', i)\n'done'")
  check('S1 the tail is bounded', s.outputTail.length <= 60)
  check('S2 the full stream spilled to an artifact ref',
    s.artifactRef?.startsWith('mercury://artifact/workshop/') === true)
}

// ── X. the ts lane ──────────────────────────────────────────────────────────
section('X. TypeScript transpile (workspace-first, honest refusal)')
{
  // This repo HAS a workspace typescript — run from the repo cwd.
  const repoOwner = makeOwnerKey({
    workspace: process.cwd(),
    sessionId: 'workshop-ts',
    lane: 'main',
  } as never)
  const x1 = await runWorkshopCell({
    owner: repoOwner,
    cwd: process.cwd(),
    cell: {
      language: 'ts',
      code: 'interface P { n: number }\nconst p: P = { n: 41 }\np.n + 1',
    } as never,
    bridge: noBridge,
  })
  check('X1 ts transpiles via the workspace compiler (disclosed)',
    x1.state === 'succeeded' && x1.valuePreview === '42' &&
    /^workspace typescript@/.test(x1.compiler ?? ''), JSON.stringify(x1))
  disposeOwner(repoOwner)

  // The fixture dir has NO typescript — honest refusal.
  const x2 = await run('const x: number = 1', { language: 'ts' } as never)
  check('X2 an absent workspace compiler REFUSES honestly (no bundled fallback)',
    x2.state === 'failed' && /no TypeScript compiler available/.test(x2.error ?? ''))
}

// ── B. the tool boundary ────────────────────────────────────────────────────
section('B. WorkshopTool — nested transaction, recursion guard, cancel')
{
  const { WorkshopTool } = await import('../../src/tools/WorkshopTool/WorkshopTool.ts')
  const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

  const target = join(workDir, 'read-me.txt')
  writeFileSync(target, 'bridge says hello\n')

  const appState = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' },
    denialTracking: undefined,
    sessionHooks: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    speculation: { status: 'idle' },
  }
  const makeCtx = () => ({
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentId: undefined,
    toolDecisions: new Map(),
    readFileState: new Map(),
    nestedMemoryAttachmentTriggers: new Set(),
    dynamicSkillDirTriggers: new Set(),
    userModified: false,
    updateFileHistoryState: () => {},
    options: { tools: [FileReadTool, WorkshopTool], mcpClients: [], isNonInteractiveSession: true },
  })
  const ALLOW = async (_t: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })
  const PARENT = { uuid: 'ws-parent', requestId: 'ws-req', message: { id: 'ws-msg' } }

  const b1 = await (WorkshopTool as { call: Function }).call(
    {
      cells: [{
        language: 'js',
        code: `const out = await mercury.tool('Read', { file_path: ${JSON.stringify(target)} })\nout.includes('bridge says hello')`,
      }],
    },
    makeCtx(),
    ALLOW,
    PARENT,
  )
  check('B1 mercury.tool routes through the REAL transaction and returns the mapped result',
    b1.data.cells[0].state === 'succeeded' && b1.data.cells[0].valuePreview === 'true',
    JSON.stringify(b1.data.cells[0]))
  check('B2 the tool effect names the cell', b1.effect.operation === 'workshop.cell' && b1.effect.outcome === 'succeeded')

  const b3 = await (WorkshopTool as { call: Function }).call(
    { cells: [{ language: 'js', code: "await mercury.tool('Workshop', { cells: [] })" }] },
    makeCtx(),
    ALLOW,
    PARENT,
  )
  check('B3 recursive Workshop calls are refused inside a cell',
    b3.data.cells[0].state === 'failed' && /recursive Workshop/.test(b3.data.cells[0].error ?? ''))

  // a nested Write rides the SAME ordinary transaction —
  // an unread identical body settles the typed no-change through the bridge
  // (one policy stack, no Workshop-side special casing), and a real nested
  // write still lands.
  const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
  const nestedSame = join(workDir, 'nested-identical.txt')
  writeFileSync(nestedSame, 'nested body\n')
  const beforeMtime = statSync(nestedSame).mtimeMs
  const ctxNested = makeCtx()
  ctxNested.options.tools = [FileReadTool, FileWriteTool, WorkshopTool]
  const b5 = await (WorkshopTool as { call: Function }).call(
    {
      cells: [{
        language: 'js',
        code: `const out = await mercury.tool('Write', { file_path: ${JSON.stringify(nestedSame)}, content: ${JSON.stringify('nested body\n')} })\nout.includes('already matches')`,
      }],
    },
    ctxNested,
    ALLOW,
    PARENT,
  )
  check('B5 nested UNREAD-identical Write settles the typed no-change through the bridge (WR-22)',
    b5.data.cells[0].state === 'succeeded' && b5.data.cells[0].valuePreview === 'true',
    JSON.stringify(b5.data.cells[0]))
  check('B5b the nested no-change wrote NOTHING', statSync(nestedSame).mtimeMs === beforeMtime)

  const ctxNested2 = makeCtx()
  ctxNested2.options.tools = [FileReadTool, FileWriteTool, WorkshopTool]
  const nestedNew = join(workDir, 'nested-new.txt')
  const b6 = await (WorkshopTool as { call: Function }).call(
    {
      cells: [{
        language: 'js',
        code: `await mercury.tool('Write', { file_path: ${JSON.stringify(nestedNew)}, content: 'fresh nested\\n' })\nrequire('fs').readFileSync(${JSON.stringify(nestedNew)}, 'utf8')`,
      }],
    },
    ctxNested2,
    ALLOW,
    PARENT,
  )
  check('B6 a real nested Write still lands through the same transaction (WR-22/23)',
    b6.data.cells[0].state === 'succeeded' && String(b6.data.cells[0].valuePreview).includes('fresh nested'),
    JSON.stringify(b6.data.cells[0]))

  const cancelCtx = makeCtx()
  setTimeout(() => cancelCtx.abortController.abort(), 250)
  const b4 = await (WorkshopTool as { call: Function }).call(
    { cells: [
      { language: 'js', code: 'await new Promise(r => setTimeout(r, 10000))', timeoutMs: 30000 },
      { language: 'js', code: '1 + 1' },
    ] },
    cancelCtx,
    ALLOW,
    PARENT,
  )
  check('B4 cancellation kills the cell, reports the loss, and skips queued cells',
    b4.data.cells.length === 1 &&
    b4.data.cells[0].state === 'cancelled' &&
    b4.data.cells[0].runtimeKilled &&
    b4.effect.outcome === 'failed')
}

// ── teardown law ────────────────────────────────────────────────────────────
section('Z. owner disposal reaps runtimes')
{
  disposeOwner(owner)
  check('Z1 disposal resets the runtime registry (fresh generation numbering)',
    workshopGeneration(owner, 'js') === 1)
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ workshop: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ workshop: every law holds')
process.exit(0)
