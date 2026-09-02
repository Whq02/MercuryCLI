import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { CommandCenter } from '../../components/mercury-ui/components.js'
import { GLYPH, truncateToWidth } from '../../components/mercury-ui/glyphs.js'
import { useSessionAccent } from '../../components/mercury-ui/sessionAccent.js'
import { CursorCell, WorkingGlyph } from '../../components/mercury-ui/LiveGlyphs.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../../components/mercuryPalette.js'
import { Markdown } from '../../components/Markdown.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import ScrollBox, {
  type ScrollBoxHandle,
} from '../../ink/components/ScrollBox.js'
import { isTopOverlayNow, useRegisterOverlay } from '../../context/overlayContext.js'
import { Box, Text, useInput } from '../../ink.js'
import TextInput from '../../components/TextInput.js'
import { paneWindow } from '../../components/mercury-ui/geometry.js'
import { decodeNavKey } from '../../components/mercury-ui/navSemantics.js'
import { useOpenEventGate } from '../../components/mercury-ui/useOpenEventGate.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { ProcessUserInputContext } from '../../utils/processUserInput/processUserInput.js'
import {
  consoleAsk,
  consoleClear,
  getConsoleEntries,
  getConsolePending,
  getConsoleVersion,
  subscribeConsole,
  type ConsoleEntry,
} from '../../utils/cockpit/helmConsole.js'
import { fmtTok } from '../../utils/cockpit/helmConsoleText.js'
import { currentInterviewRef } from '../../services/interview/store.js'
import { runConsoleAsk } from '../../utils/cockpit/helmConsoleAsk.js'
import { renderModelName } from '../../utils/model/model.js'
import { consoleModelOverride, resolveSubModel } from '../../utils/model/subModelSlots.js'
import { useNowTick } from '../../components/mercury-ui/components.js'


const LIST_ROWS = 5
const SCROLL_LINES = 4

function hhmm(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--:--'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function ConsoleView({
  onClose,
  context,
  initialQuestion,
}: {
  onClose: () => void
  context: ProcessUserInputContext
  initialQuestion?: string
}): React.ReactNode {
  const accent = useSessionAccent().accent
  const { columns, rows } = useTerminalSize()
  const width = Math.max(60, Math.min(110, columns - 4))
  const bodyW = width - 4

  const [, force] = useState(0)
  useEffect(() => subscribeConsole(() => force(n => n + 1)), [])
  const entries = getConsoleEntries()
  const pending = getConsolePending()

  const [sel, setSel] = useState(() => Math.max(0, entries.length - 1))
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<ScrollBoxHandle>(null)
  const now = useNowTick(pending ? 1000 : null)

  const lastLen = useRef(entries.length)
  useEffect(() => {
    if (entries.length !== lastLen.current) {
      if (sel >= lastLen.current - 1) setSel(Math.max(0, entries.length - 1))
      lastLen.current = entries.length
    }
  }, [entries.length, sel])

  const pastGate = useOpenEventGate()
  const [cursorOffset, setCursorOffset] = useState(0)
  const overlayToken = useRegisterOverlay('console', true)

  const askedInitial = useRef(false)
  useEffect(() => {
    if (askedInitial.current || !initialQuestion) return
    askedInitial.current = true
    const originMatch = /^--origin=(\S+)\s+/.exec(initialQuestion)
    const originRef =
      originMatch?.[1] !== undefined
        ? decodeURIComponent(originMatch[1])
        : (currentInterviewRef() ?? undefined)
    const bare = originMatch ? initialQuestion.slice(originMatch[0].length) : initialQuestion
    consoleAsk(bare, (q, ctrl) =>
      runConsoleAsk({
        question: q,
        context,
        abortController: ctrl,
        ...(originRef !== undefined ? { originRef } : {}),
      }),
    )
  }, [initialQuestion, context])

  const submit = (): void => {
    if (!pastGate()) return
    const q = draft.trim()
    if (!q || pending) return
    const interviewRef = currentInterviewRef() ?? undefined
    const ok = consoleAsk(q, (question, ctrl) =>
      runConsoleAsk({
        question,
        context,
        abortController: ctrl,
        ...(interviewRef !== undefined ? { originRef: interviewRef } : {}),
      }),
    )
    if (ok) setDraft('')
  }

  useInput((input, key, event) => {
    const action = decodeNavKey(input, key, { orientation: 'vertical', pageKeys: true })
    if (action === 'cancel') {
      if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
      event.stopImmediatePropagation()
      onClose()
      return
    }
    if (action === 'movePrevious') {
      event.stopImmediatePropagation()
      setSel(s => Math.max(0, s - 1))
      return
    }
    if (action === 'moveNext') {
      event.stopImmediatePropagation()
      setSel(s => Math.min(Math.max(0, entries.length - 1), s + 1))
      return
    }
    if (action === 'pagePrevious') {
      event.stopImmediatePropagation()
      scrollRef.current?.scrollBy(-SCROLL_LINES)
      return
    }
    if (action === 'pageNext') {
      event.stopImmediatePropagation()
      scrollRef.current?.scrollBy(SCROLL_LINES)
      return
    }
    if (key.ctrl && input === 'l') {
      event.stopImmediatePropagation()
      consoleClear()
      setSel(0)
      return
    }
  })

  const shownStart = paneWindow(entries.length, sel, LIST_ROWS).start
  const shown = entries.slice(shownStart, shownStart + LIST_ROWS)
  const current: ConsoleEntry | undefined = entries[Math.min(sel, Math.max(0, entries.length - 1))]
  const answerHeight = Math.max(6, rows - 10 - Math.min(entries.length, LIST_ROWS))
  const slot = resolveSubModel('console')
  const subtitle =
    slot.origin === 'unset'
      ? `unset · ${slot.hint}`
      : `${renderModelName(slot.model)}${consoleModelOverride(context.options.mainLoopModel) === undefined ? ' · zero usage until ↵' : ' · ≠ main: re-reads ctx per ↵'}`

  return (
    <CommandCenter
      view="console"
      subtitle={subtitle}
      footer="↑↓ select · pgup/pgdn scroll · ↵ ask · ^l clear · esc close"
      onClose={onClose}
      captureInput={false}
      closeKeys="esc"
    >
      <Box flexDirection="column" width={width}>
        {}
        {entries.length === 0 && !pending ? (
          <Text color={FAINT}>no asks yet — type a question and press ↵</Text>
        ) : (
          shown.map((e, i) => {
            const idx = shownStart + i
            const selRow = idx === Math.min(sel, entries.length - 1)
            const receipt = e.usage
              ? ` ${fmtTok(e.usage.in + e.usage.cacheRead + e.usage.cacheWrite)}→${fmtTok(e.usage.out)}`
              : e.error
                ? ' err'
                : ''
            return (
              <Box key={e.id} width={width}>
                <Text wrap="truncate-end">
                  <CursorCell focused={selRow} color={accent} />
                  <Text color={FAINT}>{`${hhmm(e.askedAt)} `}</Text>
                  <Text color={selRow ? IVORY : SECOND} bold={selRow}>
                    {truncateToWidth(e.question, Math.max(8, bodyW - 16))}
                  </Text>
                  <Text color={e.error ? AMBER : FAINT}>{receipt}</Text>
                </Text>
              </Box>
            )
          })
        )}
        {entries.length > shown.length ? (
          <Text color={FAINT}>{`  +${entries.length - shown.length} more`}</Text>
        ) : null}

        {}
        {pending ? (
          <Box marginTop={1}>
            <Text wrap="truncate-end">
              <WorkingGlyph color={TEAL} active />
              <Text> </Text>
              <Text color={IVORY}>{truncateToWidth(pending.question, bodyW - 12)}</Text>
              <Text color={FAINT}>{` · ${Math.max(0, Math.round((now - pending.startedAt) / 1000))}s`}</Text>
            </Text>
          </Box>
        ) : null}

        {}
        {current ? (
          <Box marginTop={1} flexDirection="column">
            <Box width={width}>
              <Text wrap="truncate-end">
                <Text color={accent} bold>
                  {GLYPH.prompt}{' '}
                </Text>
                <Text color={IVORY}>{truncateToWidth(current.question, bodyW - 2)}</Text>
              </Text>
            </Box>
            <Box marginLeft={2} maxHeight={answerHeight}>
              <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
                {current.error ? (
                  <Text color={CRIMSON}>{`${GLYPH.fail} ${current.error}`}</Text>
                ) : current.answer ? (
                  <Markdown>{current.answer}</Markdown>
                ) : (
                  <Text color={FAINT}>answering…</Text>
                )}
              </ScrollBox>
            </Box>
            {current.usage || current.durationMs != null ? (
              <Box marginLeft={2}>
                <Text color={FAINT}>
                  {[
                    current.durationMs != null
                      ? `${Math.max(1, Math.round(current.durationMs / 1000))}s`
                      : null,
                    current.usage
                      ? `${fmtTok(current.usage.in + current.usage.cacheRead + current.usage.cacheWrite)}→${fmtTok(current.usage.out)} tok`
                      : null,
                    current.usage && current.usage.cacheRead > 0 ? 'cache-hit' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </Box>
            ) : null}
          </Box>
        ) : null}

        {
}
        <Box marginTop={1} width={width}>
          <Text color={accent}>{`${GLYPH.prompt} `}</Text>
          <TextInput
            value={draft}
            onChange={d => setDraft(d.replace(/[\r\n\t]+/g, ' ').slice(0, 2000))}
            onSubmit={() => submit()}
            focus={true}
            showCursor={true}
            multiline={false}
            disableCursorMovementForUpDownKeys={true}
            columns={bodyW - 2}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            placeholder={pending ? 'answering — ↵ queues nothing, wait for the result' : 'ask anything…'}
          />
        </Box>
      </Box>
    </CommandCenter>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ProcessUserInputContext,
  args: string,
): Promise<React.ReactNode> {
  const question = args?.trim()
  if (question?.toLowerCase() === 'clear') {
    const had = consoleClear()
    onDone(had ? 'Console cleared' : 'Console already empty', {
      display: 'system',
    })
    return null
  }
  return (
    <ConsoleView
      onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }}
      context={context}
      initialQuestion={question || undefined}
    />
  )
}
