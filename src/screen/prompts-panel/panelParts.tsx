import * as React from 'react'
import { basename } from 'node:path'
import { Box, Text } from '../themedRenderer.js'
import type { EngineConnectorV1 } from '../../engine/connector/types.js'
import {
  MAX_SAVED_PROMPT_CHARS,
  type SavedPromptV1,
} from '../../sessions/saved-prompts/savedPromptsStore.js'
import { COMPOSER_COLUMNS, promptsComposerRows } from './composerLayout.js'
import { CrewChatPanel } from './CrewChatPanel.js'
import TextInput from '../composer/text-input/TextInput.js'
import { KeyValueGrid, type KVRow } from '../widgets/components.js'
import { GLYPH, truncateToWidth } from '../theme/glyphs.js'
import {
  NavigablePanes,
  type ColumnDef,
  type RowAction,
  type SectionDef,
} from '../widgets/NavigablePanes.js'
import type { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import {
  clockOf,
  clockSecondsOf,
  crewTrafficMessages,
  limitsLine,
  type CrewTrafficRow,
  type PromptRow,
  type RecordLimits,
} from './rows.js'

export type SavedRow = { kind: 'saved'; key: string; n: number; draft: SavedPromptV1 }
export type Row = PromptRow | CrewTrafficRow | SavedRow

export type SectionId = 'prompts' | 'crew' | 'saved'

export type Editor =
  | { kind: 'add'; buffer: string }
  | { kind: 'edit'; id: string; n: number; buffer: string }
  | { kind: 'confirm-clear'; count: number }
  | null

export type Note = { text: string; tone: 'ok' | 'warn' } | null

type Tokens = ReturnType<typeof useMercuryTokens>

export function panelColumnsOf({
  section,
  tokens,
  modeLabel,
}: {
  section: SectionId
  tokens: Tokens
  modeLabel: (mode: PromptRow['mode']) => string
}): ColumnDef<Row>[] {
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
}

export function panelViewOf({
  prompts,
  saved,
  tokens,
  section,
  limits,
  queuedCount,
  crew,
  problem,
  drafts,
  note,
  editor,
  setEditor,
  editorCursor,
  setEditorCursor,
  commitEditor,
  board,
  records,
  onClose,
  setSection,
  workspace,
  sessionId,
  sections,
  columns,
  rowActions,
  confirmClear,
  modeLabel,
  SIDE_BODY_CHARS,
}: {
  prompts: PromptRow[]
  saved: SavedRow[]
  tokens: Tokens
  section: SectionId
  limits: RecordLimits
  queuedCount: number
  crew: CrewTrafficRow[]
  problem: string | null
  drafts: SavedPromptV1[] | null
  note: Note
  editor: Editor
  setEditor: React.Dispatch<React.SetStateAction<Editor>>
  editorCursor: number
  setEditorCursor: React.Dispatch<React.SetStateAction<number>>
  commitEditor: (value: string) => void
  board: ReturnType<NonNullable<EngineConnectorV1['swarmBoard']>> | null
  records: ReturnType<EngineConnectorV1['records']>
  onClose: (nextInput?: string) => void
  setSection: React.Dispatch<React.SetStateAction<SectionId>>
  workspace: ReturnType<EngineConnectorV1['workspace']>
  sessionId: string
  sections: SectionDef<Row>[]
  columns: ColumnDef<Row>[]
  rowActions: RowAction<Row>[]
  confirmClear: () => void
  modeLabel: (mode: PromptRow['mode']) => string
  SIDE_BODY_CHARS: number
}): React.ReactNode {
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
            ? 'no crewmate traffic this session · the threads fill as the lead delegates'
            : `${crew.filter(r => r.kind === 'crew-thread').length} crewmate${crew.filter(r => r.kind === 'crew-thread').length === 1 ? '' : 's'} · read from this chat's own records`
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

  if (section === 'crew' && board?.on) return <CrewChatPanel snapshot={board} traffic={crewTrafficMessages(records)} onClose={() => onClose()} onSection={setSection} />

  return (
    <NavigablePanes<Row>
      initialSectionId={section}
      borderColor={tokens.borderStrong}
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
