// ============================================================================
//  concourse/SessionWaitingRoom — ruling 4: a
//  QUEUED session is an enterable WAITING ROOM, never a refusal. Same
//  geometry family as the attached surfaces (tag row · body · composer) so promotion
//  to live is one line changing ink, never a scene change. The composer is
//  the shared ConcourseComposer family; every ↵ stacks a message into the
//  durable FIFO that delivers IN ORDER when the session is admitted
//  (content caller-side, the daemon ledger keeps digests).
//  Entering here is seat-neutral by construction: no admission call exists
//  on this path — the room POLLS its reservation and hands an admitted
//  sessionId back to the route, which walks the ordinary enter journey.
// ============================================================================
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { keyHintLabel } from '../mercury-ui/keyHintLabel.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import { ConcourseComposer } from './ConcourseStrips.js'
import { concourseWaitCopy } from './contracts.js'
import {
  backspaceAt,
  deleteAt,
  draftWindow,
  editorMotionOp,
  editorText,
  insertAt,
  type LineDraft,
} from './lineDraft.js'
import {
  appendConcourseQueuedStackEntry,
  readConcourseHeldDispatch,
  readConcourseQueuedStack,
} from '../../services/concourse/concourseSnapshot.js'

const EMPTY_DRAFT: LineDraft = { text: '', caret: 0 }

export function SessionWaitingRoom({
  dispatchId,
  title,
  project,
  onBack,
  onAdmitted,
}: {
  dispatchId: string
  title: string
  project: string
  onBack: () => void
  /** The reservation gained a real session — the route drains the stack and
   *  walks the ordinary enter journey. Fired exactly once. */
  onAdmitted: (sessionId: string) => void
}): React.ReactNode {
  const t = useMercuryTokens()
  const { columns, rows } = useTerminalSize()
  const [draft, setDraft] = useState<LineDraft>(EMPTY_DRAFT)
  const [stack, setStack] = useState<Array<{ clientMessageId: string; text: string }>>([])
  const [brief, setBrief] = useState<string | null>(null)
  const [record, setRecord] = useState<{
    state?: string
    heldReason?: string
    heldByTitle?: string
    reason?: string
    sessionId?: string
  } | null>(null)
  const admittedLatch = useRef(false)
  const load = useCallback(async (): Promise<void> => {
    try {
      const dispatchMod = await import('../../daemon/concourseDispatch.js')
      const rec = dispatchMod.readConcourseDispatches()[dispatchId]
      setRecord(
        rec !== undefined
          ? {
              ...(rec.state !== undefined ? { state: rec.state } : {}),
              ...(rec.heldReason !== undefined ? { heldReason: rec.heldReason } : {}),
              ...(rec.heldByTitle !== undefined ? { heldByTitle: rec.heldByTitle } : {}),
              ...(rec.reason !== undefined ? { reason: rec.reason } : {}),
              ...(rec.sessionId !== undefined ? { sessionId: rec.sessionId } : {}),
            }
          : null,
      )
      if (
        rec?.sessionId !== undefined &&
        rec.state !== 'queued' &&
        rec.state !== 'failed' &&
        !admittedLatch.current
      ) {
        admittedLatch.current = true
        onAdmitted(rec.sessionId)
        return
      }
    } catch {
      /* the ledger is a projection — an unreadable beat never blanks the room */
    }
    try {
      const held = await readConcourseHeldDispatch()
      setBrief(held !== null && held.clientMessageId === dispatchId ? (held.prompt ?? null) : null)
      setStack(await readConcourseQueuedStack(dispatchId))
    } catch {
      /* same projection posture */
    }
  }, [dispatchId, onAdmitted])
  useEffect(() => {
    void load()
    const iv = setInterval(() => void load(), 1200)
    iv.unref?.()
    return () => clearInterval(iv)
  }, [load])
  useInput((input, key, event) => {
    if (key.shift && key.leftArrow) {
      event.stopImmediatePropagation()
      onBack()
      return
    }
    if (key.escape) {
      event.stopImmediatePropagation()
      onBack()
      return
    }
    if (key.return) {
      event.stopImmediatePropagation()
      const text = draft.text.trim()
      if (text.length === 0) return
      setDraft(EMPTY_DRAFT)
      void appendConcourseQueuedStackEntry(dispatchId, text).then(() => void load())
      return
    }
    if (key.backspace) {
      event.stopImmediatePropagation()
      setDraft(d => backspaceAt(d))
      return
    }
    if (key.delete) {
      event.stopImmediatePropagation()
      setDraft(d => deleteAt(d))
      return
    }
    const motion = editorMotionOp(key)
    if (motion !== null) {
      event.stopImmediatePropagation()
      setDraft(motion)
      return
    }
    if (input.length > 0 && !key.ctrl && !key.meta && !key.tab) {
      event.stopImmediatePropagation()
      setDraft(d => insertAt(d, editorText(input)))
    }
  })
  const failed = record !== null && record.state === 'failed'
  const waitCopy = concourseWaitCopy(record?.heldReason, record?.heldByTitle)
  return (
    <Box flexDirection="column" width="100%" height={rows} overflow="hidden">
      <Box height={1} flexShrink={0} flexDirection="row" overflow="hidden">
        <Text color={t.textMuted} wrap="truncate-end">
          {' CONCOURSE ‹ '}
          <Text color={t.accent} bold>
            {title}
          </Text>
          <Text color={t.textMuted}> · {project}</Text>
        </Text>
        <Box flexGrow={1} />
        <Box flexShrink={0}>
          <Text color={t.textMuted}>{keyHintLabel('⇧← back to the concourse ')}</Text>
        </Box>
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={2} marginTop={1} overflow="hidden">
        {brief !== null ? (
          <Box flexDirection="column" flexShrink={1} overflow="hidden">
            <Text color={t.textMuted}>you</Text>
            <Text color={t.accentSoft} wrap="wrap">
              {brief}
            </Text>
          </Box>
        ) : (
          <Text color={t.textMuted} wrap="truncate-end">
            {GLYPH.squareOpen} queued — {title}
          </Text>
        )}
        {stack.length > 0 ? (
          <Box flexDirection="column" marginTop={1} flexShrink={0}>
            {stack.map((e, i) => (
              <Box key={e.clientMessageId} flexDirection="row" overflow="hidden">
                <Text color={t.textMuted}>{i + 1} · </Text>
                <Text color={t.accentSoft} wrap="truncate-end">
                  {e.text}
                </Text>
                {i === 0 ? (
                  <>
                    <Box flexGrow={1} />
                    <Text color={t.textMuted}> delivers in order</Text>
                  </>
                ) : null}
              </Box>
            ))}
          </Box>
        ) : null}
        {failed ? (
          <Box marginTop={1} flexShrink={0}>
            <Text color={t.failureText} wrap="truncate-end">
              ✕ {record?.reason ?? 'the launch failed'} · {keyHintLabel('⇧← back to the concourse')}
            </Text>
          </Box>
        ) : null}
      </Box>
      <ConcourseComposer
        width={Math.max(20, columns - 4)}
        bandRows={draftWindow(draft, 5).bandRows}
        focused
        draft={draft}
        pending={false}
        note={null}
        restHint="add a message — it delivers when the session starts"
        contextLine={
          failed ? null : { tone: 'info', text: `${GLYPH.squareOpen} queued — ${waitCopy}` }
        }
      />
    </Box>
  )
}
