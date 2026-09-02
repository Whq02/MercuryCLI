#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

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
  lines.forEach((raw, i) => {
    const t = raw.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    for (const name of Object.keys(N) as NeedleName[]) {
      if (name === 'queueModule') continue
      if (N[name].test(raw)) hits.push({ needle: name, line: i + 1, text: t })
    }
  })
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
  ...(existsSync(join(process.cwd(), 'src/hooks/useCommandQueue.ts')) ? ['src/hooks/useCommandQueue.ts'] : []),
  'src/hooks/useDisplayedSessionModel.ts',
  'src/hooks/useSessionConnector.ts',
]

const RESIDUE: Record<string, Partial<Record<NeedleName, number>>> = {
  'src/components/Messages.tsx': { bootstrapFacade: 1 },
  'src/components/permissions/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.tsx': { bootstrapFacade: 1 },
  'src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx': { bootstrapFacade: 1 },
  'src/hooks/useCancelRequest.ts': { queueModule: 1 },
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

const REPL_EXPECTED: Record<NeedleName, number> = {
  bootstrapFacade: 1,
  costTracker: 0,
  cwdOwner: 1,
  modelResolution: 2,
  queueModule: 1,
  transcriptWriter: 1,
  accountOwners: 0,
  mcpManager: 0,
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
