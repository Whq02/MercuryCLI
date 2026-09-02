// src/utils/sessionStorage.ts — the session-persistence BARREL.
//
// This barrel is the frozen public surface over ./sessionStorage/, re-exporting every name. Do NOT add
// implementation here — new machinery goes in a submodule, and any NEW public
// export must be covered (or skip-listed) in the parity oracle,
// scripts/sessionStorage/prove-sessionstorage-parity.ts, or the gate fails.
//
// Submodule map:
//   paths    predicates + the transcript path-shape contract + metadata IO
//   chain    parentUuid walks, resume consistency, loggability transforms
//   writer   the Project JSONL append pipeline + recording API + seams
//   loading  loadTranscriptFile (resume reader) + the pre-boundary walk
//   logs     log listing/search/enrichment, titles/tags, subagent transcripts

// Predicates/paths (+agent metadata IO), the recording API, and the
// chain/consistency core live in owned submodules (R5 batch A).
import {
  getAgentTranscriptPath,
  getEntrypoint,
  getNodeEnv,
  getProjectDir,
  getProjectsDir,
  getTranscriptPath,
  getTranscriptPathForSession,
  getUserType,
  isChainParticipant,
  isEphemeralToolProgress,
  isPersistedProgressEntry,
  isTranscriptMessage,
  MAX_TRANSCRIPT_READ_BYTES,
} from './sessionStorage/paths.js'
export {
  clearAgentTranscriptSubdir,
  getAgentTranscriptPath,
  getNodeEnv,
  getProjectDir,
  getProjectsDir,
  getTranscriptPath,
  getTranscriptPathForSession,
  getUserType,
  getWorkflowTranscriptDir,
  isChainParticipant,
  isCustomTitleEnabled,
  isEphemeralToolProgress,
  isTranscriptMessage,
  MAX_TRANSCRIPT_READ_BYTES,
  readAgentMetadata,
  sessionIdExists,
  setAgentTranscriptSubdir,
  writeAgentMetadata,
} from './sessionStorage/paths.js'
import {
  applyPreservedSegmentRelinks,
  applySnipRemovals,
  buildAttributionSnapshotChain,
  buildConversationChain,
  buildFileHistorySnapshotChain,
  checkResumeConsistency,
  extractFirstPrompt,
  findLatestMessage,
  getFirstMeaningfulUserMessageTextContent,
  removeExtraFields,
  cleanMessagesForLogging,
  isLoggableMessage,
} from './sessionStorage/chain.js'

// The Project JSONL writer core + the recording API live in the owned writer
// submodule (R5 batch B).
import {
  getProject,
  appendEntryToFile,
  getSessionMessages,
} from './sessionStorage/writer.js'
import { loadSessionFile, loadTranscriptFile } from './sessionStorage/loading.js'
export { loadTranscriptFile } from './sessionStorage/loading.js'
export {
  adoptResumedSessionFile,
  flushSessionStorage,
  recordAttributionSnapshot,
  recordContentReplacement,
  recordContextCollapseCommit,
  recordContextCollapseSnapshot,
  recordFileHistorySnapshot,
  recordQueueOperation,
  recordSidechainTranscript,
  recordTranscript,
  registerAgentTranscriptDestination,
  removeTranscriptMessage,
  resetProjectFlushStateForTesting,
  resetProjectForTesting,
  resetSessionFilePointer,
  setInternalEventReader,
  setInternalEventWriter,
  setRemoteIngressUrlForTesting,
  setSessionFileForTesting,
} from './sessionStorage/writer.js'

export {
  buildConversationChain,
  checkResumeConsistency,
  getFirstMeaningfulUserMessageTextContent,
  removeExtraFields,
  cleanMessagesForLogging,
  isLoggableMessage,
} from './sessionStorage/chain.js'


// The log surface — transcript-from-file loading, visibility counting,
// metadata/title persistence, log listing/search/enrichment, and subagent
// transcripts — lives in the owned logs submodule (R5 final batch).
export {
  cacheSessionTitle,
  clearSessionMessagesCache,
  clearSessionMetadata,
  doesMessageExistInSession,
  extractAgentIdsFromMessages,
  extractTeammateTranscriptsFromTasks,
  fetchLogs,
  findUnresolvedToolUse,
  getAgentTranscript,
  getCurrentSessionAgentColor,
  getCurrentSessionTag,
  getCurrentSessionTitle,
  getLastSessionLog,
  getLogByIndex,
  getSessionFilesLite,
  getSessionFilesWithMtime,
  getSessionIdFromLog,
  isLiteLog,
  linkSessionToPR,
  loadAllLogsFromSessionFile,
  loadAllProjectsMessageLogs,
  loadAllProjectsMessageLogsProgressive,
  loadAllSubagentTranscriptsFromDisk,
  loadFullLog,
  loadMessageLogs,
  loadSameRepoMessageLogs,
  loadSameRepoMessageLogsProgressive,
  loadSubagentTranscripts,
  loadTranscriptFromFile,
  reAppendSessionMetadata,
  restoreSessionMetadata,
  saveAgentColor,
  saveAgentName,
  saveAgentSetting,
  saveAiGeneratedTitle,
  saveCustomTitle,
  saveMode,
  saveTag,
  saveTaskSummary,
  saveWorktreeState,
  searchSessionsByCustomTitle,
  transcriptCensus,
  enrichLogs,
  type SessionLogResult,
} from './sessionStorage/logs.js'

