import * as React from 'react'
import { basename } from 'node:path'
import { Box, Text } from '../../ink.js'
import type { EngineConnectorV1 } from '../../services/engine-connector/types.js'
import {
  MAX_SAVED_PROMPT_CHARS,
  type SavedPromptV1,
} from '../../utils/savedPrompts/savedPromptsStore.js'
import { COMPOSER_COLUMNS, promptsComposerRows } from './composerLayout.js'
import { CrewChatPanel } from './CrewChatPanel.js'
import TextInput from '../TextInput.js'
import { KeyValueGrid, type KVRow } from '../mercury-ui/components.js'
import { GLYPH, truncateToWidth } from '../../utils/glyphs.js'
import {
  NavigablePanes,
  type ColumnDef,
  type RowAction,
  type SectionDef,
} from '../mercury-ui/NavigablePanes.js'
import type { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import {
  clockOf,
  clockSecondsOf,
  crewTrafficMessages,
  limitsLine,
  type CrewTrafficRow,
  type PromptRow,
  type RecordLimits,
} from './rows.js'
import { notBuilt } from '../../pi/holes.js'

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

export function panelViewOf(arg0: {
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
  return notBuilt('src/components/prompts-panel/panelParts.tsx:157')
}
