// src/utils/messages.ts — the message-pipeline BARREL.
//
// This barrel is the frozen public surface over ./messages/, re-exporting every name.
// Do NOT add implementation here — new message machinery goes in a submodule,
// and any NEW public export must be covered (or skip-listed) in the parity
// oracle, scripts/messages/prove-messages-parity.ts, or the gate fails.
//
// Submodule map:
//   rejectionText   interrupt/reject/denial canonical strings + builders
//   identity        deriveUUID / deriveShortMessageId
//   factories       synthetic markers + create* user/assistant/progress family
//   text            tag extraction, emptiness, content→text, SR wrapping
//   normalize       one-block-per-message split + tool-use discriminators
//   lookups         per-render relationship indexes + conversation scans
//   uiOrder         transcript display ordering (reorderMessagesInUI)
//   merge           turn coalescing + the tool_result smoosh machinery
//   apiFilters      live-API invariants (thinking/whitespace/signature/…)
//   apiView         normalizeMessagesForAPI + tool_reference hygiene
//   attachmentText  attachment→API projection + mode-instruction templates
//   systemMessages  the type:'system' factory family + boundary predicates
//   streaming       SSE stream-event fan-out
//   pairing         tool_use/tool_result repair + advisor strip

export {
  AUTO_REJECT_MESSAGE,
  buildClassifierUnavailableMessage,
  buildFlowBlockDeclinedMessage,
  buildYoloRejectionMessage,
  CANCEL_MESSAGE,
  DENIAL_WORKAROUND_GUIDANCE,
  DONT_ASK_REJECT_MESSAGE,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  isClassifierDenial,
  NO_RESPONSE_REQUESTED,
  PLAN_REJECTION_PREFIX,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
  withMemoryCorrectionHint,
} from './messages/rejectionText.js'

export { deriveShortMessageId, deriveUUID } from './messages/identity.js'

export {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createModelSwitchBreadcrumbs,
  createProgressMessage,
  createSyntheticUserCaveatMessage,
  createToolResultStopMessage,
  createUserInterruptionMessage,
  createUserMessage,
  formatCommandInputTags,
  isSyntheticMessage,
  prepareUserContent,
  SYNTHETIC_MESSAGES,
  SYNTHETIC_MODEL,
} from './messages/factories.js'

export {
  extractTag,
  extractTextContent,
  getAssistantMessageText,
  getContentText,
  getUserMessageText,
  isEmptyMessageText,
  isNotEmptyMessage,
  stripPromptXMLTags,
  stripPromptXMLTagsKeepEdges,
  textForResubmit,
  wrapCommandText,
  wrapInSystemReminder,
  wrapMessagesInSystemReminder,
} from './messages/text.js'

export {
  isToolUseRequestMessage,
  isToolUseResultMessage,
  normalizeMessages,
} from './messages/normalize.js'

export {
  buildMessageLookups,
  buildSubagentLookups,
  EMPTY_LOOKUPS,
  EMPTY_STRING_SET,
  getLastAssistantMessage,
  getProgressMessagesFromLookup,
  getSiblingToolUseIDs,
  getSiblingToolUseIDsFromLookup,
  getToolResultIDs,
  getToolUseID,
  getToolUseIDs,
  hasToolCallsInLastAssistantTurn,
  hasUnresolvedHooks,
  hasUnresolvedHooksFromLookup,
} from './messages/lookups.js'

export { reorderMessagesInUI } from './messages/uiOrder.js'

export {
  mergeAssistantMessages,
  mergeUserContentBlocks,
  mergeUserMessages,
  mergeUserMessagesAndToolResults,
} from './messages/merge.js'

export {
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
  stripSignatureBlocks,
} from './messages/apiFilters.js'

export {
  isSystemLocalCommandMessage,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
  reorderAttachmentsForAPI,
  stripCallerFieldFromAssistantMessage,
  stripToolReferenceBlocksFromUserMessage,
} from './messages/apiView.js'

export {
  normalizeAttachmentForAPI,
  PLAN_PHASE4_CONTROL,
} from './messages/attachmentText.js'

export {
  countToolCalls,
  createAgentsKilledMessage,
  createApiMetricsMessage,
  createAwaySummaryMessage,
  createModelTransitionMessage,
  createCommandInputMessage,
  createCompactBoundaryMessage,
  createMemorySavedMessage,
  createMicrocompactBoundaryMessage,
  createPermissionRetryMessage,
  createScheduledTaskFireMessage,
  createStopHookSummaryMessage,
  createSystemAPIErrorMessage,
  createSeatReceiptMessage,
  createSystemMessage,
  createTurnDurationMessage,
  findLastCompactBoundaryIndex,
  getMessagesAfterCompactBoundary,
  hasSuccessfulToolCall,
  isCompactBoundaryMessage,
  isThinkingMessage,
  shouldShowUserMessage,
} from './messages/systemMessages.js'

export {
  handleMessageFromStream,
  isDroppedLateStreamFrame,
  type StreamingThinking,
  type StreamingToolUse,
} from './messages/streaming.js'

export {
  createToolUseSummaryMessage,
  ensureToolResultPairing,
  healWalkableForWire,
  isUnsignedThinkingBlock,
  orderToolResultsByUse,
  stripAdvisorBlocks,
  stripUnsignedThinkingBlocks,
} from './messages/pairing.js'
