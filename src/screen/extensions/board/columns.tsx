import { Text } from '../../themedRenderer.js'
import { matchBlock } from '../../../integrations/extensions/blocklist.js'
import { contributionCounts } from '../../../integrations/extensions/manifest.js'
import { trustStateOf } from '../../../integrations/extensions/roster.js'
import type { ColumnDef } from '../../widgets/NavigablePanes.js'
import type { useMercuryTokens } from '../../widgets/useMercuryTokens.js'
import { noteWords, sourceStateWord, sourceWhereWords, trustWord } from '../rowWords.js'
import type { BoardRow } from './shapes.js'

export function boardColumns({ cols, tokens }: { cols: number; tokens: ReturnType<typeof useMercuryTokens> }) {
  const wide = cols >= 140
  const installedColumns: ColumnDef<BoardRow>[] = [
    {
      key: 'state',
      header: 'state',
      width: 10,
      cell: r => {
        if (r.kind !== 'ext') return <Text color={tokens.textMuted}>—</Text>
        const w = trustWord(trustStateOf(r.entry), r.health)
        return (
          <Text color={tokens[w.role]} wrap="truncate-end">
            {w.glyph} {w.word}
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
          {r.kind === 'ext' ? r.entry.name : r.row.label}
        </Text>
      ),
    },
    {
      key: 'ver',
      header: 'ver',
      width: 7,
      cell: r => (
        <Text color={tokens.textMuted} wrap="truncate-end">
          {r.kind === 'ext' ? r.entry.version || '—' : '—'}
        </Text>
      ),
    },
    {
      key: 'from',
      header: 'from',
      width: 11,
      cell: r => (
        <Text color={tokens.textMuted} wrap="truncate-end">
          {r.kind === 'ext' ? r.entry.label : r.row.record.kind}
        </Text>
      ),
    },
    ...(wide
      ? [
          {
            key: 'adds',
            header: 'adds',
            width: 22,
            cell: (r: BoardRow) => {
              if (r.kind !== 'ext' || r.entry.manifest === null) return <Text color={tokens.textMuted}>—</Text>
              const counts = contributionCounts(r.entry.manifest)
              const parts = Object.entries(counts).map(([kind, n]) => `${n} ${n === 1 ? kind.replace(/s$/, '') : kind}`)
              return (
                <Text color={tokens.textMuted} wrap="truncate-end">
                  {parts.length > 0 ? parts.join(' · ') : '—'}
                </Text>
              )
            },
          } satisfies ColumnDef<BoardRow>,
        ]
      : []),
    {
      key: 'note',
      header: 'note',
      cell: r => (
        <Text color={tokens.textMuted} wrap="truncate-end">
          {r.kind === 'ext' ? noteWords(r.entry, r.health) : ''}
        </Text>
      ),
    },
  ]

  const sourceColumns: ColumnDef<BoardRow>[] = [
    {
      key: 'state',
      header: 'state',
      width: 11,
      cell: r => {
        if (r.kind !== 'src') return <Text color={tokens.textMuted}>—</Text>
        const w = sourceStateWord(r.row.state)
        return (
          <Text color={tokens[w.role]} wrap="truncate-end">
            {w.glyph} {w.word}
          </Text>
        )
      },
    },
    {
      key: 'source',
      header: 'source',
      width: 12,
      cell: r => (
        <Text color={tokens.textPrimary} wrap="truncate-end">
          {r.kind === 'src' ? r.row.label : ''}
        </Text>
      ),
    },
    {
      key: 'kind',
      header: 'kind',
      width: 7,
      cell: r => (
        <Text color={tokens.textMuted} wrap="truncate-end">
          {r.kind === 'src' ? r.row.record.kind : ''}
        </Text>
      ),
    },
    {
      key: 'where',
      header: 'where',
      cell: r => {
        if (r.kind !== 'src') return <Text color={tokens.textMuted}>—</Text>
        const blocked = matchBlock([r.row.label, r.row.record.where]) !== null
        return (
          <Text color={tokens.textMuted} wrap="truncate-end">
            {sourceWhereWords(r.row)}
            {blocked ? <Text color={tokens.failure}> · blocked</Text> : null}
          </Text>
        )
      },
    },
  ]
  return { installedColumns, sourceColumns }
}
