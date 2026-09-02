// The rewind surface: pick a past user message, then confirm what to
// restore. The pick list annotates each point from the BETWEEN-MESSAGES
// walk; the confirm phase asks the SESSION'S RUNNER (a dry run over the
// wire) what a code restore would touch — the two are never conflated.
// Every restore is the runner's act (FN-015 rank 8): the process that
// captured the checkpoints and owns the conversation performs it and
// answers a typed receipt; this surface offers only what the session's
// checkpoint facts allow and paints the receipt. View-only calls only the
// wired view action (no pre-restore hook: nothing live is paused or
// mutated); branch and rerun mint new sessions and leave this one
// untouched.

import figures from 'figures'
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { basename } from 'path'
import { Box, Text } from '../ink.js'
import type {
  Message,
  PartialCompactDirection,
  UserMessage,
} from '../types/message.js'
import type { BranchManifest } from '../services/branches/branchManifest.js'
import TextInput from './TextInput.js'
import { Select } from './CustomSelect/index.js'
import { useKeybinding, useKeybindings } from '../keybindings/useKeybinding.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import {
  BASH_INPUT_TAG,
  BASH_STDERR_TAG,
  BASH_STDOUT_TAG,
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TICK_TAG,
} from '../constants/xml.js'
import { isSyntheticMessage } from '../utils/messages.js'
import { stripDisplayTagsAllowEmpty } from '../utils/displayTags.js'
import { createBranchSession } from '../services/branches/branchManifest.js'
import { readAllTranscriptEntries } from '../utils/sessionStorage/materialize.js'
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

// ── the session's checkpoint facts (through the focused connector) ─────────

const subscribeFocusedCheckpoints = subscribeThroughFocused((connector, listener) =>
  connector.subscribeCheckpoints(listener),
)

function getFocusedCheckpoints(): CheckpointFactsV1 {
  return getFocusedSessionConnector().checkpointFacts()
}

/** What a code restore would touch, as the runner's dry run answered. */
type CodeStats = { filesChanged: string[]; insertions: number; deletions: number }

// ── selectable user messages (contract markers) ────────────────────────────

/** Complete opening tags; the teammate tag is matched as a PREFIX because
 *  it carries attributes. */
const COMPLETE_TAG_MARKERS = [
  `<${LOCAL_COMMAND_STDOUT_TAG}>`,
  `<${LOCAL_COMMAND_STDERR_TAG}>`,
  `<${BASH_STDOUT_TAG}>`,
  `<${BASH_STDERR_TAG}>`,
  `<${TASK_NOTIFICATION_TAG}>`,
  `<${TICK_TAG}>`,
]
const TEAMMATE_PREFIX = `<${TEAMMATE_MESSAGE_TAG}`

function messageText(message: UserMessage): string {
  const content = message.message.content
  if (typeof content === 'string') return content
  let last = ''
  for (const block of content) {
    if (block.type === 'text') last = block.text
  }
  return last
}

export function selectableUserMessagesFilter(
  message: Message,
): message is UserMessage {
  if (message.type !== 'user') return false
  const content = message.message.content
  if (Array.isArray(content) && content[0]?.type === 'tool_result') return false
  if (isSyntheticMessage(message)) return false
  if (message.isMeta) return false
  if (message.isCompactSummary) return false
  if (message.isVisibleInTranscriptOnly) return false
  const text = messageText(message)
  if (COMPLETE_TAG_MARKERS.some(marker => text.includes(marker))) return false
  if (text.includes(TEAMMATE_PREFIX)) return false
  return true
}

/** Whether everything after the index is synthetic or otherwise
 *  non-meaningful — callers use it to skip the confirm phase. */
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
      if (isSyntheticMessage(message)) continue
      if (message.isMeta) continue
      const content = message.message.content
      if (Array.isArray(content) && content[0]?.type === 'tool_result') continue
      return false
    }
  }
  return true
}

// ── preview rendering ──────────────────────────────────────────────────────

const PREVIEW_CHAR_CAP = 500
const PREVIEW_LINE_CAP = 4

// Inventory S3: the local stripper removed only the three
// COMMAND tags' markup — every other wrapper (<local-command-stdout>,
// <system-reminder>, IDE context…) painted RAW into the rewind preview.
// The general path now rides the shared generic block-stripper
// (utils/displayTags); the bash/command branches above it keep their own
// clean extraction.

function previewOf(
  message: UserMessage,
  width?: number,
): { text: string; shell: boolean; command: boolean } {
  const raw = messageText(message).trim()
  if (raw === '') return { text: '(empty message)', shell: false, command: false }
  const bashMatch = raw.match(
    new RegExp(`<${BASH_INPUT_TAG}>([\\s\\S]*?)</${BASH_INPUT_TAG}>`),
  )
  if (bashMatch) {
    return { text: `! ${bashMatch[1]!.trim()}`, shell: true, command: false }
  }
  const nameMatch = raw.match(
    new RegExp(`<${COMMAND_NAME_TAG}>([\\s\\S]*?)</${COMMAND_NAME_TAG}>`),
  )
  if (nameMatch) {
    const argsMatch = raw.match(
      new RegExp(`<${COMMAND_ARGS_TAG}>([\\s\\S]*?)</${COMMAND_ARGS_TAG}>`),
    )
    const name = nameMatch[1]!.trim()
    const args = argsMatch?.[1]?.trim() ?? ''
    const skillMatch = name.match(/^skill:(.+)$/)
    if (skillMatch) {
      return {
        text: `/${skillMatch[1]}${args ? ` ${args}` : ''}`,
        shell: false,
        command: true,
      }
    }
    return { text: `${name}${args ? ` ${args}` : ''}`, shell: false, command: true }
  }
  let text = stripDisplayTagsAllowEmpty(raw)
  if (text === '') return { text: '(no prompt text)', shell: false, command: false }
  if (width !== undefined) {
    text = text.split('\n')[0]!.slice(0, Math.max(8, width))
  } else {
    const lines = text.split('\n').slice(0, PREVIEW_LINE_CAP)
    text = lines.join('\n').slice(0, PREVIEW_CHAR_CAP)
  }
  return { text, shell: false, command: false }
}

// ── diff statistics between two messages ───────────────────────────────────

type PatchHunk = { lines?: string[] }
type EditResult = {
  filePath?: string
  file_path?: string
  structuredPatch?: PatchHunk[]
  type?: string
  content?: string
}

function statsBetween(
  messages: Message[],
  fromUuid: string,
  toUuid: string | undefined,
): { files: string[]; insertions: number; deletions: number } {
  const start = messages.findIndex(message => message.uuid === fromUuid)
  const end =
    toUuid === undefined
      ? messages.length
      : messages.findIndex(message => message.uuid === toUuid)
  const files = new Set<string>()
  let insertions = 0
  let deletions = 0
  for (let i = start + 1; i < (end === -1 ? messages.length : end); i++) {
    const message = messages[i]!
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content) || content[0]?.type !== 'tool_result') continue
    const result = (message as { toolUseResult?: unknown }).toolUseResult as
      | EditResult
      | undefined
    if (!result || typeof result !== 'object') continue
    const filePath = result.filePath ?? result.file_path
    if (typeof filePath !== 'string') continue
    if (result.type === 'create' && typeof result.content === 'string') {
      files.add(filePath)
      insertions += result.content.split('\n').length
      continue
    }
    if (!Array.isArray(result.structuredPatch)) continue
    files.add(filePath)
    for (const hunk of result.structuredPatch) {
      if (!Array.isArray(hunk.lines)) continue
      for (const line of hunk.lines) {
        if (typeof line !== 'string') continue
        if (line.startsWith('+')) insertions += 1
        else if (line.startsWith('-')) deletions += 1
      }
    }
  }
  return { files: [...files], insertions, deletions }
}

function describeFiles(files: string[]): string {
  if (files.length === 0) return ''
  if (files.length === 1) return basename(files[0]!)
  if (files.length === 2) {
    return `${basename(files[0]!)} and ${basename(files[1]!)}`
  }
  return `${basename(files[0]!)} and ${files.length - 1} others`
}

// ── the surface ────────────────────────────────────────────────────────────

const VISIBLE_ROWS = 7
const CURRENT_PROMPT = Symbol('current-prompt')

/** The REPL offers two bottom slots that can both resolve to this surface;
 *  the FIRST mounted instance claims the render (a second live copy would
 *  double every keybinding handler and paint twice). */
let mountClaimed = false

type PickEntry = UserMessage | typeof CURRENT_PROMPT

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
  /** The one restore door: the session's runner restores the files, winds
   *  the conversation back, or both, and answers a typed receipt. */
  onRestore: (
    message: UserMessage,
    what: 'both' | 'conversation' | 'code',
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
  // Claim decided once at first render; released on unmount.
  const [claimed] = useState(() => {
    if (mountClaimed) return false
    mountClaimed = true
    return true
  })
  useEffect(
    () => () => {
      if (claimed) mountClaimed = false
    },
    [claimed],
  )

  const tokens = useMercuryTokens()
  const { columns } = useTerminalSize()
  // The session's own checkpoint truth (its runner's facts) — never the
  // screen process's file-history state, which runs no tools.
  const checkpoints = useSyncExternalStore(subscribeFocusedCheckpoints, getFocusedCheckpoints, getFocusedCheckpoints)
  const historyOn = checkpoints.capture === 'on'
  const hasSavedPoint = useCallback((uuid: string): boolean => checkpoints.restorable.has(uuid), [checkpoints])

  const selectable = useMemo(
    () => messages.filter(selectableUserMessagesFilter),
    [messages],
  )
  const entries: PickEntry[] = useMemo(
    () => [...selectable, CURRENT_PROMPT],
    [selectable],
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

  // Confirm-phase code stats: the RUNNER's dry run over the wire (writes
  // nothing), asked only where the facts say a saved point exists.
  const [storeStats, setStoreStats] = useState<CodeStats | undefined>(undefined)
  const chosen = index < selectable.length ? selectable[index] : undefined
  useEffect(() => {
    if (phase !== 'confirm' || !chosen || !historyOn || !hasSavedPoint(chosen.uuid)) {
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
  }, [phase, chosen, historyOn, hasSavedPoint])

  const close = useCallback(() => onClose(), [onClose])

  // ── execution ────────────────────────────────────────────────────────────
  // One door: the runner performs the restore and answers typed. A refusal
  // paints its sentence on the card (the operator learns WHY — drift names
  // the file, an older runner names the remedy); the road itself failing
  // (a thrown promise) paints as a failure.
  const runRestore = useCallback(
    async (what: 'both' | 'conversation' | 'code') => {
      if (!chosen) return
      setRestoring(true)
      onPreRestore()
      let receipt: RewindReceiptV1
      try {
        receipt = await onRestore(chosen, what)
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
      // Nothing to choose between: restore the conversation directly.
      void runRestore('conversation')
      return
    }
    setPhase('confirm')
  }, [chosen, historyOn, onViewOnly, onRerun, onBranchCreated, runRestore, close])

  // Pick-phase navigation (contract actions, MessageSelector context).
  const active =
    phase === 'pick' && !restoring && errorText === null && entries.length > 0
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
        if (index >= selectable.length) {
          close()
          return
        }
        enterConfirm()
      },
    },
    { context: 'MessageSelector', isActive: active },
  )
  // Escape, owned in ONE place for the surface's WHOLE life. The composer is
  // unmounted and the cancel handler stands down while this surface shows,
  // so an escape this surface ignores is an escape that does nothing — the
  // stuck-rewind incident: the old pick-phase handler listened
  // for 'confirm:no', whose escape rows live only in binding contexts
  // nothing registers, and a phase-scoped Confirmation block cannot coexist
  // with an always-armed fallback (an isActive flip RE-REGISTERS a listener
  // at the END of the dispatch order, so a block re-arming after the
  // fallback would never see the key). One handler, every phase, the finer
  // grammar inside: summarize → confirm → pick step one level up; the
  // terminal states (the restoring wait, the failure card) and the pick
  // list go straight home. Scoping esc here also returns 'n'/'y' to the
  // summarize feedback box — the retired Confirmation-context block ate
  // them as confirm verbs.
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
    { context: 'MessageSelector' },
  )

  // The branch forks the SESSION BEING SHOWN — its transcript file through
  // the focused connector, the way the rerun path reads it (FN-015 rank 68:
  // reading the screen process's own session id found no file, or the
  // wrong one). A rejected read lands on the error card, never unobserved.
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
      const transcriptEntries = await readAllTranscriptEntries(transcriptPath)
      const ordinal = transcriptEntries.findIndex(
        entry => (entry as { uuid?: string }).uuid === chosen.uuid,
      )
      if (ordinal === -1) {
        setErrorText('branch point not found in the committed transcript')
        return
      }
      const branch = createBranchSession({
        sourceTranscriptPath: transcriptPath,
        // forkOrdinal is a COUNT of covered entries: the fork boundary is
        // INCLUSIVE of the anchor row, so the prefix covers index + 1
        // entries (rerun's rewind boundary passes the bare index instead).
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

  // ── rendering ────────────────────────────────────────────────────────────
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

  if (phase === 'pick') {
    const nothingToRewind = selectable.length === 0
    const half = Math.floor(VISIBLE_ROWS / 2)
    const start = Math.max(
      0,
      Math.min(index - half, entries.length - VISIBLE_ROWS),
    )
    const visible = entries.slice(start, start + VISIBLE_ROWS)
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>{'─'.repeat(Math.max(8, Math.min(60, columns - 4)))}</Text>
        <Text bold>Rewind</Text>
        {nothingToRewind ? (
          <Text dimColor>There is nothing to rewind to yet.</Text>
        ) : (
          <Text dimColor>
            {historyOn
              ? 'Wind back to a saved point — the files, the conversation, or both.'
              : checkpoints.capture === 'off'
                ? 'File checkpoints are off for this session (Settings › File checkpointing) — the conversation can still be restored or forked.'
                : "This session's runner reports no checkpoint capture (an older runner — /daemon restart when ready); the conversation can still be restored or forked."}
          </Text>
        )}
        {visible.map((entry, offset) => {
          const entryIndex = start + offset
          const focused = entryIndex === index
          if (entry === CURRENT_PROMPT) {
            return (
              <Box key="current">
                <Text color={focused ? tokens.accent : undefined}>
                  {focused ? `${figures.pointer} ` : '  '}
                  <Text italic dimColor>
                    (current prompt)
                  </Text>
                </Text>
              </Box>
            )
          }
          const preview = previewOf(entry, columns - 24)
          const between = historyOn
            ? statsBetween(
                messages,
                entry.uuid,
                entries[entryIndex + 1] === CURRENT_PROMPT
                  ? undefined
                  : (entries[entryIndex + 1] as UserMessage | undefined)?.uuid,
              )
            : null
          const canRestore = historyOn && hasSavedPoint(entry.uuid)
          return (
            <Box key={entry.uuid} flexDirection="column">
              <Text color={focused ? tokens.accent : undefined}>
                {focused ? `${figures.pointer} ` : '  '}
                {preview.shell ? (
                  <Text color={tokens.warning}>{preview.text}</Text>
                ) : (
                  <Text>{preview.text}</Text>
                )}
              </Text>
              {historyOn && between !== null ? (
                <Text dimColor>
                  {'    '}
                  {!canRestore
                    ? 'no saved files at this point'
                    : between.files.length === 0
                      ? 'no code changes'
                      : `${describeFiles(between.files)} +${between.insertions} -${between.deletions}`}
                </Text>
              ) : null}
            </Box>
          )
        })}
        <Text dimColor>↑↓ select · ↵ choose · esc close</Text>
      </Box>
    )
  }

  if (!chosen) {
    close()
    return null
  }

  if (phase === 'summarize') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={tokens.borderSubtle} paddingX={1} gap={1}>
        <Text bold>Summarise from this point</Text>
        <Text dimColor>
          Optional extra context for the summary (empty cancels):
        </Text>
        <TextInput
          value={feedback}
          onChange={setFeedback}
          onSubmit={value => {
            const trimmed = value.trim()
            if (trimmed === '') {
              setPhase('confirm')
              return
            }
            onPreRestore()
            void onSummarize(chosen, trimmed, 'from')
            close()
          }}
          columns={Math.max(30, columns - 8)}
          cursorOffset={feedbackCursor}
          onChangeCursorOffset={setFeedbackCursor}
        />
      </Box>
    )
  }

  // ── confirm ──────────────────────────────────────────────────────────────
  // The options say exactly what the runner does (FN-015 rank 8): the
  // files go back to their saved bytes, the conversation winds back to
  // before this point — later rows leave the model's view while the
  // transcript keeps them — and the session keeps its identity. A code
  // restore is offered only where the session's facts hold a saved point.
  const canRestoreCode = historyOn && hasSavedPoint(chosen.uuid)
  const preview = previewOf(chosen, columns - 16)
  const age = formatRelativeTimeAgo(new Date(chosen.timestamp))
  const conversationText =
    'The conversation winds back to before this point — later messages leave the model\'s view (the transcript keeps them)'

  type ConfirmOption = { label: string; value: string; description: string }
  const options: ConfirmOption[] = []
  if (canRestoreCode) {
    options.push({
      label: 'Restore code and conversation',
      value: 'both',
      description: `The files go back to their saved state at this point; ${conversationText.charAt(0).toLowerCase()}${conversationText.slice(1)}.`,
    })
    options.push({
      label: 'Restore conversation only',
      value: 'conversation',
      description: `${conversationText}; the files are unchanged.`,
    })
    options.push({
      label: 'Restore code only',
      value: 'code',
      description: 'The files go back to their saved state at this point; the conversation is unchanged.',
    })
  } else {
    options.push({
      label: 'Restore conversation',
      value: 'conversation',
      description: `${conversationText}; no saved files at this point, so the files are unchanged.`,
    })
  }
  if (onViewOnly) {
    options.push({
      label: 'View history read-only (nothing is mutated)',
      value: 'view',
      description: 'Nothing changes — a read-only view of the history.',
    })
  }
  if (onBranchCreated) {
    options.push({
      label: 'Create a branch session from here (this one is untouched)',
      value: 'branch',
      description:
        'A new branch session is created from this point; the current conversation stays untouched.',
    })
  }
  if (onRerun) {
    options.push({
      label: 'Rerun from here on a new branch (this session is untouched)',
      value: 'rerun',
      description:
        'A new branch reruns this message; the current session is untouched.',
    })
  }
  options.push({
    label: 'Summarise from here…',
    value: 'summarize',
    description: 'Messages after this point will be summarised.',
  })
  options.push({
    label: 'Never mind',
    value: 'cancel',
    description: 'The conversation is unchanged.',
  })

  const codeLine = (value: string): string | null => {
    if (value === 'summarize') return null
    if (value === 'both' || value === 'code') {
      if (storeStats === undefined) return 'Asking the session what a restore would touch…'
      if (storeStats.filesChanged.length === 0) {
        return 'The files already match this point.'
      }
      return `Restores ${describeFiles(storeStats.filesChanged)} +${storeStats.insertions} -${storeStats.deletions}.`
    }
    return 'The files are unchanged.'
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tokens.borderSubtle} paddingX={1} gap={1}>
      <Text>
        <Text bold>{preview.text}</Text> <Text dimColor>({age})</Text>
      </Text>
      <Select
        options={options.map(option => ({
          label: option.label,
          value: option.value,
        }))}
        defaultFocusValue={canRestoreCode ? 'both' : 'conversation'}
        inlineDescriptions={false}
        onFocus={value => setFocusedConfirm(value)}
        onChange={value => {
          if (value === 'cancel') {
            if (openedPreselected.current) close()
            else setPhase('pick')
            return
          }
          if (value === 'view') {
            onViewOnly?.()
            close()
            return
          }
          if (value === 'branch') {
            void runBranch()
            return
          }
          if (value === 'rerun') {
            void runRerun()
            return
          }
          if (value === 'summarize') {
            setPhase('summarize')
            return
          }
          void runRestore(value as 'both' | 'conversation' | 'code')
        }}
        onCancel={() => {
          if (openedPreselected.current) close()
          else setPhase('pick')
        }}
      />
      <Box flexDirection="column">
        <Text dimColor>
          {(options.find(option => option.value === focusedConfirm) ??
            options[0])!.description}
        </Text>
        {codeLine(focusedConfirm) !== null ? (
          <Text dimColor>{codeLine(focusedConfirm)}</Text>
        ) : null}
      </Box>
      {canRestoreCode ? (
        <Text dimColor>
          A file edited by hand since the session last touched it is refused by name — nothing is restored until you reconcile it.
        </Text>
      ) : null}
    </Box>
  )
}

export default MessageSelector
