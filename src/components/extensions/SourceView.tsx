// ============================================================================
//  SourceView — a source opened from the sources section (spec 05 §4): a
//  single-section board over the source's CATALOGUE entries, each row's
//  state being the extension's state ON THIS MACHINE (`—` when not
//  installed). `i` fetches and opens the approval card — browsing a
//  catalogue installs nothing until that card is approved. esc returns to
//  the sources section with the cursor kept on this source.
// ============================================================================
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { trustStateOf } from '../../extensions/roster.js'
import type { SourceRow } from '../../extensions/sources.js'
import type { Health, RosterEntry } from '../../extensions/types.js'
import { useAppState } from '../../state/AppState.js'
import { NavigablePanes, type ColumnDef, type RowAction, type SectionDef } from '../mercury-ui/NavigablePanes.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { resolveExtensionsBindings } from './bindings.js'
import { age, sourceStateWord, trustWord } from './rowWords.js'

type EntryRow = {
  name: string
  version: string
  description: string
  git: string | undefined
  path: string | undefined
  installed: RosterEntry | null
  health: Health | null
}

export type SourceViewSlot = {
  node: React.ReactNode
  rows: number
  active: boolean
  onInput: (input: string, key: Record<string, boolean>) => void
  onEscape: () => void
}

export function SourceView({
  label,
  entries,
  sources,
  onBack,
  onInstall,
  onUpdate,
  onUninstall,
  onClose,
  slot,
}: {
  label: string
  entries: RosterEntry[]
  sources: SourceRow[]
  /** esc — back to the sources section, cursor on this source. */
  onBack: (seedRow?: string) => void
  onInstall: (label: string, name: string) => void
  onUpdate: (entry: RosterEntry) => void
  onUninstall: (entry: RosterEntry) => void
  onClose: () => void
  slot: SourceViewSlot | null
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const health = useAppState(s => s.extensions.health)
  void onClose
  const source = sources.find(row => row.label === label) ?? null

  const rows: EntryRow[] = (source?.catalogue?.extensions ?? []).map(e => {
    const installed = entries.find(x => x.name === e.name && x.label === label) ?? null
    return {
      name: e.name,
      version: e.version,
      description: e.description ?? '',
      git: e.git,
      path: e.path,
      installed,
      health: installed ? (health[installed.id] ?? null) : null,
    }
  })

  const stateOf = (r: EntryRow): { glyph: string; word: string; role: 'success' | 'warning' | 'failure' | 'textMuted' | 'textSecondary' } =>
    r.installed ? trustWord(trustStateOf(r.installed), r.health) : { glyph: '—', word: '', role: 'textMuted' }

  const columns: ColumnDef<EntryRow>[] = [
    {
      key: 'state',
      header: 'state',
      width: 10,
      cell: r => {
        const w = stateOf(r)
        return (
          <Text color={tokens[w.role]} wrap="truncate-end">
            {w.glyph}
            {w.word ? ` ${w.word}` : ''}
          </Text>
        )
      },
    },
    {
      key: 'name',
      header: 'name',
      width: 16,
      cell: r => (
        <Text color={tokens.textPrimary} wrap="truncate-end">
          {r.name}
        </Text>
      ),
    },
    {
      key: 'ver',
      header: 'ver',
      width: 7,
      cell: r => (
        <Text color={tokens.textMuted} wrap="truncate-end">
          {r.version}
        </Text>
      ),
    },
    {
      key: 'description',
      header: 'description',
      cell: r => (
        <Text color={tokens.textMuted} wrap="truncate-end">
          {r.description}
          {r.installed?.availableVersion ? <Text color={tokens.warning}> · ↑ update available</Text> : null}
        </Text>
      ),
    },
  ]

  // The same ONE dispatch resolution the board uses (05 §2.3): an action the
  // resolver cannot arm is omitted here; the board's open note carries why.
  const kb = React.useMemo(() => resolveExtensionsBindings(), [])
  const act = (action: string, label: string, when: (r: EntryRow) => boolean, run: (r: EntryRow) => void): RowAction<EntryRow>[] => {
    const char = kb.chars.get(`extensions:${action}`)
    if (char === undefined) return []
    return [{ key: char, label, ...(char === ' ' ? { hint: `space ${label}` } : {}), when, run }]
  }
  const rowActions: RowAction<EntryRow>[] = [
    ...act('install', 'install', r => r.installed === null, r => onInstall(label, r.name)),
    ...act('update', 'update', r => r.installed !== null && r.installed.availableVersion !== null, r => r.installed && onUpdate(r.installed)),
    ...act('remove', 'uninstall', r => r.installed !== null && r.installed.home === 'installed', r => r.installed && onUninstall(r.installed)),
  ]

  const detail = (r: EntryRow): React.ReactNode => {
    const w = r.installed ? stateOf(r) : null
    return (
      <Box flexDirection="column">
        <Text bold color={tokens.accent} wrap="truncate-end">
          {r.name} {r.version}
        </Text>
        <Text color={tokens.textMuted} wrap="truncate-end">
          {r.git ? `git ${r.git}` : `in ./${(r.path ?? r.name).replace(/^\.\//, '')}`}
        </Text>
        {r.installed && w ? (
          <Text wrap="truncate-end">
            <Text color={tokens.textPrimary}>installed {r.installed.version}</Text>
            <Text color={tokens[w.role]}>
              {' '}
              · {w.glyph} {w.word}
            </Text>
          </Text>
        ) : (
          <Text color={tokens.textMuted}>not installed</Text>
        )}
        <Text color={tokens.textMuted} wrap="truncate-end">
          catalogue says {r.version}
        </Text>
        {r.description ? (
          <Box marginTop={1}>
            <Text color={tokens.textSecondary} wrap="wrap">
              {r.description}
            </Text>
          </Box>
        ) : null}
        {r.installed === null ? (
          <Box marginTop={1}>
            <Text color={tokens.textMuted}>i fetches it and shows the approval card — nothing runs before you approve</Text>
          </Box>
        ) : r.installed.availableVersion ? (
          <Box marginTop={1}>
            <Text color={tokens.textMuted} wrap="wrap">
              U fetches {r.installed.availableVersion} and shows the approval card when its contributions changed
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  }

  const sourceWord = source ? sourceStateWord(source.state) : null
  const sections: SectionDef<EntryRow>[] = [
    {
      id: 'entries',
      label,
      count: rows.length,
      rows,
      emptyHint:
        source === null
          ? 'this source was removed — esc returns to sources'
          : source.catalogueError !== null
            ? `catalogue unreadable: ${source.catalogueError}`
            : 'this source offers nothing yet',
    },
  ]

  return (
    <NavigablePanes<EntryRow>
      view="extensions"
      subtitle={label}
      sections={sections}
      columns={columns}
      rowKey={r => `entry:${r.name}`}
      renderDetail={detail}
      detailTitle={r => `${r.name} ${r.version}`}
      sideInfo={detail}
      rowActions={rowActions}
      onClose={() => onBack()}
      closeHint="esc back to sources"
      headerRight={
        source ? (
          <Text color={tokens.textMuted} wrap="truncate-end">
            {source.record.kind} · {source.offered} offered
            {source.record.kind !== 'folder' ? ` · checked ${age(source.record.checkedAt)}` : ''}
            {sourceWord && source.state !== 'ok' ? <Text color={tokens[sourceWord.role]}> · {sourceWord.word}</Text> : null}
          </Text>
        ) : undefined
      }
      composerSlot={
        slot !== null
          ? { active: slot.active, node: slot.node, rows: slot.rows, onInput: slot.onInput, onEscape: slot.onEscape }
          : undefined
      }
    />
  )
}
