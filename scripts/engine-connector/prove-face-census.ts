#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-connector/prove-face-census.ts — THE FACE CENSUS.
//
//  The cockpit's face talks to ONE engine connector per session and never to
//  a process global directly. This prover greps the face for direct reads of
//  the named global owners and pins ZERO outside the connector:
//
//    N1 the bootstrap state facade        (bootstrap/state)
//    N2 the cost accumulators             (cost-tracker)
//    N3 the cwd owner                     (utils/cwd)
//    N4 the model resolution              (getMainLoopModel/useMainLoopModel)
//    N5 the command-queue module's state  (input-core/command-queue, stateful names)
//    N6 the transcript writer             (sessionStorage/writer)
//    N7 the account owners                (billing/auth/oauthAccount)
//    N8 the MCP connection manager        (MCPConnectionManager)
//
//  Two tiers:
//   - the PURE-FACE set reads zero, except the residue table below — each
//     residue entry names its file, its needle, its exact count and the
//     reason it stays engine-side;
//   - src/screens/REPL.tsx hosts the in-process engine's own body (the
//     first connector implementation), so its remaining reads are pinned
//     EXACTLY, name by name — a new direct read is a deliberate,
//     prover-updating act.
//
//  Needles are COMPOSED from parts at runtime and a poison control proves
//  the scanner catches a planted read before any verdict counts.
// ============================================================================
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── the needles (composed; the scanner skips comment-only lines) ────────────
const N = {
  bootstrapFacade: new RegExp(['bootstrap', 'state'].join('/')),
  costTracker: new RegExp(['cost', 'tracker'].join('-')),
  cwdOwner: new RegExp(['utils', 'cwd'].join('/')),
  modelResolution: new RegExp('\\b(?:get|use)' + 'MainLoop' + 'Model\\b'),
  queueModule: new RegExp(['input-core', 'command-queue'].join('/')),
  transcriptWriter: new RegExp(['sessionStorage', 'writer'].join('/')),
  accountOwners: new RegExp(
    ['hasConsoleBilling' + 'Access', 'is1PApi' + 'Customer', 'oauth' + 'Account'].join('|'),
  ),
  mcpManager: new RegExp('MCPConnection' + 'Manager'),
} as const
type NeedleName = keyof typeof N

// The queue module's PURE helpers and type names — importable anywhere (they
// act on passed data, never on the module's state).
const QUEUE_PURE = new Set([
  'isQueuedCommandEditable',
  'isQueuedCommandVisible',
  'isPromptInputModeEditable',
  'isSlashCommand',
  'countQueuedPrompts',
  'QueuedCommand',
  'QueuePriority',
  'PopAllEditableResult',
  'ReplaceNextReceipt',
  'QueueConsumptionEvent',
  'SetAppState',
  'PopAllEditableResult',
])

function scanContent(content: string, path: string): { needle: NeedleName; line: number; text: string }[] {
  const hits: { needle: NeedleName; line: number; text: string }[] = []
  const lines = content.split('\n')
  // Import statements span lines; stitch a simple line view with comment
  // lines dropped (a comment naming an owner is prose, not a read).
  lines.forEach((raw, i) => {
    const t = raw.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    for (const name of Object.keys(N) as NeedleName[]) {
      if (name === 'queueModule') continue // handled below with the allowlist
      if (N[name].test(raw)) hits.push({ needle: name, line: i + 1, text: t })
    }
  })
  // Queue module: any import from it whose NAMED list reaches past the pure
  // helpers is a stateful read; `* as` namespace imports always are.
  const importRe = /import\s+(type\s+)?({[^}]*}|\*\s+as\s+\w+)\s+from\s+'[^']*input-core\/command-queue(?:\.js)?'/g
  for (const m of content.matchAll(importRe)) {
    const typeOnly = m[1] !== undefined
    const clause = m[2] ?? ''
    const line = content.slice(0, m.index ?? 0).split('\n').length
    if (typeOnly) continue
    if (clause.startsWith('*')) {
      hits.push({ needle: 'queueModule', line, text: m[0].replace(/\s+/g, ' ') })
      continue
    }
    const names = clause
      .replace(/[{}]/g, '')
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => part.replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim())
    const stateful = names.filter(n => !QUEUE_PURE.has(n))
    if (stateful.length > 0) {
      hits.push({ needle: 'queueModule', line, text: `stateful queue import: ${stateful.join(', ')}` })
    }
  }
  void path
  return hits
}

// ── poison control: the scanner must catch a planted read ───────────────────
{
  const poison = [
    "import { getTotalCostUSD } from '../../" + ['bootstrap', 'state'].join('/') + ".js'",
    'const x = getTotalCostUSD()',
  ].join('\n')
  const clean = [
    "import { getFocusedSessionConnector } from '../services/engine-connector/focusedConnector.js'",
    'const cost = getFocusedSessionConnector().usage().totalCostUSD',
    "// prose mentioning cost accounting is not a read",
  ].join('\n')
  const poisonHits = scanContent(poison, 'poison.tsx')
  const cleanHits = scanContent(clean, 'clean.tsx')
  check('poison control: a planted facade read is caught', poisonHits.length === 1)
  check('poison control: the connector-routed file scans clean', cleanHits.length === 0)
  const queuePoison = "import { enqueue, isQueuedCommandEditable } from '../input-core/command-queue.js'"
  const queueClean = "import { countQueuedPrompts, isQueuedCommandVisible } from '../input-core/command-queue.js'"
  check('poison control: a stateful queue import is caught', scanContent(queuePoison, 'q.tsx').length === 1)
  check('poison control: pure queue helpers pass', scanContent(queueClean, 'q.tsx').length === 0)
}

// ── the pure-face set ───────────────────────────────────────────────────────
const root = process.cwd()
function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`
    const st = statSync(join(root, rel))
    if (st.isDirectory()) out.push(...listFiles(rel))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(rel)
  }
  return out
}

const PURE_FACE: string[] = [
  ...listFiles('src/components/PromptInput'),
  ...listFiles('src/components/permissions'),
  ...listFiles('src/components/messages'),
  'src/components/Messages.tsx',
  'src/components/MercuryFrame.tsx',
  'src/components/Spinner.tsx',
  'src/components/CostThresholdDialog.tsx',
  'src/components/SwitchboardTagBar.tsx',
  'src/components/TaskListV2.tsx',
  'src/hooks/useCancelRequest.ts',
  // useCommandQueue.ts died with the pen (steer-removal; its absence is
  // pinned call-shaped by prove-one-truth-delivery T1). The census row is
  // existence-conditional so a REVIVED file re-enters the scan at once —
  // its stateful queue import would then red as unexplained residue.
  ...(existsSync(join(process.cwd(), 'src/hooks/useCommandQueue.ts')) ? ['src/hooks/useCommandQueue.ts'] : []),
  'src/hooks/useDisplayedSessionModel.ts',
  'src/hooks/useSessionConnector.ts',
]

// The residue table: engine-side reads that STAY, each with its reason.
// file → needle → exact count. Anything else in the pure-face set is red.
const RESIDUE: Record<string, Partial<Record<NeedleName, number>>> = {
  // getIsRemoteMode: process posture (the terminal's remote mode), not a
  // session fact — no connector door carries it by design.
  'src/components/Messages.tsx': { bootstrapFacade: 1 },
  // The plan-mode one-shots and session-title persistence ride the
  // APPROVAL (engine bookkeeping of the in-process session); the daemon
  // session's plan transitions ride its own engine (WIRE's step).
  'src/components/permissions/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.tsx': { bootstrapFacade: 1 },
  'src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx': { bootstrapFacade: 1 },
  // The kill-agents notification lands in the in-process session's queue:
  // background agents belong to the terminal process, whichever chat holds
  // the screen.
  'src/hooks/useCancelRequest.ts': { queueModule: 1 },
  // No ??-undefined caller here: the
  // notification paint resolves absence through the model owner's own
  // answer FIRST (getMainLoopModel) before declaredRouteOf — a paint-time
  // read of the one owner, not a session fact a connector door carries.
  'src/components/PromptInput/Notifications.tsx': { modelResolution: 2 },
}

for (const rel of PURE_FACE) {
  const content = readFileSync(join(root, rel), 'utf8')
  const hits = scanContent(content, rel)
  const allowed = RESIDUE[rel] ?? {}
  const counts: Partial<Record<NeedleName, number>> = {}
  for (const hit of hits) counts[hit.needle] = (counts[hit.needle] ?? 0) + 1
  const unexplained = hits.filter(h => (allowed[h.needle] ?? 0) === 0)
  const countDrift = Object.entries(allowed).filter(([needle, n]) => (counts[needle as NeedleName] ?? 0) !== n)
  const ok = unexplained.length === 0 && countDrift.length === 0
  check(
    `face zero: ${rel}`,
    ok,
    ok
      ? ''
      : [
          ...unexplained.map(h => `${h.needle}@${h.line}: ${h.text.slice(0, 90)}`),
          ...countDrift.map(([needle, n]) => `${needle} expected ${n} got ${counts[needle as NeedleName] ?? 0}`),
        ].join(' · '),
  )
}

// ── the chat screen: the face's pinned residue ──────────────────────────────
// REPL.tsx is the face over the focused chat; every engine-side read left
// with the engine (the session's runner owns cost persistence, the queue,
// the transcript writer and the MCP manager). What remains is face-side
// and pinned exactly.
const REPL_EXPECTED: Record<NeedleName, number> = {
  bootstrapFacade: 1, // the import: the screen's own boot id + original cwd (the composer seed, the worktree tip)
  costTracker: 0, // the session's runner persists its own costs
  cwdOwner: 1, // getCwd for the workspace a birth lands in + the screen commands' context
  modelResolution: 2, // the useMainLoopModel import + the notification hooks' model
  queueModule: 1, // the runner owns the queue; the face's ONE read is the hop effect's rekeyCommandQueueToSession — queued words follow their chat at the swap
  transcriptWriter: 1, // the session's runner records; the face paints through the connector — the ONE read is the store-health subscription (transcriptStoreHealth, the failing-store sticky notification: a WRITE failure must reach the operator even though the face never writes)
  accountOwners: 0,
  mcpManager: 0, // the session's runner manages its MCP servers
}
{
  const content = readFileSync(join(root, 'src/screens/REPL.tsx'), 'utf8')
  const hits = scanContent(content, 'src/screens/REPL.tsx')
  const counts = Object.fromEntries(Object.keys(N).map(k => [k, 0])) as Record<NeedleName, number>
  for (const hit of hits) counts[hit.needle]++
  for (const needle of Object.keys(N) as NeedleName[]) {
    check(
      `REPL residue pinned: ${needle} = ${REPL_EXPECTED[needle]}`,
      counts[needle] === REPL_EXPECTED[needle],
      counts[needle] === REPL_EXPECTED[needle]
        ? ''
        : `got ${counts[needle]} — a new direct read is a deliberate, prover-updating act`,
    )
  }
}

console.log(failures === 0 ? '\nALL LAWS HOLD' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
