// src/utils/attachments.ts — the context-assembly BARREL.
//
// This barrel is the frozen public surface over ./attachments/, re-exporting every name. Do NOT add
// implementation here — new producers go in a submodule, and any NEW public
// export must be covered (or skip-listed) in the parity oracle,
// scripts/attachments/prove-attachments-parity.ts, or the gate fails.
//
// Submodule map:
//   types            the Attachment union + member types + config constants
//   shared           isFileReadDenied + tool_result content predicates
//   mentions         pure @-mention parsing (files, MCP resources, agents)
//   mentionResolvers context-coupled mention resolution + IDE producers
//   nestedMemory     MERCURY.md/conditional-rule traversal on file touch
//   memorySurfacing  relevant-memory recall (prefetch, secret scan, dedup)
//   fileAttachments  changed-file diffs, PDF references, the read core
//   diagnostics      IDE-tracker + passive-LSP diagnostics
//   modeLifecycles   plan/auto/supercode reminders, keyword opt-ins, date
//   reminders        todo/task nags, verify-plan, compaction reminder
//   queuedCommands   queue drains + pasted-image blocks + pending messages
//   deltas           deferred-tools / agent-listing / MCP-instructions
//   sessionContext   awareness pair, taste recall, gauges
//   skillListing     dynamic skills, sent-set dedup, resume suppression
//   taskStatus       unified Task feed + async-hook responses
//   teammates        swarm mailbox drain + team context
//   orchestrator     getAttachments fan-out (maybe isolation) + generator

export * from './attachments/types.js'

export {
  extractAgentMentions,
  extractAtMentionedFiles,
  extractMcpResourceMentions,
  parseAtMentionedFileLines,
} from './attachments/mentions.js'

export {
  getDirectoriesToProcess,
  memoryFilesToAttachments,
} from './attachments/nestedMemory.js'

export {
  collectRecentSuccessfulTools,
  collectSurfacedMemories,
  filterDuplicateMemoryAttachments,
  memoryHeader,
  readMemoriesForSurfacing,
  startRelevantMemoryPrefetch,
  type MemoryPrefetch,
} from './attachments/memorySurfacing.js'

export {
  generateFileAttachment,
  getChangedFiles,
  tryGetPDFReference,
} from './attachments/fileAttachments.js'

export { getDateChangeAttachments } from './attachments/modeLifecycles.js'

export {
  getCompactionReminderAttachment,
  getContextEfficiencyAttachment,
  getVerifyPlanReminderTurnCount,
} from './attachments/reminders.js'

export {
  getAgentPendingMessageAttachments,
  getQueuedCommandAttachments,
} from './attachments/queuedCommands.js'

export {
  getAgentListingDeltaAttachment,
  getDeferredToolsDeltaAttachment,
  getMcpInstructionsDeltaAttachment,
} from './attachments/deltas.js'

export {
  resetSentSkillNames,
  suppressNextSkillListing,
} from './attachments/skillListing.js'

export {
  createAttachmentMessage,
  getAttachmentMessages,
  getAttachments,
} from './attachments/orchestrator.js'
