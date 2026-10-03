
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as A from '../../src/utils/attachments.ts'
import { recordOrVerify, snap } from '../lib/goldenReplay.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN_PATH = join(HERE, 'goldens.json')
const RECORD = process.argv.includes('--record')

const cases: Record<string, () => unknown> = {}
const covered = new Set<string>()
const add = (exportName: string, caseName: string, fn: () => unknown) => {
  covered.add(exportName)
  cases[`${exportName}/${caseName}`] = fn
}

for (const c of [
  'TASK_REMINDER_CONFIG',
  'AUTO_MODE_ATTACHMENT_CONFIG',
  'RELEVANT_MEMORIES_CONFIG',
  'CONTRACT_REMINDER_CONFIG',
] as const) {
  add(c, 'value', () => (A as Record<string, unknown>)[c])
}

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

add('memoryHeader', 'one-fact-page', () =>
  A.memoryHeader('/mem/library/topic-deploy.md', 0, 1, 'deploy'),
)
add('memoryHeader', 'many-facts-page', () =>
  A.memoryHeader('/mem/library/topic-deploy.md', 0, 3, 'deploy'),
)
add('memoryHeader', 'recent-rows', () =>
  A.memoryHeader('/mem/library/current.jsonl', 0, 2, '(recent)'),
)
add('memoryHeader', 'no-slug', () =>
  A.memoryHeader('/mem/example.md', 0),
)


add('createAttachmentMessage', 'shape', () =>
  A.createAttachmentMessage({ type: 'todo', itemCount: 1, context: 'x' } as never),
)


add('getDirectoriesToProcess', 'nested', () =>
  A.getDirectoriesToProcess('/repo/src/deep/file.ts', '/repo'),
)

add('getContextEfficiencyAttachment', 'fold-dead', () =>
  (A as Record<string, CallableFunction>).getContextEfficiencyAttachment([]),
)

add('CREW_MESSAGES_KIND', 'value', () => A.CREW_MESSAGES_KIND)
const KIND_SAMPLES = [A.CREW_MESSAGES_KIND, 'crew_context', 'queued_command', 'teammate_mailbox']
add('isCrewMessagesAttachment', 'samples', () => KIND_SAMPLES.map(type => A.isCrewMessagesAttachment({ type })))

const SKIPPED: Record<string, string> = {
  getAttachments: 'per-turn orchestrator over ToolUseContext/appState — pinned by substrate suites (cache-stability, ctx-forecast, away-summary); gains fixture cases as R3 extraction reaches it',
  getAttachmentMessages: 'async generator over the same ToolUseContext orchestration (the streaming wrapper of getAttachments)',
  getQueuedCommandAttachments: 'reads AppState queuedCommands',
  getAgentPendingMessageAttachments: 'reads crewmate mailbox state',
  getDateChangeAttachments: 'reads session clock state',
  getDeferredToolsDeltaAttachment: 'reads MCP registry state',
  getMcpInstructionsDeltaAttachment: 'reads MCP connection state',
  memoryFilesToAttachments: 'filesystem-coupled (memdir reads)',
  getChangedFiles: 'reads readFileState vs disk mtimes',
  collectSurfacedMemories: 'reads the live message history for the attachments already surfaced',
  getRelevantMemoryAttachments: 'reads the memory library on disk (the automatic lookup) — pinned by the memory suite (prove-memory-front-page, prove-memory-always-on)',
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
