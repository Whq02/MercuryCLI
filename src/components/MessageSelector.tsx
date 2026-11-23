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
import { isSyntheticMessage, isTurnCutText } from '../services/messages.js'
import { stripDisplayTagsAllowEmpty } from '../utils/displayTags.js'
import { isAdvisorOrigin, isSaturnOrigin, wrappedNoticeBlocks } from '../utils/messages/noticeRows.js'
import { createBranchSession } from '../services/branches/branchManifest.js'
import { transcriptMessageIndex } from '../utils/sessionStorage/materialize.js'
import { getCwd } from '../utils/cwd.js'
import { formatRelativeTimeAgo } from '../utils/format.js'
import { passedOver } from '../utils/passedOver.js'
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
const CONVERSATION_DESCRIPTION =
  "The conversation winds back to before this point — later messages leave the model's view (the transcript keeps them)"

function isTurnCutRow(message: UserMessage): boolean {
  const content = message.message.content
  if (!Array.isArray(content)) return false
  const first = content[0]
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
      ? content.map(block => block.text).join('\n')
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
    const msg = messages[i]!
    if (
      msg.type === 'progress' ||
      msg.type === 'attachment' ||
      msg.type === 'system'
    ) {
      continue
    }
    if (msg.type === 'assistant') {
      const content = msg.message.content
      if (!Array.isArray(content)) continue
      const meaningful = content.some(
        block =>
          (block.type === 'text' && block.text.trim() !== '') ||
          block.type === 'tool_use',
      )
      if (meaningful) return false
      continue
    }
    if (msg.type === 'user') {
      if (isSyntheticMessage(msg) || isTurnCutRow(msg) || msg.isMeta) continue
      const content = msg.message.content
      if (Array.isArray(content) && content[0]?.type === 'tool_result') {
        continue
      }
      return false
    }
  }
  return true
}


let mountClaimed = false

type MessageSelectorProps = {
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
}

function useSelectorLoads({
  claimed,
  messages,
  phase,
  canRestoreCode,
  chosenUuid,
}: {
  claimed: boolean
  messages: Message[]
  phase: 'pick' | 'confirm' | 'summarize'
  canRestoreCode: boolean
  chosenUuid: string | undefined
}): {
  mutatingShellIds: ReadonlySet<string> | null
  storeStats: CodeStats | undefined
} {
  const [mutatingShellIds, setMutatingShellIds] =
    useState<ReadonlySet<string> | null>(null)
  const [storeStats, setStoreStats] = useState<CodeStats | undefined>(undefined)

  useLoad(signal => {
    if (!claimed) return
    void findMutatingShellToolUseIds(messages).then(
      ids => {
        if (!signal.aborted) setMutatingShellIds(ids)
      },
      error => {
        passedOver(error)
        if (!signal.aborted) setMutatingShellIds(null)
      },
    )
  }, [claimed, messages])

  useLoad(signal => {
    if (
      !claimed ||
      phase !== 'confirm' ||
      !canRestoreCode ||
      chosenUuid === undefined
    ) {
      setStoreStats(undefined)
      return
    }
    setStoreStats(undefined)
    void getFocusedSessionConnector()
      .rewind({ userMessageId: chosenUuid, mode: 'code', dryRun: true })
      .then(
        receipt => {
          if (signal.aborted) return
          if (receipt.outcome !== 'refused' && receipt.code !== undefined) {
            setStoreStats(receipt.code)
          } else {
            setStoreStats(undefined)
          }
        },
        error => {
          passedOver(error)
          if (!signal.aborted) setStoreStats(undefined)
        },
      )
  }, [claimed, phase, canRestoreCode, chosenUuid])

  return { mutatingShellIds, storeStats }
}

function useSelectorActions({
  chosen,
  close,
  mountedRef,
  onPreRestore,
  onRestore,
  onBranchCreated,
  providerOrigin,
  onRerun,
  setBusy,
  setError,
}: {
  chosen: UserMessage | null
  close: () => void
  mountedRef: React.MutableRefObject<boolean>
  onPreRestore: () => void
  onRestore: MessageSelectorProps['onRestore']
  onBranchCreated: MessageSelectorProps['onBranchCreated']
  providerOrigin: string | undefined
  onRerun: MessageSelectorProps['onRerun']
  setBusy: React.Dispatch<React.SetStateAction<boolean>>
  setError: React.Dispatch<React.SetStateAction<string | null>>
}) {
  const runRestore = useCallback(
    async (
      what: 'both' | 'conversation' | 'code',
      files?: { filePath?: string; undo?: boolean; userMessageId?: string },
      targetOverride?: UserMessage,
    ): Promise<void> => {
      const isUndo = files?.undo === true
      const target = targetOverride ?? chosen
      if (!isUndo && target === null) return
      setError(null)
      setBusy(true)
      try {
        onPreRestore()
        const receipt = await onRestore(
          isUndo ? undefined : (target ?? undefined),
          what,
          files,
        )
        if (!mountedRef.current) return
        if (receipt.outcome === 'refused') {
          const detail =
            receipt.detail ||
            receipt.refusal ||
            'the session refused the rewind'
          setBusy(false)
          setError(`Not restored — ${detail}`)
          return
        }
        setBusy(false)
        close()
      } catch (err) {
        if (!mountedRef.current) return
        const message = err instanceof Error ? err.message : String(err)
        setBusy(false)
        setError(`Restore failed — ${message}`)
      }
    },
    [chosen, close, mountedRef, onPreRestore, onRestore, setBusy, setError],
  )

  const runBranch = useCallback(async (): Promise<void> => {
    if (chosen === null) return
    setError(null)
    setBusy(true)
    try {
      const sourceTranscriptPath = getFocusedSessionConnector().transcriptFile?.()
      if (!sourceTranscriptPath) {
        if (mountedRef.current) {
          setError('this session has no transcript file to branch from')
        }
        return
      }
      const idx = transcriptMessageIndex(sourceTranscriptPath, chosen.uuid)
      if (idx === -1) {
        if (mountedRef.current) {
          setError('branch point not found in the committed transcript')
        }
        return
      }
      const cwd = getCwd()
      const result = createBranchSession({
        sourceTranscriptPath,
        forkOrdinal: idx + 1,
        boundaryKind: 'fork',
        cwd,
        providerOrigin: providerOrigin || cwd,
      })
      if (!mountedRef.current) return
      if (!result.ok) {
        setError(result.reason)
        return
      }
      onBranchCreated?.(result.manifest)
      close()
    } catch (err) {
      if (!mountedRef.current) return
      const message = err instanceof Error ? err.message : String(err)
      setError(`branch failed — ${message}`)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [chosen, close, mountedRef, onBranchCreated, providerOrigin, setBusy, setError])

  const runRerun = useCallback(async (): Promise<void> => {
    if (chosen === null || !onRerun) return
    setError(null)
    setBusy(true)
    try {
      const result = await onRerun(chosen)
      if (!mountedRef.current) return
      if (!result.ok) {
        setError(result.reason)
      }
    } catch (err) {
      if (!mountedRef.current) return
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [chosen, mountedRef, onRerun, setBusy, setError])

  return { runRestore, runBranch, runRerun }
}

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
}: MessageSelectorProps): React.ReactNode {
  const [claimed] = useState(() => {
    if (mountClaimed) return false
    mountClaimed = true
    return true
  })
  const mountedRef = useRef(true)
  useClaim(() => {
    mountedRef.current = true
    if (!claimed) {
      return () => {
        mountedRef.current = false
      }
    }
    mountClaimed = true
    return () => {
      mountedRef.current = false
      mountClaimed = false
    }
  }, [claimed])

  const tokens = useMercuryTokens()
  const { columns } = useTerminalSize()
  const checkpoints = useSyncExternalStore(
    subscribeFocusedCheckpoints,
    getFocusedCheckpoints,
    getFocusedCheckpoints,
  )
  const historyOn = checkpoints.capture === 'on'
  const hasSavedPoint = useCallback(
    (uuid: string) => checkpoints.restorable.has(uuid),
    [checkpoints.restorable],
  )

  const selectable = useMemo(
    () => messages.filter(selectableUserMessagesFilter),
    [messages],
  )
  const entries = useMemo<PickEntry[]>(() => {
    const list: PickEntry[] = [...selectable]
    if (checkpoints.undo !== undefined) list.push(UNDO_REWIND)
    list.push(CURRENT_PROMPT)
    return list
  }, [selectable, checkpoints.undo])

  const preselectedIndex =
    preselectedMessage !== undefined
      ? selectable.findIndex(m => m.uuid === preselectedMessage.uuid)
      : -1
  const openedPreselected = useRef(preselectedIndex !== -1)

  const [phase, setPhase] = useState<'pick' | 'confirm' | 'summarize'>(
    preselectedIndex !== -1 ? 'confirm' : 'pick',
  )
  const [index, setIndex] = useState<number>(() =>
    preselectedIndex !== -1
      ? preselectedIndex
      : Math.max(0, entries.length - 1),
  )
  const [chosen, setChosen] = useState<UserMessage | null>(() =>
    preselectedIndex !== -1 ? selectable[preselectedIndex]! : null,
  )
  const [feedback, setFeedback] = useState('')
  const [feedbackCursor, setFeedbackCursor] = useState(0)
  const [focusedConfirm, setFocusedConfirm] = useState<string>('conversation')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chosenUuid = chosen?.uuid
  const canRestoreCode =
    chosenUuid !== undefined && historyOn && hasSavedPoint(chosenUuid)

  const { mutatingShellIds, storeStats } = useSelectorLoads({
    claimed,
    messages,
    phase,
    canRestoreCode,
    chosenUuid,
  })

  const close = useCallback(() => {
    onClose()
  }, [onClose])

  useLoad(() => {
    if (claimed && phase !== 'pick' && chosen === null) {
      close()
    }
  }, [claimed, phase, chosen, close])

  const { runRestore, runBranch, runRerun } = useSelectorActions({
    chosen,
    close,
    mountedRef,
    onPreRestore,
    onRestore,
    onBranchCreated,
    providerOrigin,
    onRerun,
    setBusy,
    setError,
  })
  const safeIndex = Math.min(index, Math.max(0, entries.length - 1))

  useKeybindings(
    {
      'messageSelector:up': () => {
        setIndex(i => Math.max(0, Math.min(i, entries.length - 1) - 1))
      },
      'messageSelector:down': () => {
        setIndex(i => Math.min(Math.max(0, entries.length - 1), i + 1))
      },
      'messageSelector:top': () => {
        setIndex(0)
      },
      'messageSelector:bottom': () => {
        setIndex(Math.max(0, entries.length - 1))
      },
      'messageSelector:select': () => {
        const selected = entries[safeIndex]
        if (selected === undefined || selected === CURRENT_PROMPT) {
          close()
          return
        }
        if (selected === UNDO_REWIND) {
          if (checkpoints.undo !== undefined) {
            void runRestore('code', {
              undo: true,
              userMessageId: checkpoints.undo,
            })
          }
          return
        }
        setChosen(selected)
        if (!historyOn && !onViewOnly && !onRerun && !onBranchCreated) {
          void runRestore('conversation', undefined, selected)
          return
        }
        setFocusedConfirm(
          historyOn && hasSavedPoint(selected.uuid) ? 'both' : 'conversation',
        )
        setPhase('confirm')
      },
    },
    {
      context: 'MessageSelector',
      isActive: claimed && phase === 'pick' && !busy && error === null && entries.length > 0,
    },
  )

  useKeybinding(
    'messageSelector:close',
    () => {
      if (busy || error !== null || phase === 'pick') {
        close()
        return
      }
      if (phase === 'summarize') {
        setPhase('confirm')
        return
      }
      if (openedPreselected.current) {
        close()
      } else {
        setPhase('pick')
      }
    },
    { context: 'MessageSelector', isActive: claimed },
  )

  if (!claimed) return null

  if (busy) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>
          Restoring… (esc returns to the chat; the restore keeps going)
        </Text>
      </Box>
    )
  }

  if (error !== null) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={tokens.failure}
        paddingX={1}
      >
        <Text color={tokens.failureText}>{error}</Text>
        <Text dimColor>esc to close</Text>
      </Box>
    )
  }

  if (phase === 'pick') {
    return pickView({
      selectable,
      checkpoints,
      index: safeIndex,
      entries,
      columns,
      historyOn,
      tokens,
      messages,
      hasSavedPoint,
      mutatingShellIds,
    })
  }

  if (chosen === null) return null

  if (phase === 'summarize') {
    return summarizeView({
      tokens,
      feedback,
      setFeedback,
      setPhase,
      onPreRestore,
      onSummarize,
      chosen,
      close,
      columns,
      feedbackCursor,
      setFeedbackCursor,
    })
  }

  const preview = previewOf(chosen, columns - 16)
  const parsedTime = Date.parse(chosen.timestamp)
  const age = Number.isNaN(parsedTime)
    ? ''
    : formatRelativeTimeAgo(new Date(parsedTime), { style: 'short' })
  const options = confirmOptionsOf({
    canRestoreCode,
    conversationText: CONVERSATION_DESCRIPTION,
    checkpoints,
    onViewOnly,
    onBranchCreated,
    onRerun,
  })
  const elsewhere = writtenElsewhereLine(messages, chosen.uuid)
  const shellCommandsAfter = mutatingShellCountAfter(
    messages,
    chosen.uuid,
    mutatingShellIds,
  )

  return confirmView({
    tokens,
    preview,
    age,
    options,
    canRestoreCode,
    focusedConfirm,
    setFocusedConfirm,
    setPhase,
    openedPreselected,
    close,
    onViewOnly,
    runBranch,
    runRerun,
    runRestore,
    storeStats,
    elsewhere,
    shellCommandsAfter,
  })
}

export default MessageSelector
