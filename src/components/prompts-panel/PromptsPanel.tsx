import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { basename } from 'node:path'
import { Box, Text, useInput } from '../../ink.js'
import { useSessionConnector } from '../../hooks/useSessionConnector.js'
import {
  addSavedPrompt,
  clearSavedPrompts,
  deleteSavedPrompt,
  editSavedPrompt,
  getSavedPromptsProblem,
  getSavedPromptsSnapshot,
  MAX_SAVED_PROMPT_CHARS,
  moveSavedPrompt,
  subscribeSavedPrompts,
  type SavedPromptV1,
} from '../../utils/savedPrompts/savedPromptsStore.js'
import { COMPOSER_COLUMNS, promptsComposerRows } from './composerLayout.js'
import TextInput from '../TextInput.js'
import { KeyValueGrid, type KVRow } from '../mercury-ui/components.js'
import { GLYPH, truncateToWidth } from '../mercury-ui/glyphs.js'
import {
  NavigablePanes,
  type ColumnDef,
  type RowAction,
  type SectionDef,
} from '../mercury-ui/NavigablePanes.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import {
  clockOf,
  clockSecondsOf,
  crewTrafficRows,
  limitsLine,
  promptRows,
  recordLimits,
  type CrewTrafficRow,
  type PromptRow,
} from './rows.js'


type SavedRow = { kind: 'saved'; key: string; n: number; draft: SavedPromptV1 }
type Row = PromptRow | CrewTrafficRow | SavedRow

type SectionId = 'prompts' | 'crew' | 'saved'

type Editor =
  | { kind: 'add'; buffer: string }
  | { kind: 'edit'; id: string; n: number; buffer: string }
  | { kind: 'confirm-clear'; count: number }
  | null

type Note = { text: string; tone: 'ok' | 'warn' } | null

const SIDE_BODY_CHARS = 240

function modeLabel(mode: PromptRow['mode']): string {
  return mode === 'plain' ? 'plain' : mode === 'bash' ? 'bash' : 'slash'
}

function processStartedAtIso(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString()
}

export function PromptsPanel({
  onClose,
}: {
  onClose: (nextInput?: string) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const connector = useSessionConnector()
  const subscribeRecords = useCallback((cb: () => void) => connector.subscribeRecords(cb), [connector])
  const readRecords = useCallback(() => connector.records(), [connector])
  const records = useSyncExternalStore(subscribeRecords, readRecords, readRecords)
  const workspace = connector.workspace()
  const sessionId = connector.sessionId()
  const project = workspace.projectRoot || workspace.cwd

  const drafts = useSyncExternalStore(
    useCallback((cb: () => void) => subscribeSavedPrompts(project, cb), [project]),
    useCallback(() => getSavedPromptsSnapshot(project), [project]),
    useCallback(() => getSavedPromptsSnapshot(project), [project]),
  )
  const problem = useSyncExternalStore(
    useCallback((cb: () => void) => subscribeSavedPrompts(project, cb), [project]),
    useCallback(() => getSavedPromptsProblem(project), [project]),
    useCallback(() => getSavedPromptsProblem(project), [project]),
  )

  const [section, setSection] = useState<SectionId>('prompts')
  const [editor, setEditor] = useState<Editor>(null)
  const [editorCursor, setEditorCursor] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [note, setNote] = useState<Note>(null)
  const startedAtRef = useRef(processStartedAtIso())

  const prompts = useMemo(() => promptRows(records), [records])
  const queuedCount = prompts.filter(row => row.queued === true).length
  const crew = useMemo(() => crewTrafficRows(records), [records])
  const saved = useMemo<SavedRow[]>(
    () => (drafts ?? []).map((d, i) => ({ kind: 'saved', key: `saved:${d.id}`, n: i + 1, draft: d })),
    [drafts],
  )
  const limits = useMemo(() => recordLimits(records, startedAtRef.current), [records])

  const sections = useMemo<SectionDef<Row>[]>(
    () => [
      {
        id: 'prompts',
        label: 'PROMPTS',
        rows: prompts,
        emptyHint: 'no prompts sent in this chat yet — the roll fills as you send',
      },
      {
        id: 'crew',
        label: 'CREW TRAFFIC',
        count: crew.filter(r => r.kind === 'crew').length,
        rows: crew,
        emptyHint: 'no agent traffic this session',
      },
      {
        id: 'saved',
        label: 'SAVED PROMPTS',
        rows: saved,
        emptyHint:
          problem !== null
            ? `the saved-prompts file could not be read (${truncateToWidth(problem, 40)}) — a writes a fresh list; the damaged copy is kept beside it`
            : drafts === null
              ? 'reading saved prompts…'
              : 'no saved prompts yet — a writes one',
      },
    ],
    [prompts, crew, saved, drafts, problem],
  )

  const columns = useMemo<ColumnDef<Row>[]>(() => {
    if (section === 'crew') {
      return [
        {
          key: 'time',
          header: 'time',
          width: 5,
          cell: row => (
            <Text color={tokens.textMuted}>{row.kind === 'crew' ? clockOf(row.at) : ''}</Text>
          ),
        },
        {
          key: 'agent',
          header: 'agent',
          width: 18,
          cell: row =>
            row.kind === 'crew-thread' ? (
              <Text color={tokens.textPrimary} bold wrap="truncate-end">
                {row.agent}
              </Text>
            ) : row.kind === 'crew' ? (
              <Text color={row.dir === 'to' ? tokens.textSecondary : tokens.info} wrap="truncate-end">
                {row.dir === 'to' ? `${GLYPH.chevronRight} to ${row.agent}` : `${GLYPH.chevronDown} ${row.agent} replied`}
              </Text>
            ) : (
              <Text />
            ),
        },
        {
          key: 'body',
          header: 'message',
          cell: row =>
            row.kind === 'crew-thread' ? (
              <Text color={tokens.textMuted}>
                {row.count === 1 ? '1 message' : `${row.count} messages`} · last {clockOf(row.lastAt)}
              </Text>
            ) : row.kind === 'crew' ? (
              <Text color={tokens.textPrimary} wrap="truncate-end">
                {row.via === 'launch' ? <Text color={tokens.textMuted}>brief · </Text> : null}
                {row.firstLine}
              </Text>
            ) : (
              <Text />
            ),
        },
      ]
    }
    if (section === 'saved') {
      return [
        {
          key: 'n',
          header: '#',
          width: 3,
          align: 'right',
          cell: row => <Text color={tokens.textMuted}>{row.kind === 'saved' ? String(row.n) : ''}</Text>,
        },
        {
          key: 'body',
          header: 'saved prompt',
          cell: row => (
            <Text color={tokens.textPrimary} wrap="truncate-end">
              {row.kind === 'saved' ? row.draft.text : ''}
            </Text>
          ),
        },
      ]
    }
    return [
      {
        key: 'time',
        header: 'time',
        width: 6,
        cell: row => <Text color={tokens.textMuted}>{row.kind === 'prompt' ? (row.queued ? 'queued' : clockOf(row.at)) : ''}</Text>,
      },
      {
        key: 'mode',
        header: 'mode',
        width: 5,
        cell: row =>
          row.kind === 'prompt' ? (
            <Text color={row.mode === 'plain' ? tokens.textMuted : row.mode === 'bash' ? tokens.warning : tokens.info}>
              {modeLabel(row.mode)}
            </Text>
          ) : (
            <Text />
          ),
      },
      {
        key: 'body',
        header: 'prompt',
        cell: row =>
          row.kind === 'prompt' ? (
            <Text color={tokens.textPrimary} wrap="truncate-end">
              {row.firstLine}
              {row.lines > 1 ? <Text color={tokens.textMuted}>{`  +${row.lines - 1} lines`}</Text> : null}
            </Text>
          ) : (
            <Text />
          ),
      },
    ]
  }, [section, tokens])

  const receipt = useCallback((r: { ok: boolean; reason?: string }, okText: string): void => {
    if (r.ok) setNote({ text: okText, tone: 'ok' })
    else setNote({ text: r.reason ?? 'refused', tone: 'warn' })
  }, [])

  const openAdd = useCallback((): void => {
    setConfirmDelete(null)
    setEditor({ kind: 'add', buffer: '' })
    setEditorCursor(0)
  }, [])

  const rowActions = useMemo<RowAction<Row>[]>(
    () => [
      {
        key: 's',
        label: 'to composer',
        when: row => row.kind === 'saved',
        run: row => {
          if (row.kind !== 'saved') return
          onClose(row.draft.text)
        },
      },
      {
        key: 'e',
        label: 'edit',
        when: row => row.kind === 'saved',
        run: row => {
          if (row.kind !== 'saved') return
          setConfirmDelete(null)
          setEditor({ kind: 'edit', id: row.draft.id, n: row.n, buffer: row.draft.text })
          setEditorCursor(row.draft.text.length)
        },
      },
      {
        key: '[',
        label: 'up',
        when: row => row.kind === 'saved' && row.n > 1,
        run: row => {
          if (row.kind !== 'saved') return
          void moveSavedPrompt(project, row.draft.id, -1).then(r => receipt(r, `moved #${row.n} up`))
        },
      },
      {
        key: ']',
        label: 'down',
        when: row => row.kind === 'saved' && row.n < saved.length,
        run: row => {
          if (row.kind !== 'saved') return
          void moveSavedPrompt(project, row.draft.id, 1).then(r => receipt(r, `moved #${row.n} down`))
        },
      },
      {
        key: 'd',
        label: 'delete',
        when: row => row.kind === 'saved',
        run: row => {
          if (row.kind !== 'saved') return
          if (confirmDelete === row.draft.id) {
            setConfirmDelete(null)
            void deleteSavedPrompt(project, row.draft.id).then(r => receipt(r, `deleted #${row.n}`))
            return
          }
          setConfirmDelete(row.draft.id)
          setNote({ text: `delete saved prompt #${row.n}? d again confirms`, tone: 'warn' })
        },
      },
      {
        key: 'c',
        label: 'clear',
        when: row => row.kind === 'saved',
        run: () => {
          setConfirmDelete(null)
          setEditor({ kind: 'confirm-clear', count: saved.length })
        },
      },
    ],
    [confirmDelete, onClose, project, receipt, saved.length],
  )

  const confirmClear = useCallback((): void => {
    setEditor(null)
    void clearSavedPrompts(project).then(r =>
      setNote({ text: r.cleared === 0 ? 'nothing to clear' : `cleared ${r.cleared === 1 ? '1 saved prompt' : `${r.cleared} saved prompts`} — the list is empty`, tone: 'ok' }),
    )
  }, [project])

  useInput(
    (input, key) => {
      if (key.ctrl || key.meta) return
      if (input === 'a') openAdd()
    },
    { isActive: section === 'saved' && editor === null },
  )

  const commitEditor = useCallback(
    (value: string): void => {
      const ed = editor
      if (ed === null || ed.kind === 'confirm-clear') return
      setEditor(null)
      if (ed.kind === 'add') {
        void addSavedPrompt(project, value).then(r =>
          receipt(r, r.ok ? `saved prompt #${saved.length + 1} written — s hands it to the composer` : ''),
        )
      } else {
        void editSavedPrompt(project, ed.id, value).then(r => receipt(r, `edited #${ed.n}`))
      }
    },
    [editor, project, receipt, saved.length],
  )

  const confirmDeleteLive = useRef<string | null>(null)
  confirmDeleteLive.current = confirmDelete
  useEffect(() => {
    setConfirmDelete(null)
    if (confirmDeleteLive.current !== null) {
      confirmDeleteLive.current = null
      setNote(null)
    }
  }, [section])

  const factsOf = (row: Row): KVRow[] => {
    if (row.kind === 'prompt') {
      return [
        row.queued
          ? { k: 'queued', v: 'waiting for the running turn to end' }
          : { k: 'sent', v: clockSecondsOf(row.at) },
        { k: 'mode', v: modeLabel(row.mode) },
        { k: 'length', v: `${row.lines === 1 ? '1 line' : `${row.lines} lines`} · ${row.chars} chars` },
        { k: 'prompt', v: `#${row.n} of ${prompts.length}` },
      ]
    }
    if (row.kind === 'crew') {
      return [
        { k: 'agent', v: row.agent },
        { k: 'direction', v: row.dir === 'to' ? `the lead ${GLYPH.chevronRight} ${row.agent}` : `${row.agent} ${GLYPH.chevronRight} the lead` },
        { k: 'kind', v: row.via === 'launch' ? 'launch brief' : row.via === 'message' ? 'message' : 'reply' },
        { k: 'at', v: clockSecondsOf(row.at) },
        ...(row.summary ? [{ k: 'summary', v: row.summary, fit: 'end' as const }] : []),
      ]
    }
    if (row.kind === 'crew-thread') {
      return [
        { k: 'agent', v: row.agent },
        { k: 'traffic', v: row.count === 1 ? '1 message' : `${row.count} messages` },
        { k: 'last', v: clockSecondsOf(row.lastAt) },
      ]
    }
    return [
      { k: 'saved', v: `#${row.n} of ${saved.length}` },
      { k: 'written', v: clockSecondsOf(row.draft.createdAt) },
      { k: 'edited', v: row.draft.updatedAt === row.draft.createdAt ? '—' : clockSecondsOf(row.draft.updatedAt) },
    ]
  }

  const bodyOf = (row: Row): { title: string; text: string }[] => {
    if (row.kind === 'prompt') return [{ title: 'the prompt as sent', text: row.text }]
    if (row.kind === 'crew') return [{ title: row.via === 'launch' ? 'the brief' : 'the message', text: row.text }]
    if (row.kind === 'crew-thread') return []
    return [{ title: 'your wording', text: row.draft.text }]
  }

  const renderDetail = (row: Row): React.ReactNode => (
    <Box flexDirection="column">
      <KeyValueGrid rows={factsOf(row)} keyWidth={10} />
      {bodyOf(row).map(b => (
        <Box key={b.title} flexDirection="column" marginTop={1}>
          <Text color={tokens.textMuted}>{b.title}</Text>
          <Text color={tokens.textPrimary} wrap="wrap">
            {b.text}
          </Text>
        </Box>
      ))}
    </Box>
  )

  const sideInfo = (row: Row): React.ReactNode => (
    <Box flexDirection="column">
      <KeyValueGrid rows={factsOf(row)} keyWidth={10} />
      {bodyOf(row).map(b => (
        <Box key={b.title} flexDirection="column" marginTop={1}>
          <Text color={tokens.textMuted} wrap="truncate-end">
            {b.title}
          </Text>
          <Text color={tokens.textPrimary} wrap="wrap">
            {b.text.length > SIDE_BODY_CHARS ? `${b.text.slice(0, SIDE_BODY_CHARS)}…` : b.text}
          </Text>
          {b.text.length > SIDE_BODY_CHARS ? <Text color={tokens.textMuted}>{'↵ shows the whole text'}</Text> : null}
        </Box>
      ))}
    </Box>
  )

  const detailTitle = (row: Row): string => {
    if (row.kind === 'prompt') return `prompt #${row.n} · ${truncateToWidth(row.firstLine, 40)}`
    if (row.kind === 'crew') return row.dir === 'to' ? `to ${row.agent}` : `${row.agent} replied`
    if (row.kind === 'crew-thread') return `${row.agent} · thread`
    return `saved prompt #${row.n}`
  }

  const lastPromptKey = prompts.length > 0 ? prompts[prompts.length - 1]!.key : undefined

  const headerLine = (
    <Text color={tokens.textMuted} wrap="truncate-end">
      {section === 'prompts'
        ? limitsLine(limits, prompts.length - queuedCount, clockOf, queuedCount)
        : section === 'crew'
          ? crew.length === 0
            ? 'no agent traffic this session · the threads fill as the lead delegates'
            : `${crew.filter(r => r.kind === 'crew-thread').length} agent${crew.filter(r => r.kind === 'crew-thread').length === 1 ? '' : 's'} · read from this chat's own records`
          : problem !== null
            ? `${GLYPH.warn} saved prompts unreadable · a write starts fresh and keeps the damaged copy beside the file`
            : drafts === null
              ? 'reading saved prompts…'
              : `${saved.length === 1 ? '1 saved prompt' : `${saved.length} saved prompts`} · kept per project · inert until s hands one to the composer`}
    </Text>
  )

  const headerRight = note ? (
    <Text color={note.tone === 'ok' ? tokens.success : tokens.warning} wrap="truncate-end">
      {note.tone === 'ok' ? GLYPH.ok : GLYPH.warn} {note.text}
    </Text>
  ) : undefined

  const composerNode =
    editor !== null && editor.kind === 'confirm-clear' ? (
      <Text color={tokens.warning} wrap="truncate-end">
        {`${GLYPH.warn} clear all ${editor.count === 1 ? '1 saved prompt' : `${editor.count} saved prompts`}? · ↵ clears · esc keeps them`}
      </Text>
    ) : editor !== null ? (
      <Box flexDirection="column">
        <Text color={tokens.textSecondary}>
          {editor.kind === 'edit' ? `edit saved prompt #${editor.n}` : 'new saved prompt'}
          <Text color={tokens.textMuted}>{'   ↵ save · esc cancel'}</Text>
        </Text>
        {
}
        <Box
          height={promptsComposerRows(editor.buffer.length) - 1}
          overflow="hidden"
          flexDirection="column"
          justifyContent="flex-end"
        >
        <Box>
          <Text color={tokens.accent}>{`${GLYPH.prompt} `}</Text>
          <TextInput
            value={editor.buffer}
            onChange={v =>
              setEditor(ed =>
                ed === null ? ed : { ...ed, buffer: v.replace(/[\r\n]+/g, ' ').slice(0, MAX_SAVED_PROMPT_CHARS) },
              )
            }
            onSubmit={commitEditor}
            focus={true}
            showCursor={true}
            multiline={false}
            columns={COMPOSER_COLUMNS}
            cursorOffset={editorCursor}
            onChangeCursorOffset={setEditorCursor}
            disableEscapeDoublePress={true}
          />
        </Box>
        </Box>
      </Box>
    ) : null

  return (
    <NavigablePanes<Row>
      view="prompts"
      subtitle={`${basename(workspace.cwd) || workspace.cwd} · session ${sessionId.slice(0, 8)}`}
      headerLine={headerLine}
      headerRight={headerRight}
      sections={sections}
      columns={columns}
      rowKey={row => row.key}
      renderDetail={renderDetail}
      sideInfo={sideInfo}
      detailTitle={detailTitle}
      onClose={() => onClose()}
      rowActions={rowActions}
      footerHints={section === 'saved' ? 'a new' : undefined}
      detailFooterHints={section === 'saved' ? 'a new' : undefined}
      maxContentWidth={120}
      onSectionChange={id => setSection(id as SectionId)}
      {...(lastPromptKey !== undefined ? { initialRowKey: lastPromptKey } : {})}
      composerSlot={{
        active: editor !== null,
        node: composerNode,
        onInput: (_input, key) => {
          if (editor?.kind === 'confirm-clear' && key.return) confirmClear()
        },
        onEscape: () => setEditor(null),
        rows:
          editor?.kind === 'confirm-clear'
            ? 1
            : editor !== null
              ? promptsComposerRows(editor.buffer.length)
              : 2,
      }}
    />
  )
}
