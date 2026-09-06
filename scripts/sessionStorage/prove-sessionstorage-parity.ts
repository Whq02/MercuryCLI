
import { mkdirSync } from 'node:fs'
process.env.MERCURY_CONFIG_DIR = '/tmp/mercury-parity-home'
mkdirSync('/tmp/mercury-parity-home', { recursive: true })
mkdirSync('/tmp/mercury-parity-cwd', { recursive: true })
process.chdir('/tmp/mercury-parity-cwd')

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const S = await import('../../src/utils/sessionStorage.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
const { recordOrVerify, snap, clone } = await import('../lib/goldenReplay.ts')

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN_PATH = join(HERE, 'goldens.json')
const RECORD = process.argv.includes('--record')

const cases: Record<string, () => unknown> = {}
const covered = new Set<string>()
const add = (exportName: string, caseName: string, fn: () => unknown) => {
  covered.add(exportName)
  cases[`${exportName}/${caseName}`] = fn
}

const atParityCwd = <T,>(fn: () => T): T => runWithCwdOverride('/tmp/mercury-parity-cwd', fn)
const { realpathSync } = await import('node:fs')
const { basename } = await import('node:path')
const PARITY_CWD_SLUG = basename(S.getProjectDir(realpathSync('/tmp/mercury-parity-cwd')))
const neutral = (p: string): string => p.replace(PARITY_CWD_SLUG, '«parity-cwd»')
add('getProjectsDir', 'shape', () => S.getProjectsDir())
add('getTranscriptPathForSession', 'shape', () =>
  neutral(atParityCwd(() => S.getTranscriptPathForSession('00000000-0000-4000-8000-00000000abcd'))),
)
add('getAgentTranscriptPath', 'shape', () =>
  neutral(atParityCwd(() => S.getAgentTranscriptPath('agent-fixture-1' as never))),
)
add('getWorkflowTranscriptDir', 'shape', () =>
  neutral(atParityCwd(() => S.getWorkflowTranscriptDir('wf_fixture1'))),
)
add('sessionIdExists', 'absent', () =>
  S.sessionIdExists('00000000-0000-4000-8000-00000000dead'),
)
add('getNodeEnv', 'value', () => S.getNodeEnv())
add('getProjectDir', 'sanitized-shape', () =>
  S.getProjectDir('/tmp/example repo/with.dots'),
)
add('isCustomTitleEnabled', 'value', () => S.isCustomTitleEnabled())

const user = (uuid: string, parent: string | null, text: string) =>
  ({
    type: 'user',
    uuid,
    parentUuid: parent,
    timestamp: '2026-01-01T00:00:01.000Z',
    sessionId: '00000000-0000-4000-8000-000000000001',
    message: { role: 'user', content: text },
  }) as never
const asst = (uuid: string, parent: string) =>
  ({
    type: 'assistant',
    uuid,
    parentUuid: parent,
    timestamp: '2026-01-01T00:00:02.000Z',
    sessionId: '00000000-0000-4000-8000-000000000001',
    message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'hi', citations: [] }] },
  }) as never

add('isChainParticipant', 'kinds', () =>
  ['user', 'assistant', 'system', 'attachment', 'progress'].map(t =>
    S.isChainParticipant({ type: t } as never),
  ),
)
add('isEphemeralToolProgress', 'kinds', () =>
  ['hook_progress', 'tool_progress', 'agent_progress', 'other'].map(t =>
    S.isEphemeralToolProgress(t),
  ),
)
add('isTranscriptMessage', 'kinds', () =>
  [user('00000000-0000-4000-8000-000000000010', null, 'a'), { type: 'summary' } as never].map(e =>
    S.isTranscriptMessage(e as never),
  ),
)
add('isLoggableMessage', 'kinds', () =>
  [
    user('00000000-0000-4000-8000-000000000011', null, 'real'),
    { type: 'progress', data: { type: 'hook_progress' } } as never,
  ].map(m => S.isLoggableMessage(m as never)),
)

const U1 = '00000000-0000-4000-8000-000000000101'
const A1 = '00000000-0000-4000-8000-000000000102'
const U2 = '00000000-0000-4000-8000-000000000103'
const STRAY = '00000000-0000-4000-8000-000000000199'
const CHAIN = [user(U1, null, 'first'), asst(A1, U1), user(U2, A1, 'second'), user(STRAY, STRAY.replace('199', '198'), 'orphan-branch')]

const chainMap = () => {
  const msgs = clone(CHAIN) as { uuid: string }[]
  return new Map(msgs.map(m => [m.uuid, m])) as never
}
add('buildConversationChain', 'linear-with-orphan', () => {
  const map = chainMap() as Map<string, { uuid: string }>
  return S.buildConversationChain(map as never, map.get(U2)! as never)
})
add('removeExtraFields', 'strips-envelope', () =>
  S.removeExtraFields(clone([user(U1, null, 'x')]) as never),
)
add('checkResumeConsistency', 'consistent-chain', () =>
  snap(() => {
    const map = chainMap() as Map<string, { uuid: string }>
    return S.checkResumeConsistency(
      S.buildConversationChain(map as never, map.get(U2)! as never) as never,
    )
  }),
)
add('getFirstMeaningfulUserMessageTextContent', 'first-real', () =>
  S.getFirstMeaningfulUserMessageTextContent(clone(CHAIN) as never),
)
add('cleanMessagesForLogging', 'passthrough-shape', () =>
  S.cleanMessagesForLogging(clone([user(U1, null, 'y')]) as never),
)
add('extractAgentIdsFromMessages', 'none', () =>
  S.extractAgentIdsFromMessages(clone(CHAIN) as never),
)
add('getSessionIdFromLog', 'from-path', () =>
  S.getSessionIdFromLog({
    fullPath: '/x/00000000-0000-4000-8000-00000000cafe.jsonl',
    messages: [],
  } as never),
)
add('isLiteLog', 'lite-vs-full', () =>
  [
    { messages: [], isLite: true } as never,
    { messages: [user(U1, null, 'z')] } as never,
  ].map(l => S.isLiteLog(l as never)),
)
add('extractTeammateTranscriptsFromTasks', 'empty', () =>
  S.extractTeammateTranscriptsFromTasks({} as never),
)

const IO = 'filesystem/session-state IO — pinned by the standing resume/forensics suites; gains fixture cases as the R5 extraction reaches its family'
const SKIPPED: Record<string, string> = Object.fromEntries(
  [
    'writeAgentMetadata', 'readAgentMetadata', 'writeRemoteAgentMetadata', 'readRemoteAgentMetadata',
    'deleteRemoteAgentMetadata', 'listRemoteAgentMetadata', 'setAgentTranscriptSubdir',
    'clearAgentTranscriptSubdir', 'getTranscriptPath', 'resetProjectFlushStateForTesting',
    'resetProjectForTesting', 'setSessionFileForTesting', 'setInternalEventWriter',
    'setInternalEventReader', 'setRemoteIngressUrlForTesting', 'recordTranscript',
    'recordSidechainTranscript', 'recordQueueOperation', 'removeTranscriptMessage',
    'registerAgentTranscriptDestination',
    'transcriptCensus',
    'recordFileHistorySnapshot', 'recordAttributionSnapshot', 'recordContentReplacement',
    'resetSessionFilePointer', 'adoptResumedSessionFile', 'recordContextCollapseCommit',
    'recordContextCollapseSnapshot', 'flushSessionStorage', 'hydrateRemoteSession',
    'hydrateFromCCRv2InternalEvents', 'loadTranscriptFromFile', 'fetchLogs', 'saveCustomTitle',
    'saveAiGeneratedTitle', 'saveTaskSummary', 'saveTag', 'linkSessionToPR', 'getCurrentSessionTag',
    'getCurrentSessionTitle', 'getCurrentSessionAgentColor', 'restoreSessionMetadata',
    'clearSessionMetadata', 'reAppendSessionMetadata', 'saveAgentName', 'saveAgentColor',
    'saveAgentSetting', 'cacheSessionTitle', 'saveMode', 'saveWorktreeState', 'loadFullLog',
    'searchSessionsByCustomTitle', 'loadTranscriptFile', 'clearSessionMessagesCache',
    'doesMessageExistInSession', 'getLastSessionLog', 'loadMessageLogs', 'loadAllProjectsMessageLogs',
    'loadAllProjectsMessageLogsProgressive', 'loadSameRepoMessageLogs',
    'loadSameRepoMessageLogsProgressive', 'getAgentTranscript', 'loadSubagentTranscripts',
    'loadAllSubagentTranscriptsFromDisk', 'getLogByIndex', 'findUnresolvedToolUse',
    'getSessionFilesWithMtime', 'loadAllLogsFromSessionFile', 'getSessionFilesLite', 'enrichLogs',
  ].map(k => [k, IO]),
)

const runtimeExports = Object.keys(S).filter(
  k => typeof (S as Record<string, unknown>)[k] === 'function',
)
const unaccounted = runtimeExports.filter(k => !covered.has(k) && !(k in SKIPPED))

const results: Record<string, unknown> = {}
for (const [name, fn] of Object.entries(cases)) results[name] = snap(fn)

const failures = recordOrVerify({
  goldenPath: GOLDEN_PATH,
  results,
  record: RECORD,
  coverageFailures: unaccounted,
  passLabel: `sessionStorage parity: ${Object.keys(results).length} golden case(s), ${covered.size}/${runtimeExports.length} fn exports covered (${Object.keys(SKIPPED).length} skip-listed)`,
  readFileSync: readFileSync as never,
  writeFileSync: writeFileSync as never,
  existsSync: existsSync as never,
})

console.log(failures === 0 ? '✅ SESSIONSTORAGE PARITY GREEN' : `❌ ${failures} SESSIONSTORAGE PARITY FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
