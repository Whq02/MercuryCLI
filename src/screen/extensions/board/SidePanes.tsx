import * as React from 'react'
import { Box, Text } from '../../themedRenderer.js'
import { contributionCounts } from '../../../integrations/extensions/manifest.js'
import { trustStateOf } from '../../../integrations/extensions/roster.js'
import type { SourceRow } from '../../../integrations/extensions/sources.js'
import type { Health, RosterEntry } from '../../../integrations/extensions/types.js'
import { useMercuryTokens } from '../../widgets/useMercuryTokens.js'
import { age, plainRowText, sourceStateWord, trustWord } from '../rowWords.js'

export function ExtensionSidePane({ entry, health }: { entry: RosterEntry; health: Health | null }): React.ReactNode {
  const tokens = useMercuryTokens()
  const w = trustWord(trustStateOf(entry), health)
  const counts = entry.manifest ? contributionCounts(entry.manifest) : {}
  const addsParts = Object.entries(counts).map(([kind, n]) => `${n} ${n === 1 ? kind.replace(/s$/, '') : kind}`)
  const lines: Array<{ k: string; v: string; tone?: string }> = []
  if (entry.home === 'proposal') {
    lines.push({ k: 'found', v: 'proposed by this project' })
    lines.push({ k: 'from', v: entry.proposal?.source ?? '' })
    lines.push({ k: 'next', v: 'i fetches, then the card' })
  } else {
    lines.push({ k: 'from', v: entry.home === 'project' ? 'this project' : entry.label })
    if (entry.source?.where) lines.push({ k: '', v: entry.source.where })
    else if (entry.home === 'project' && entry.root) lines.push({ k: '', v: entry.root })
    lines.push({ k: 'health', v: `${w.glyph} ${w.word}`, tone: tokens[w.role] })
    for (const reason of (health?.reasons ?? []).slice(0, 3)) lines.push({ k: '', v: reason, tone: tokens[w.role] })
    if (addsParts.length > 0) {
      lines.push({ k: 'adds', v: addsParts.slice(0, 2).join(' · ') })
      for (let i = 2; i < addsParts.length; i += 2) lines.push({ k: '', v: addsParts.slice(i, i + 2).join(' · ') })
    }
    const needs = entry.manifest?.needs
    if (needs?.binaries?.length) lines.push({ k: 'needs', v: needs.binaries.join(' · ') })
    if (needs?.env?.length) lines.push({ k: needs.binaries?.length ? '' : 'needs', v: needs.env.join(' · ') })
    if (entry.record?.approval) lines.push({ k: 'approved', v: `${entry.record.approval.at.slice(0, 10)} · ${entry.record.approval.version}` })
    else if (entry.home !== 'bundled') lines.push({ k: 'approved', v: 'not yet · i approves' })
    lines.push({ k: 'switch', v: entry.switchScope === 'project' ? 'this project' : entry.switchScope === 'everywhere' ? 'everywhere' : 'off' })
    if (entry.availableVersion) lines.push({ k: 'update', v: `↑ ${entry.availableVersion} · U applies`, tone: tokens.warning })
  }
  return (
    <Box flexDirection="column">
      <Text bold color={tokens.accent} wrap="truncate-end">
        {entry.name} {entry.version}
      </Text>
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          <Text color={tokens.textMuted}>{(l.k + '          ').slice(0, 10)}</Text>
          <Text color={l.tone ?? tokens.textPrimary}>{l.v}</Text>
        </Text>
      ))}
    </Box>
  )
}

export function SourceSidePane({ row }: { row: SourceRow }): React.ReactNode {
  const tokens = useMercuryTokens()
  const w = sourceStateWord(row.state)
  const lines: Array<{ k: string; v: string; tone?: string }> = [
    { k: 'kind', v: `${row.record.kind}${row.record.ref ? ` · ${row.record.ref}` : ''}` },
    { k: 'where', v: row.record.where },
    ...(row.record.commit ? [{ k: 'commit', v: row.record.commit.slice(0, 7) }] : []),
    { k: 'checked', v: `${age(row.record.checkedAt)} · ${w.word}`, tone: tokens[w.role] },
    ...(row.record.lastError ? [{ k: 'error', v: plainRowText(row.record.lastError), tone: tokens.failure }] : []),
    { k: 'offers', v: row.catalogue ? `${row.offered} extension${row.offered === 1 ? '' : 's'}` : row.catalogueError ? plainRowText(row.catalogueError) : 'unknown' },
    ...(row.installed > 0 || row.updates > 0
      ? [{ k: '', v: `${row.installed} installed${row.updates > 0 ? ` · ${row.updates} update${row.updates === 1 ? '' : 's'}` : ''}` }]
      : []),
    { k: 'added', v: row.record.addedAt.slice(0, 10) },
  ]
  return (
    <Box flexDirection="column">
      <Text bold color={tokens.accent} wrap="truncate-end">
        {row.label}
      </Text>
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          <Text color={tokens.textMuted}>{(l.k + '          ').slice(0, 10)}</Text>
          <Text color={l.tone ?? tokens.textPrimary}>{l.v}</Text>
        </Text>
      ))}
      <Text color={tokens.textMuted}>↵ opens its extensions</Text>
    </Box>
  )
}
