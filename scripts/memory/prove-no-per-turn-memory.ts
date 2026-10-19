#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_DESKTOP_DRIVER = 'none'
const home = mkdtempSync(join(tmpdir(), 'no-per-turn-memory-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_PROJECT_INTEL
delete process.env.MERCURY_BARE
process.env.MERCURY_EMBED_ENGINE = 'off'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n── ${title} ──`)

const ROOT = join(import.meta.dir, '..', '..')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { emptyDoc, serializeTopicDoc } = await import('../../src/mneme/mnemeTopicDocs.ts')
const { automaticMemoryCandidates } = await import('../../src/mneme/mnemeLookup.ts')
const { getAttachments } = await import('../../src/utils/attachments/orchestrator.ts')
const { getContextCapsuleAttachment, foldAttachmentsIntoCapsule, _resetContextCapsuleForTesting } = await import('../../src/utils/attachments/contextCapsule.ts')
const { assembleContextCapsule, renderCapsule } = await import('../../src/services/projectIntel/capsule.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { collapseReadSearchGroups } = await import('../../src/utils/collapseReadSearch.ts')
const { renderableSearchText } = await import('../../src/utils/transcriptSearch.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const { loadTranscriptFromFile } = await import('../../src/utils/sessionStorage/logs.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { materializeFixture } = await import('../project-intel/fixtures/materialize.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const workspace = materializeFixture('ts')
bootstrap.setOriginalCwd(workspace)
bootstrap.setProjectRoot(workspace)
bootstrap.setCwdState(workspace)

const dir = mnemeLibraryDir()
mkdirSync(dir, { recursive: true })
const now = '2026-10-19T12:00:00.000Z'
const doc = emptyDoc('harbour', 'harbour', now)
doc.sections.push({
  heading: 'notes',
  entries: Array.from({ length: 40 }, (_, i) => ({
    seq: i + 1,
    time: now,
    source: 'tool:Retain s:proof',
    text: `The release update ${i + 1} used the ordinary blue tender.`,
  })),
})
doc.sections[0]!.entries.push(
  { seq: 41, time: now, source: 'tool:Retain s:proof', text: 'The harbour pricing rounds half up before the quayside invoice is printed.' },
  { seq: 42, time: now, source: 'tool:Retain s:proof', text: 'Never edit src/core/pricing.ts without checking the harbour rounding table.' },
)
writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))

const PROMPT = 'Fix the harbour pricing rounding of the quayside invoice in src/core/pricing.ts'
const makeContext = () =>
  ({
    abortController: new AbortController(),
    readFileState: new Map(),
    messages: [],
    nestedMemoryAttachmentTriggers: new Set<string>(),
    loadedNestedMemoryPaths: new Set<string>(),
    options: {
      commands: [],
      tools: [],
      engineModel: 'claude-fable-5-1',
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => ({}),
    setAppState: () => {},
    setInProgressToolUseIDs() {},
    setResponseLength() {},
    updateFileHistoryState() {},
    updateAttributionState() {},
  }) as never

try {
  section('§1 the library has matching records for the prompt and file')
  const matched = automaticMemoryCandidates(PROMPT, { dir, files: ['src/core/pricing.ts'], limit: Infinity })
  check('matching memory records exist in the library for the turn', matched.some(r => r.id === 'seq:41') && matched.some(r => r.id === 'seq:42'), JSON.stringify(matched.map(r => r.id)))

  section('§2 the attachment orchestrator emits no relevant_memories attachment and no memory lines')
  _resetContextCapsuleForTesting()
  const turnAttachments = await getAttachments(PROMPT, makeContext(), [], [])
  check('no attachment has the removed relevant_memories kind on user input', !turnAttachments.some(a => (a as { type: string }).type === 'relevant_memories'), JSON.stringify(turnAttachments.map(a => a.type)))
  const wireText = turnAttachments.flatMap(a => normalizeAttachmentForAPI(a)).map(m => JSON.stringify(m.message.content)).join('\n')
  check('wire projection carries no "Memory (task-matched):" header', !wireText.includes('Memory (task-matched):'), wireText)
  check('wire projection carries no "Memory (task-scoped refs" block', !wireText.includes('Memory (task-scoped refs'), wireText)
  check('wire projection carries neither matching memory record', !wireText.includes('harbour pricing rounds half up') && !wireText.includes('harbour rounding table'), wireText)

  const history = [
    { type: 'user', uuid: 'u1', timestamp: now, message: { role: 'user', content: PROMPT } },
    { type: 'assistant', uuid: 'a1', timestamp: now, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: join(workspace, 'src/core/pricing.ts') } }] } },
    { type: 'user', uuid: 'r1', timestamp: now, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  ] as never[]
  const contAttachments = await getAttachments(null, makeContext(), [], history)
  check('no attachment has the removed relevant_memories kind on a tool-round continuation', !contAttachments.some(a => (a as { type: string }).type === 'relevant_memories'), JSON.stringify(contAttachments.map(a => a.type)))

  section('§3 the working-set capsule carries files only — no memory refs or Memory lines')
  _resetContextCapsuleForTesting()
  const assembled = assembleContextCapsule({ workspace, task: PROMPT, recentFiles: ['src/core/pricing.ts'] })
  check('assembleContextCapsule succeeds and includes the task file', assembled !== null && assembled.items.some(i => i.path === 'src/core/pricing.ts'))
  check('assembled capsule has no memoryRefs field', assembled !== null && !('memoryRefs' in assembled), JSON.stringify(assembled))
  const rendered = assembled ? renderCapsule(assembled) : ''
  check('renderCapsule output has no "Memory" line and no mneme ref', !rendered.includes('Memory') && !rendered.includes('mneme:'), rendered)

  const capsuleRows = await getContextCapsuleAttachment(PROMPT, [], makeContext())
  const cap = capsuleRows[0] as Record<string, unknown> | undefined
  check('getContextCapsuleAttachment emits the file working set', cap !== undefined && cap.type === 'context_capsule' && String(cap.markdown ?? '').includes('src/core/pricing.ts'))
  check('capsule attachment carries no memory lines in markdown', cap !== undefined && !String(cap.markdown ?? '').includes('Memory') && !String(cap.markdown ?? '').includes('mneme:'), String(cap?.markdown ?? ''))
  check('capsule attachment carries no memoryDigest, memoryEmitted, memoryIds or memoryDeliveries fields', cap !== undefined && !('memoryDigest' in cap) && !('memoryEmitted' in cap) && !('memoryIds' in cap) && !('memoryDeliveries' in cap), JSON.stringify(Object.keys(cap ?? {})))

  section('§4 the removed modules are gone and old transcripts carrying relevant_memories load without crashing')
  check('src/utils/attachments/memorySurfacing.ts is removed', !existsSync(join(ROOT, 'src/utils/attachments/memorySurfacing.ts')))
  check('src/utils/attachments/memorySurfaced.ts is removed', !existsSync(join(ROOT, 'src/utils/attachments/memorySurfaced.ts')))

  const legacyAttachment = {
    type: 'relevant_memories',
    memories: [{ path: join(dir, 'topic-harbour.md'), content: '- [fact] old memory line', mtimeMs: 0, ids: ['seq:41'] }],
  }
  const projectDir = getProjectDir(workspace)
  mkdirSync(projectDir, { recursive: true })
  const sid = '00000000-0000-4000-8000-000000000099'
  const transcriptFile = join(projectDir, `${sid}.jsonl`)
  const uRow = { uuid: '00000000-0000-4000-8000-000000000001', parentUuid: null, isSidechain: false, cwd: workspace, sessionId: sid, version: '1.0.0', timestamp: now, type: 'user', message: { role: 'user', content: 'hello' } }
  const aRow = { uuid: '00000000-0000-4000-8000-000000000002', parentUuid: uRow.uuid, isSidechain: false, cwd: workspace, sessionId: sid, version: '1.0.0', timestamp: now, type: 'attachment', attachment: legacyAttachment }
  const u2Row = { uuid: '00000000-0000-4000-8000-000000000003', parentUuid: aRow.uuid, isSidechain: false, cwd: workspace, sessionId: sid, version: '1.0.0', timestamp: now, type: 'user', message: { role: 'user', content: 'follow up' } }
  appendFileSync(transcriptFile, (encodeTranscriptLine(transcriptFile, uRow) as { line: string }).line)
  appendFileSync(transcriptFile, (encodeTranscriptLine(transcriptFile, aRow) as { line: string }).line)
  appendFileSync(transcriptFile, (encodeTranscriptLine(transcriptFile, u2Row) as { line: string }).line)
  const loaded = await loadTranscriptFromFile(transcriptFile)
  check('an old transcript carrying relevant_memories loads without crashing', loaded.messages.length === 3, `${loaded.messages.length} rows`)
  check('normalizeAttachmentForAPI on a legacy relevant_memories row returns empty', normalizeAttachmentForAPI(legacyAttachment as never).length === 0)
  check('collapseReadSearchGroups and renderableSearchText handle a legacy row without crashing', collapseReadSearchGroups(loaded.messages as never, []).length === 3 && renderableSearchText(aRow as never) === '')
  check('foldAttachmentsIntoCapsule ignores a legacy relevant_memories row without crashing', Array.isArray(foldAttachmentsIntoCapsule([legacyAttachment as never], [], PROMPT)))
} finally {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n✅ no memory pointer or attachment rides per turn' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
