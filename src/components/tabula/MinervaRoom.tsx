import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { useSessionConnector } from '../../hooks/useSessionConnector.js'
import { resolveSubModel } from '../../utils/model/subModelSlots.js'
import {
  getSavedPromptsProblem,
  getSavedPromptsSnapshot,
  subscribeSavedPrompts,
  type SavedPromptV1,
} from '../../utils/savedPrompts/savedPromptsStore.js'
import {
  abortMinervaRoomExchange,
  getMinervaRoomExchanges,
  getMinervaRoomPending,
  getMinervaRoomVersion,
  MAX_ROOM_MESSAGE_CHARS,
  submitMinervaRoomMessage,
  subscribeMinervaRoom,
  takeMinervaRoomStagedDraft,
  takeMinervaRoomStagedDraftDroppedChars,
} from '../../utils/tabula/minervaRoom.js'
import { tabulaProjectDir } from '../../utils/tabula/tabulaGates.js'
import TextInput from '../TextInput.js'
import { CommandCenter, EmptyState, SectionHeader } from '../mercury-ui/components.js'
import { GLYPH, truncateToWidth } from '../mercury-ui/glyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { promptRows } from '../prompts-panel/rows.js'


const SHOW_EXCHANGES = 6
const SHOW_PROMPTS = 12
const COMPOSER_COLUMNS = 96

export function MinervaRoom({
  cwd,
  onClose,
}: {
  cwd: string
  onClose: (nextInput?: string) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const connector = useSessionConnector()
  const subscribeRecords = React.useCallback((cb: () => void) => connector.subscribeRecords(cb), [connector])
  const readRecords = React.useCallback(() => connector.records(), [connector])
  const records = React.useSyncExternalStore(subscribeRecords, readRecords, readRecords)
  const workspace = connector.workspace()
  const project = workspace.projectRoot || workspace.cwd

  const drafts = React.useSyncExternalStore(
    React.useCallback((cb: () => void) => subscribeSavedPrompts(project, cb), [project]),
    React.useCallback(() => getSavedPromptsSnapshot(project), [project]),
    React.useCallback(() => getSavedPromptsSnapshot(project), [project]),
  )
  const problem = React.useSyncExternalStore(
    React.useCallback((cb: () => void) => subscribeSavedPrompts(project, cb), [project]),
    React.useCallback(() => getSavedPromptsProblem(project), [project]),
    React.useCallback(() => getSavedPromptsProblem(project), [project]),
  )
  const roomVersion = React.useSyncExternalStore(subscribeMinervaRoom, getMinervaRoomVersion, getMinervaRoomVersion)
  const exchanges = getMinervaRoomExchanges()
  const pending = getMinervaRoomPending()

  const slot = resolveSubModel('minerva')

  const sentPrompts = React.useMemo(() => promptRows(records).map(r => r.text), [records])

  const list: SavedPromptV1[] = drafts ?? []
  const shown = list.slice(-SHOW_PROMPTS)
  const hidden = list.length - shown.length

  const [buffer, setBuffer] = React.useState('')
  const [cursor, setCursor] = React.useState(0)
  const [note, setNote] = React.useState<string | null>(null)

  const [focusSeat, setFocusSeat] = React.useState<'list' | 'box'>('list')
  const [sel, setSel] = React.useState<number | null>(null)
  const listFocus = focusSeat === 'list' && shown.length > 0
  const selIdx = shown.length === 0 ? 0 : Math.min(sel ?? shown.length - 1, shown.length - 1)

  const submit = React.useCallback((): void => {
    const text = buffer.trim()
    if (!text) return
    if (pending) {
      setNote('minerva is still thinking — ↵ again when the reply lands')
      return
    }
    setBuffer('')
    setCursor(0)
    setNote(null)
    void submitMinervaRoomMessage(project, text, sentPrompts)
  }, [buffer, pending, project, sentPrompts])

  const stageIntoBox = React.useCallback(
    (text: string): void => {
      const t = text.trim().slice(0, MAX_ROOM_MESSAGE_CHARS)
      if (!t) return
      if (buffer.trim().length > 0 && buffer !== t) {
        setNote('the box already holds a draft — send or clear it, then m again')
        return
      }
      setBuffer(t)
      setCursor(t.length)
      setFocusSeat('box')
      setNote(null)
    },
    [buffer],
  )

  React.useEffect(() => {
    const staged = takeMinervaRoomStagedDraft()
    const dropped = takeMinervaRoomStagedDraftDroppedChars()
    if (staged !== null) {
      stageIntoBox(staged)
      if (dropped > 0) {
        setNote(
          `staged the first ${MAX_ROOM_MESSAGE_CHARS} chars — ${dropped} past the room's ceiling stayed in the saved prompt (unchanged)`,
        )
      }
    }
  }, [roomVersion, stageIntoBox])

  const sendSelected = React.useCallback((): void => {
    if (shown.length === 0) return
    if (pending) {
      setNote('minerva is still thinking — ↵ again when the reply lands')
      return
    }
    const d = shown[selIdx]
    if (!d) return
    const n = list.findIndex(x => x.id === d.id) + 1
    setNote(null)
    void submitMinervaRoomMessage(project, `refine prompt ${n}`, sentPrompts)
  }, [shown, selIdx, list, pending, project, sentPrompts])

  const [escArmed, setEscArmed] = React.useState(false)
  const isPending = pending !== null
  React.useEffect(() => {
    if (!isPending) {
      setEscArmed(false)
      setNote(n => (n !== null && n.startsWith('minerva is still running') ? null : n))
    }
  }, [isPending])
  useInput(
    (_input, key, event) => {
      if (escArmed && !key.escape) setEscArmed(false)
      if (key.escape) {
        event.stopImmediatePropagation()
        if (!listFocus && pending) {
          if (escArmed) {
            setEscArmed(false)
            abortMinervaRoomExchange()
            setNote('aborted — nothing landed')
            return
          }
          setEscArmed(true)
          setNote('minerva is still running — esc again interrupts her (nothing lands)')
          return
        }
        if (!listFocus && !pending && shown.length > 0) {
          setFocusSeat('list')
          return
        }
        onClose()
        return
      }
      if (key.tab) {
        event.stopImmediatePropagation()
        if (shown.length === 0) return
        setFocusSeat(listFocus ? 'box' : 'list')
        return
      }
      if (!listFocus) {
        if (key.upArrow && buffer === '' && shown.length > 0) {
          event.stopImmediatePropagation()
          setSel(shown.length - 1)
          setFocusSeat('list')
        }
        return
      }
      if (key.upArrow) {
        event.stopImmediatePropagation()
        setSel(Math.max(0, selIdx - 1))
        return
      }
      if (key.downArrow) {
        event.stopImmediatePropagation()
        if (selIdx >= shown.length - 1) setFocusSeat('box')
        else setSel(selIdx + 1)
        return
      }
      if (key.return) {
        event.stopImmediatePropagation()
        sendSelected()
        return
      }
      if ((_input === 'm' || _input === 'M') && !key.ctrl && !key.meta) {
        const d = shown[selIdx]
        if (d) stageIntoBox(d.text)
        return
      }
      if ((_input === 's' || _input === 'S') && !key.ctrl && !key.meta) {
        const d = shown[selIdx]
        if (!d) return
        if (d.refinedText === undefined) {
          setNote('no refinement beside this prompt yet — ↵ asks minerva for one')
          return
        }
        onClose(d.refinedText)
        return
      }
    },
    { isActive: true },
  )

  const notepadPath = join(tabulaProjectDir(cwd), 'notepad.md')
  const notesOnDisk = existsSync(notepadPath)

  const modelSet = slot.origin !== 'unset'
  const selectedHasRefined = listFocus && shown[selIdx]?.refinedText !== undefined
  const footer = pending
    ? listFocus
      ? 'esc close · minerva keeps thinking'
      : 'esc·esc interrupt'
    : listFocus
      ? `↵ ask minerva to refine${modelSet ? ' (one billed call)' : ''} · ↑↓ pick${selectedHasRefined ? ' · s send refined to composer' : ''} · m edit in message box · tab message box · esc close`
      : `↵ send to minerva${modelSet ? ' (one billed call)' : ''} · tab prompt list · esc ${shown.length > 0 ? 'back to list' : 'close'}`

  return (
    <CommandCenter view="tabula" subtitle="Minerva's room" onClose={onClose} captureInput={false} footer={footer}>
      <Box marginTop={1} flexDirection="column">
        {modelSet ? (
          <>
            <Text color={tokens.textSecondary} wrap="truncate-end">
              <Text color={tokens.info}>{GLYPH.sparkBright}</Text>
              {` minerva · ${slot.model}`}
            </Text>
            <Text color={tokens.textMuted} wrap="truncate-end">
              {'  refines a saved prompt only when you ask · never sends anything'}
            </Text>
          </>
        ) : (
          <Text color={tokens.warning} wrap="truncate-end">
            {`${GLYPH.warn} no Minerva model set — /submodels pins one · your saved prompts sit as written`}
          </Text>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <SectionHeader count={list.length}>saved prompts</SectionHeader>
        {problem !== null ? (
          <Text color={tokens.warning} wrap="truncate-end">
            {`${GLYPH.warn} the saved-prompts file could not be read (${truncateToWidth(problem, 40)}) — /workbench · SAVED PROMPTS · a writes a fresh list`}
          </Text>
        ) : drafts === null ? (
          <Text color={tokens.textMuted}>{`${GLYPH.drifting} reading saved prompts …`}</Text>
        ) : list.length === 0 ? (
          <EmptyState
            glyph={GLYPH.sparkFaint}
            title="no saved prompts yet"
            hint="/workbench · SAVED PROMPTS · a writes one — Minerva refines them here when you ask"
          />
        ) : (
          <>
            {hidden > 0 ? <Text color={tokens.textMuted}>{`    +${hidden} earlier`}</Text> : null}
            {shown.map((d, i) => {
              const n = list.length - shown.length + i + 1
              const isSel = listFocus && i === selIdx
              return (
                <Box key={d.id} flexDirection="column">
                  <Text wrap="truncate-end">
                    <Text color={tokens.accent}>{isSel ? `${GLYPH.prompt} ` : '  '}</Text>
                    <Text color={tokens.textMuted}>{`${String(n).padStart(3, ' ')}  `}</Text>
                    <Text color={tokens.textPrimary}>{truncateToWidth(d.text, 82)}</Text>
                  </Text>
                  {d.refinedText ? (
                    <Text wrap="truncate-end">
                      <Text color={isSel ? tokens.accent : tokens.info}>{`       ${isSel ? GLYPH.sparkBright : GLYPH.sparkFaint} `}</Text>
                      <Text color={isSel ? tokens.textPrimary : tokens.textSecondary}>{truncateToWidth(d.refinedText, 80)}</Text>
                    </Text>
                  ) : null}
                  {d.refinedText && isSel ? (
                    <Text wrap="truncate-end">
                      <Text color={tokens.accent} bold>{`         s sends this refined prompt to the composer`}</Text>
                    </Text>
                  ) : null}
                </Box>
              )
            })}
          </>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <SectionHeader count={exchanges.length}>the conversation</SectionHeader>
        {exchanges.length === 0 && !pending ? (
          <Text color={tokens.textMuted}>
            {modelSet
              ? 'nothing asked yet — name a saved prompt and what you want changed'
              : 'nothing asked yet — pin a Minerva model first (/submodels); until then it answers with that hint'}
          </Text>
        ) : null}
        {exchanges.slice(-SHOW_EXCHANGES).map((x, i) => (
          <Box key={`${x.askedAt}-${i}`} flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={tokens.accent}>{`${GLYPH.prompt} `}</Text>
              <Text color={tokens.textPrimary}>{truncateToWidth(x.message, 90)}</Text>
            </Text>
            <Text wrap="wrap">
              <Text color={x.error ? tokens.failure : tokens.info}>{`  ${x.error ? GLYPH.fail : GLYPH.sparkBright} `}</Text>
              <Text color={x.error ? tokens.warning : tokens.textSecondary}>
                {x.error ?? x.reply ?? ''}
                {x.refined ? <Text color={tokens.accent}>{`  (${x.refined} refined · beside your wording · s sends it)`}</Text> : null}
              </Text>
            </Text>
          </Box>
        ))}
        {pending ? (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={tokens.accent}>{`${GLYPH.prompt} `}</Text>
              <Text color={tokens.textPrimary}>{truncateToWidth(pending.message, 90)}</Text>
            </Text>
            <Text color={tokens.textMuted}>{`  ${GLYPH.busy} minerva thinking …`}</Text>
          </Box>
        ) : null}
      </Box>

      {note ? (
        <Box marginTop={1}>
          <Text color={tokens.warning}>{truncateToWidth(note, 90)}</Text>
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text color={tokens.textSecondary} wrap="truncate-end">
          {'message minerva'}
          {
}
          <Text color={tokens.textMuted}>{'   e.g. "tighten prompt 2" — the refinement lands beside your original'}</Text>
        </Text>
        <Box>
          <Text color={listFocus ? tokens.textMuted : tokens.accent}>{`${GLYPH.prompt} `}</Text>
          <TextInput
            value={buffer}
            onChange={v => setBuffer(v.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_ROOM_MESSAGE_CHARS))}
            onSubmit={() => submit()}
            focus={!listFocus}
            showCursor={!listFocus}
            multiline={false}
            columns={COMPOSER_COLUMNS}
            cursorOffset={cursor}
            onChangeCursorOffset={setCursor}
            disableEscapeDoublePress={true}
          />
        </Box>
      </Box>

      {notesOnDisk ? (
        <Box marginTop={1}>
          {
}
          <Text color={tokens.textMuted} wrap="truncate-middle">
            {`your earlier notes stay readable in ${notepadPath}`}
          </Text>
        </Box>
      ) : null}
    </CommandCenter>
  )
}
