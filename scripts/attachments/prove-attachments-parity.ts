// scripts/attachments/prove-attachments-parity.ts — the R3 golden-replay
// parity oracle for src/utils/attachments.ts.
//
// Same contract as the R2 messages oracle (scripts/lib/goldenReplay.ts):
// deterministic fixtures through every covered export, byte-diffed against
// committed goldens recorded from the PRE-REWRITE module; coverage is
// self-accounting (an export neither covered nor skip-listed FAILS).
//
//   bun run scripts/attachments/prove-attachments-parity.ts --record
//   bun run scripts/attachments/prove-attachments-parity.ts            # gate
//
// The stateful producer family (getAttachments and the per-turn producers
// reading ToolUseContext/appState/config/memdir) is SKIP-LISTED with reasons:
// their behavior is pinned by the standing substrate suites (cache-stability,
// ultrathink wiring, ctx-forecast, away-summary, recall) and will gain
// fixture-context cases as the R3 extraction reaches each producer.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as A from '../../src/utils/attachments.ts'
import { recordOrVerify, snap, clone } from '../lib/goldenReplay.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN_PATH = join(HERE, 'goldens.json')
const RECORD = process.argv.includes('--record')

const cases: Record<string, () => unknown> = {}
const covered = new Set<string>()
const add = (exportName: string, caseName: string, fn: () => unknown) => {
  covered.add(exportName)
  cases[`${exportName}/${caseName}`] = fn
}

// ── config constants ────────────────────────────────────────────────────────
for (const c of [
  'TODO_REMINDER_CONFIG',
  'PLAN_MODE_ATTACHMENT_CONFIG',
  'AUTO_MODE_ATTACHMENT_CONFIG',
  'RELEVANT_MEMORIES_CONFIG',
  'VERIFY_PLAN_REMINDER_CONFIG',
  'CONTRACT_REMINDER_CONFIG',
] as const) {
  add(c, 'value', () => (A as Record<string, unknown>)[c])
}

// ── @-mention parsing ───────────────────────────────────────────────────────
const MENTION_SAMPLES = [
  'check @src/utils/messages.ts please',
  'see @"my file with spaces.txt" and @b.ts#L10-20',
  'ranges @f.ts#L5 and fragments @doc.md#heading',
  '@server1:resource/path plus text',
  'agents: @agent-code-reviewer and @"explorer (agent)"',
  'extension-namespaced @agent-asana:project-status-updater',
  'email not-a-mention user@host.com',
  'no mentions at all',
]
add('extractAtMentionedFiles', 'samples', () =>
  MENTION_SAMPLES.map(s => A.extractAtMentionedFiles(s)),
)
add('extractMcpResourceMentions', 'samples', () =>
  MENTION_SAMPLES.map(s => A.extractMcpResourceMentions(s)),
)
add('extractAgentMentions', 'samples', () =>
  MENTION_SAMPLES.map(s => A.extractAgentMentions(s)),
)
add('parseAtMentionedFileLines', 'shapes', () =>
  ['file.txt', 'file.txt#L10', 'file.txt#L10-20', 'file.txt#heading', 'a#L3#x'].map(m =>
    A.parseAtMentionedFileLines(m),
  ),
)

// ── memory header (bucket-stable freshness) ─────────────────────────────────
add('memoryHeader', 'fresh-bucket', () =>
  A.memoryHeader('/mem/example.md', Date.now() - 60_000),
)
add('memoryHeader', 'stale-bucket', () =>
  // Relative like fresh-bucket above — an absolute date here made the golden
  // age by one every midnight (554, 555, …); now − 553d pins it at the 553
  // the golden records, forever.
  A.memoryHeader('/mem/old.md', Date.now() - 553 * 86_400_000),
)

// ── pure filters / scans ────────────────────────────────────────────────────
const memoriesAttachment = {
  type: 'relevant_memories',
  memories: [
    { path: '/m/a.md', content: 'alpha', mtimeMs: 1, header: 'H-a' },
    { path: '/m/b.md', content: 'beta', mtimeMs: 2, header: 'H-b' },
  ],
} as never
add('filterDuplicateMemoryAttachments', 'dedup-read-file', () =>
  A.filterDuplicateMemoryAttachments(
    [clone(memoriesAttachment)],
    { '/m/a.md': { content: 'alpha' } } as never,
  ),
)
add('filterDuplicateMemoryAttachments', 'no-overlap', () =>
  A.filterDuplicateMemoryAttachments([clone(memoriesAttachment)], {} as never),
)

const humanTurn = (text: string) =>
  ({
    type: 'user',
    uuid: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'user', content: text },
  }) as never
add('getVerifyPlanReminderTurnCount', 'counts', () =>
  A.getVerifyPlanReminderTurnCount([
    humanTurn('one'),
    { type: 'assistant' } as never,
    humanTurn('two'),
  ]),
)

add('createAttachmentMessage', 'shape', () =>
  A.createAttachmentMessage({ type: 'todo', itemCount: 1, context: 'x' } as never),
)

// (filterToBundledAndMcp retired with the P2 rewrite, zero live
// callers — the skill-search turn-0 filter it served was folded out, and its
// call site had already been stripped to a dangling comment.)

add('getDirectoriesToProcess', 'nested', () =>
  A.getDirectoriesToProcess('/repo/src/deep/file.ts', '/repo'),
)

add('getCompactionReminderAttachment', 'first-turn', () =>
  snap(() => (A as Record<string, CallableFunction>).getCompactionReminderAttachment([])),
)
add('getContextEfficiencyAttachment', 'fold-dead', () =>
  (A as Record<string, CallableFunction>).getContextEfficiencyAttachment([]),
)

// ── explicit skip list (stateful/context-coupled producers) ─────────────────
const SKIPPED: Record<string, string> = {
  getAttachments: 'per-turn orchestrator over ToolUseContext/appState — pinned by substrate suites (cache-stability, ultrathink, ctx-forecast, away-summary); gains fixture cases as R3 extraction reaches it',
  getAttachmentMessages: 'async generator over the same ToolUseContext orchestration (the streaming wrapper of getAttachments)',
  getQueuedCommandAttachments: 'reads AppState queuedCommands',
  getAgentPendingMessageAttachments: 'reads teammate mailbox state',
  getDateChangeAttachments: 'reads session clock state',
  getDeferredToolsDeltaAttachment: 'reads MCP registry state',
  getAgentListingDeltaAttachment: 'reads agent registry state',
  getMcpInstructionsDeltaAttachment: 'reads MCP connection state',
  memoryFilesToAttachments: 'filesystem-coupled (memdir reads)',
  getChangedFiles: 'reads readFileState vs disk mtimes',
  collectSurfacedMemories: 'memdir + config coupled',
  readMemoriesForSurfacing: 'filesystem-coupled',
  startRelevantMemoryPrefetch: 'spawns async prefetch state',
  collectRecentSuccessfulTools: 'reads live message history shapes OK but feeds prefetch — cover with extraction',
  resetSentSkillNames: 'module-state mutator',
  suppressNextSkillListing: 'module-state mutator',
  tryGetPDFReference: 'filesystem stat-coupled',
  generateFileAttachment: 'filesystem read-coupled',
}

const runtimeExports = Object.keys(A).filter(
  k => typeof (A as Record<string, unknown>)[k] !== 'undefined',
)
const unaccounted = runtimeExports.filter(k => !covered.has(k) && !(k in SKIPPED))

const results: Record<string, unknown> = {}
for (const [name, fn] of Object.entries(cases)) results[name] = snap(fn)

const failures = recordOrVerify({
  goldenPath: GOLDEN_PATH,
  results,
  record: RECORD,
  coverageFailures: unaccounted,
  passLabel: `attachments parity: ${Object.keys(results).length} golden case(s), ${covered.size}/${runtimeExports.length} exports covered (${Object.keys(SKIPPED).length} skip-listed)`,
  readFileSync: readFileSync as never,
  writeFileSync: writeFileSync as never,
  existsSync: existsSync as never,
})

console.log(failures === 0 ? '✅ ATTACHMENTS PARITY GREEN' : `❌ ${failures} ATTACHMENTS PARITY FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
