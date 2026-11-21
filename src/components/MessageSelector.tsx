
import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useClaim, useLoad } from '../hooks/effects.js'
import { Box, Text } from '../ink.js'
import type {
  Message,
  PartialCompactDirection,
  UserMessage,
} from '../types/message.js'
import type { BranchManifest } from '../services/branches/branchManifest.js'
import { useKeybinding, useKeybindings } from '../keybindings/useKeybinding.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import {
  BASH_STDERR_TAG,
  BASH_STDOUT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  TASK_NOTIFICATION_TAG,
  CREWMATE_MESSAGE_TAG,
  TICK_TAG,
} from '../constants/xml.js'
import { isSyntheticMessage, isTurnCutText } from '../utils/messages.js'
import { stripDisplayTagsAllowEmpty } from '../utils/displayTags.js'
import { isAdvisorOrigin, isSaturnOrigin, wrappedNoticeBlocks } from '../utils/messages/noticeRows.js'
import { createBranchSession } from '../services/branches/branchManifest.js'
import { transcriptMessageIndex } from '../utils/sessionStorage/materialize.js'
import { getCwd } from '../utils/cwd.js'
import { formatRelativeTimeAgo } from '../utils/format.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import type {
  CheckpointFactsV1,
  RewindReceiptV1,
} from '../services/engine-connector/types.js'
import { messageText, previewOf } from './messageSelector/preview.js'
import { findMutatingShellToolUseIds, mutatingShellCountAfter, writtenElsewhereLine, type CodeStats } from './messageSelector/stats.js'
import { confirmOptionsOf, confirmView, CURRENT_PROMPT, pickView, summarizeView, UNDO_REWIND, type PickEntry } from './messageSelector/views.js'

export { statsBetween, writtenElsewhereLine } from './messageSelector/stats.js'


const subscribeFocusedCheckpoints = subscribeThroughFocused((connector, listener) =>
  connector.subscribeCheckpoints(listener),
)

function getFocusedCheckpoints(): CheckpointFactsV1 {
  return getFocusedSessionConnector().checkpointFacts()
}


const COMPLETE_TAG_MARKERS = [
  `<${LOCAL_COMMAND_STDOUT_TAG}>`,
  `<${LOCAL_COMMAND_STDERR_TAG}>`,
  `<${BASH_STDOUT_TAG}>`,
  `<${BASH_STDERR_TAG}>`,
  `<${TASK_NOTIFICATION_TAG}>`,
  `<${TICK_TAG}>`,
]
const CREWMATE_PREFIX = `<${CREWMATE_MESSAGE_TAG}`


function isTurnCutRow(message: UserMessage): boolean {
  const content = message.message.content
  const first = Array.isArray(content) ? content[0] : undefined
  return first?.type === 'text' && isTurnCutText(first.text)
}

export function selectableUserMessagesFilter(
  message: Message,
): message is UserMessage {
  if (message.type !== 'user') return false
  const content = message.message.content
  if (Array.isArray(content) && content[0]?.type === 'tool_result') return false
  if (isSyntheticMessage(message) || isTurnCutRow(message)) return false
  if (message.isMeta) return false
  if (message.isCompactSummary) return false
  if (message.isVisibleInTranscriptOnly) return false
  if (isSaturnOrigin(message.origin) || isAdvisorOrigin(message.origin)) return false
  const noticeText = typeof content === 'string'
    ? content
    : content.every(block => block.type === 'text')
      ? content.map(block => (block as { text: string }).text).join('\n')
      : undefined
  if (noticeText !== undefined) {
    if (wrappedNoticeBlocks(noticeText) !== null) return false
    if (COMPLETE_TAG_MARKERS.some(marker => noticeText.includes(marker)) && stripDisplayTagsAllowEmpty(noticeText) === '') return false
  }
  const text = messageText(message)
  if (COMPLETE_TAG_MARKERS.some(marker => text.includes(marker))) return false
  if (text.includes(CREWMATE_PREFIX)) return false
  return true
}

export function messagesAfterAreOnlySynthetic(
  messages: Message[],
  fromIndex: number,
): boolean {
  for (let i = fromIndex + 1; i < messages.length; i++) {
    const message = messages[i]!
    if (message.type === 'progress') continue
    if (message.type === 'attachment') continue
    if (message.type === 'system') continue
    if (message.type === 'assistant') {
      const content = message.message.content
      if (!Array.isArray(content)) continue
      const meaningful = content.some(
        block =>
          (block.type === 'text' && block.text.trim() !== '') ||
          block.type === 'tool_use',
      )
      if (meaningful) return false
      continue
    }
    if (message.type === 'user') {
      if (isSyntheticMessage(message) || isTurnCutRow(message)) continue
      if (message.isMeta) continue
      const content = message.message.content
      if (Array.isArray(content) && content[0]?.type === 'tool_result') continue
      return false
    }
  }
  return true
}


let mountClaimed = false


export function MessageSelector({
  messages,
  onPreRestore,
  onRestore,
  onSummarize,
  onClose,
  onBranchCreated,
  providerOrigin,
  onViewOnly,
  onRerun,
  preselectedMessage,
}: {
  messages: Message[]
  onPreRestore: () => void
  onRestore: (
    message: UserMessage | undefined,
    what: 'both' | 'conversation' | 'code',
    files?: { filePath?: string; undo?: boolean; userMessageId?: string },
  ) => Promise<RewindReceiptV1>
  onSummarize: (
    message: UserMessage,
    feedback?: string,
    direction?: PartialCompactDirection,
  ) => void | Promise<void>
  onClose: () => void
  onBranchCreated?: (manifest: BranchManifest) => void
  providerOrigin?: string
  onViewOnly?: () => void
  onRerun?: (
    message: UserMessage,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>
  preselectedMessage?: UserMessage
}): React.ReactNode {
  const [claimed] = useState(() => {
    if (mountClaimed) return false
    mountClaimed = true
    return true
  })
  useClaim(
    () => () => {
      if (claimed) mountClaimed = false
    },
    [claimed],
  )

  const tokens = useMercuryTokens()
  const { columns } = useTerminalSize()
  const checkpoints = useSyncExternalStore(subscribeFocusedCheckpoints, getFocusedCheckpoints, getFocusedCheckpoints)
  const historyOn = checkpoints.capture === 'on'
  const hasSavedPoint = useCallback((uuid: string): boolean => checkpoints.restorable.has(uuid), [checkpoints])

  const selectable = useMemo(
    () => messages.filter(selectableUserMessagesFilter),
    [messages],
  )
  const entries: PickEntry[] = useMemo(
    () => [...selectable, ...(checkpoints.undo === undefined ? [] : [UNDO_REWIND as typeof UNDO_REWIND]), CURRENT_PROMPT],
    [selectable, checkpoints.undo],
  )

  const preselectedIndex =
    preselectedMessage !== undefined
      ? selectable.findIndex(message => message.uuid === preselectedMessage.uuid)
      : -1
  const [index, setIndex] = useState(
    preselectedIndex >= 0 ? preselectedIndex : entries.length - 1,
  )
  const [phase, setPhase] = useState<'pick' | 'confirm' | 'summarize'>(
    preselectedIndex >= 0 ? 'confirm' : 'pick',
  )
  const openedPreselected = useRef(preselectedIndex >= 0)
  const [restoring, setRestoring] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [feedbackCursor, setFeedbackCursor] = useState(0)
  const [focusedConfirm, setFocusedConfirm] = useState('conversation')
  const [mutatingShellIds, setMutatingShellIds] = useState<ReadonlySet<string> | null>(null)
  useLoad(() => {
    setMutatingShellIds(null)
    let cancelled = false
    void findMutatingShellToolUseIds(messages).then(ids => {
      if (!cancelled && ids.size > 0) setMutatingShellIds(ids)
    })
    return () => {
      cancelled = true
    }
  }, [messages])

  const [storeStats, setStoreStats] = useState<CodeStats | undefined>(undefined)
  const chosen = index < selectable.length ? selectable[index] : undefined
  useLoad(() => {
    if (!claimed || phase !== 'confirm' || !chosen || !historyOn || !hasSavedPoint(chosen.uuid)) {
      setStoreStats(undefined)
      return
    }
    let cancelled = false
    void getFocusedSessionConnector()
      .rewind({ userMessageId: chosen.uuid, mode: 'code', dryRun: true })
      .then(receipt => {
        if (!cancelled) setStoreStats(receipt.code)
      })
      .catch(() => {
        if (!cancelled) setStoreStats(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [claimed, phase, chosen, historyOn, hasSavedPoint])

  const close = useCallback(() => onClose(), [onClose])

  const runRestore = useCallback(
    async (what: 'both' | 'conversation' | 'code', files?: { filePath?: string; undo?: boolean; userMessageId?: string }) => {
      if (!chosen && !files?.undo) return
      setRestoring(true)
      onPreRestore()
      let receipt: RewindReceiptV1
      try {
        receipt = await onRestore(chosen, what, files)
      } catch (error) {
        setRestoring(false)
        setErrorText(`Restore failed — ${String(error)}`)
        return
      }
      setRestoring(false)
      if (receipt.outcome === 'refused') {
        setErrorText(`Not restored — ${receipt.detail ?? receipt.refusal ?? 'the session refused the rewind'}`)
        return
      }
      close()
    },
    [chosen, onPreRestore, onRestore, close],
  )

  const enterConfirm = useCallback(() => {
    if (!chosen) {
      close()
      return
    }
    const anyTimelineAction =
      onViewOnly !== undefined || onRerun !== undefined || onBranchCreated !== undefined
    if (!historyOn && !anyTimelineAction) {
      void runRestore('conversation')
      return
    }
    setPhase('confirm')
  }, [chosen, historyOn, onViewOnly, onRerun, onBranchCreated, runRestore, close])

  const active =
    claimed && phase === 'pick' && !restoring && errorText === null && entries.length > 0
  useKeybindings(
    {
      'messageSelector:up': () => {
        setIndex(previous => Math.max(0, previous - 1))
      },
      'messageSelector:down': () => {
        setIndex(previous => Math.min(entries.length - 1, previous + 1))
      },
      'messageSelector:top': () => {
        setIndex(0)
      },
      'messageSelector:bottom': () => {
        setIndex(entries.length - 1)
      },
      'messageSelector:select': () => {
        if (entries[index] === UNDO_REWIND) {
          void runRestore('code', { undo: true, userMessageId: checkpoints.undo! })
          return
        }
        if (index >= selectable.length) {
          close()
          return
        }
        enterConfirm()
      },
    },
    { context: 'MessageSelector', isActive: active },
  )
  useKeybinding(
    'messageSelector:close',
    () => {
      if (errorText !== null || restoring) {
        close()
        return
      }
      if (phase === 'summarize') {
        setPhase('confirm')
        return
      }
      if (phase === 'confirm') {
        if (openedPreselected.current) close()
        else setPhase('pick')
        return
      }
      close()
    },
    { context: 'MessageSelector', isActive: claimed },
  )

  const runBranch = useCallback(async () => {
    if (!chosen) return
    setRestoring(true)
    try {
      const focused = getFocusedSessionConnector() as { transcriptFile?: () => string }
      const transcriptPath = typeof focused.transcriptFile === 'function' ? focused.transcriptFile() : null
      if (transcriptPath === null || transcriptPath === '') {
        setErrorText('this session has no transcript file to branch from')
        return
      }
      const ordinal = transcriptMessageIndex(transcriptPath, chosen.uuid)
      if (ordinal === -1) {
        setErrorText('branch point not found in the committed transcript')
        return
      }
      const branch = createBranchSession({
        sourceTranscriptPath: transcriptPath,
        forkOrdinal: ordinal + 1,
        boundaryKind: 'fork',
        cwd: getCwd(),
        providerOrigin: providerOrigin ?? getCwd(),
      })
      if (!branch.ok) {
        setErrorText(branch.reason)
        return
      }
      onBranchCreated?.(branch.manifest)
      close()
    } catch (error) {
      setErrorText(`branch failed — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setRestoring(false)
    }
  }, [chosen, providerOrigin, onBranchCreated, close])

  const runRerun = useCallback(async () => {
    if (!chosen || !onRerun) return
    setRestoring(true)
    const result = await onRerun(chosen)
    setRestoring(false)
    if (!result.ok) setErrorText(result.reason)
  }, [chosen, onRerun])

  if (!claimed) return null
  if (errorText !== null) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={tokens.failure} paddingX={1}>
        <Text color={tokens.failureText}>{errorText}</Text>
        <Text dimColor>esc to close</Text>
      </Box>
    )
  }
  if (restoring) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Restoring… (esc returns to the chat; the restore keeps going)</Text>
      </Box>
    )
  }

  if (phase === 'pick') return pickView({ selectable, checkpoints, index, entries, columns, historyOn, tokens, messages, hasSavedPoint, mutatingShellIds })

  if (!chosen) {
    close()
    return null
  }

  if (phase === 'summarize') return summarizeView({ tokens, feedback, setFeedback, setPhase, onPreRestore, onSummarize, chosen, close, columns, feedbackCursor, setFeedbackCursor })

  const canRestoreCode = historyOn && hasSavedPoint(chosen.uuid)
  const elsewhere = writtenElsewhereLine(messages, chosen.uuid)
  const shellCommandsAfter = mutatingShellCountAfter(messages, chosen.uuid, mutatingShellIds)
  const preview = previewOf(chosen, columns - 16)
  const age = formatRelativeTimeAgo(new Date(chosen.timestamp))
  const conversationText =
    'The conversation winds back to before this point — later messages leave the model\'s view (the transcript keeps them)'

  const options = confirmOptionsOf({ canRestoreCode, conversationText, checkpoints, onViewOnly, onBranchCreated, onRerun })

  return confirmView({ tokens, preview, age, options, canRestoreCode, focusedConfirm, setFocusedConfirm, setPhase, openedPreselected, close, onViewOnly, runBranch, runRerun, runRestore, storeStats, elsewhere, shellCommandsAfter })
}

export default MessageSelector
