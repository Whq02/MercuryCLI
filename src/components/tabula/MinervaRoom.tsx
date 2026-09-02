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

// ============================================================================
//  MinervaRoom — /tabula, MINERVA'S ROOM (the notepad board retired; the
//  free-notes system shed).
//
//  Shaped like the console: a one-line composer you talk into, the reply
//  painted beneath your line, the last exchanges kept above it. Minerva's
//  one job here is refining your SAVED PROMPTS — listed in the room so
//  "tighten prompt 2" has a number to point at — and a refinement lands
//  BESIDE your wording (✧), never over it. It never sends anything: the
//  prompts panel's `s` is the only hand that reaches the composer.
//
//  FOCUS (the ruled spec): opening the room lands the ARROW FOCUS on the
//  saved-prompts list — ↑↓ pick, ↵ sends that prompt to Minerva for
//  refinement; the chat box stays one ↓ past the list (or tab) for direct
//  messages. esc FROM THE LIST closes the room (a running turn keeps
//  thinking in the module store). At the composer while a turn runs, ONE
//  esc never interrupts her — it paints the again-hint and only ESC·ESC
//  aborts (the room's own special case; the main chat keeps its own
//  one-esc ladder) — esc never interrupts Minerva merely because the box
//  happened to own focus.
//
//  No Minerva model set ⇒ one honest line, and the saved prompts sit.
//  Composing is free; ↵ is the one billed call. Earlier tabula notes stay
//  readable in their plain file on disk — the room points at it and stops
//  offering note-leaving.
// ============================================================================

const SHOW_EXCHANGES = 6
const SHOW_PROMPTS = 12
const COMPOSER_COLUMNS = 96

export function MinervaRoom({
  cwd,
  onClose,
}: {
  cwd: string
  /** Close the room; `nextInput` (when set) lands in the focused chat's
   *  composer — never submitted, the operator reviews first (the workbench
   *  panel's exact contract). */
  onClose: (nextInput?: string) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const connector = useSessionConnector()
  // Bound doors — the daemon-carried connector is a class (see PromptsPanel).
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
  // A damaged saved-prompts file is said out loud here too (the panel's law).
  const problem = React.useSyncExternalStore(
    React.useCallback((cb: () => void) => subscribeSavedPrompts(project, cb), [project]),
    React.useCallback(() => getSavedPromptsProblem(project), [project]),
    React.useCallback(() => getSavedPromptsProblem(project), [project]),
  )
  const roomVersion = React.useSyncExternalStore(subscribeMinervaRoom, getMinervaRoomVersion, getMinervaRoomVersion)
  const exchanges = getMinervaRoomExchanges()
  const pending = getMinervaRoomPending()

  // The model fact, re-read on every paint (a /submodels pick is live on the
  // next ↵ without a restart).
  const slot = resolveSubModel('minerva')

  const sentPrompts = React.useMemo(() => promptRows(records).map(r => r.text), [records])

  const list: SavedPromptV1[] = drafts ?? []
  const shown = list.slice(-SHOW_PROMPTS)
  const hidden = list.length - shown.length

  const [buffer, setBuffer] = React.useState('')
  const [cursor, setCursor] = React.useState(0)
  const [note, setNote] = React.useState<string | null>(null)

  // ── the FOCUS MODEL (the ruled spec) — opening the room lands the arrow
  // focus ON THE SAVED-PROMPTS LIST: ↑↓ move over the prompts, ↵ on one
  // sends it to Minerva for refinement, and the chat box stays one ↓ past
  // the list (or tab) away for direct messages. `sel === null` tracks the
  // NEWEST prompt (the one most likely under discussion) until the operator
  // moves. An empty list has nothing to arrow over, so the box takes the
  // keys until a prompt exists.
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

  // The M key STAGES a saved prompt into the box (the ruled follow-up):
  // the text becomes an ordinary editable draft, focus lands in the box,
  // and NOTHING sends — the operator's own ↵ is the send. A box already
  // holding a different draft refuses with the reason (drafts are never
  // silently clobbered; the saved prompt itself is untouched either way).
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

  // The panel's `m` stages through the module seat and opens the room —
  // take it into the box here (at mount, or on the version bump if the
  // room is already up). take() is null when nothing waits.
  React.useEffect(() => {
    const staged = takeMinervaRoomStagedDraft()
    const dropped = takeMinervaRoomStagedDraftDroppedChars()
    if (staged !== null) {
      stageIntoBox(staged)
      // The ceiling is deliberate; the silence was not (FC-081): a saved
      // prompt longer than the room's ask fits its first slice only, and
      // the operator must hear that here — the saved prompt itself is
      // untouched.
      if (dropped > 0) {
        setNote(
          `staged the first ${MAX_ROOM_MESSAGE_CHARS} chars — ${dropped} past the room's ceiling stayed in the saved prompt (unchanged)`,
        )
      }
    }
  }, [roomVersion, stageIntoBox])

  // ↵ on a selected prompt — the automatic refinement ask: one honest
  // message ("refine prompt N") through the same one-↵ door the composer
  // uses, so the exchange log reads exactly what was asked.
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

  // The room's keys — bound here because the shell is captureInput=false.
  // THE ESC LADDER (the operator's ruled shape, room-scoped): esc FROM THE
  // LIST closes the room — a running turn keeps thinking in the module
  // store (the reply is there on reopen). At the composer while Minerva
  // runs a turn, ONE esc never interrupts her: it paints the hint in the
  // estate's again-grammar and arms ESC·ESC — only the second esc aborts
  // (nothing lands). This is the room's own special case; the MAIN chat
  // stays one-esc-interrupts under its own ladder owner. An idle
  // composer's esc peels one layer back onto the list, draft kept.
  const [escArmed, setEscArmed] = React.useState(false)
  const isPending = pending !== null
  React.useEffect(() => {
    // The turn settled: the arm and its hint are stale — drop both.
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
        // ↑ from an EMPTY box climbs back onto the newest prompt; a box
        // holding a draft keeps its own arrow keys.
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
        // ↓ past the newest prompt lands in the chat box (the ruled road).
        if (selIdx >= shown.length - 1) setFocusSeat('box')
        else setSel(selIdx + 1)
        return
      }
      if (key.return) {
        event.stopImmediatePropagation()
        sendSelected()
        return
      }
      // m — STAGE the selected prompt into the box (never sends; the
      // modifier guard keeps ctrl/alt chords from firing the verb).
      if ((_input === 'm' || _input === 'M') && !key.ctrl && !key.meta) {
        const d = shown[selIdx]
        if (d) stageIntoBox(d.text)
        return
      }
      // s — SEND the refined prompt to the main composer (COORDKEYS item 4:
      // a refinement that lands is usable in one gesture). The room closes
      // and the refined text lands as the composer's draft — never
      // submitted; the operator's own ↵ is the send. Only a row that HAS a
      // refinement answers; on a bare row the key says what is missing.
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
  // The legend says what each key DOES in plain words (the printed-key law;
  // the terse-destination legend class is dead). The s clause appears
  // exactly while the selected prompt HAS a refinement to send.
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
              // The ❯ caret marks the arrow focus — painted only while the
              // list owns the keys, so the landed focus is visible at open.
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
                    // The landing's advert (COORDKEYS item 4): the selected
                    // refined prompt wears its one gesture in the estate's
                    // attention ink — no new chrome, the accent the estate
                    // already speaks.
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
          {/* No bare single letter after a "·" separator — the static
              key-dead scanner reads "· a" as an advertised key token. */}
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
          {/* The path is the point: a config-home path runs past 100 cells,
              so the MIDDLE gives way and the file name survives (an end
              truncation lost `notepad.md` at both sheet sizes). */}
          <Text color={tokens.textMuted} wrap="truncate-middle">
            {`your earlier notes stay readable in ${notepadPath}`}
          </Text>
        </Box>
      ) : null}
    </CommandCenter>
  )
}
