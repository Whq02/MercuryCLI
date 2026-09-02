import { MERCURY_PROJECT_DIR } from '../../utils/projectConfig.js'
import { healthWord } from '../../extensions/health.js'
import { PROJECT_EXTENSIONS_DIR } from '../../extensions/paths.js'
import { trustStateOf } from '../../extensions/roster.js'
import type { SourceRow, SourceState } from '../../extensions/sources.js'
import type { RosterSummary, Health, RosterEntry, TrustState } from '../../extensions/types.js'

export type StateRole = 'success' | 'warning' | 'failure' | 'textMuted' | 'textSecondary'

export type StateWord = { glyph: string; word: string; role: StateRole }

export function trustWord(state: TrustState, health: Health | null): StateWord {
  switch (state) {
    case 'on': {
      const outcome = health?.outcome ?? 'loads'
      if (outcome === 'partial') return { glyph: '◑', word: 'partial', role: 'warning' }
      if (outcome === 'broken') return { glyph: '✕', word: 'broken', role: 'failure' }
      return { glyph: '●', word: healthWord('loads'), role: 'success' }
    }
    case 'pending':
      return { glyph: '◐', word: 'reload', role: 'warning' }
    case 'off':
      return { glyph: '○', word: 'off', role: 'textMuted' }
    case 'found':
      return { glyph: '◇', word: 'found', role: 'textSecondary' }
    case 'blocked':
      return { glyph: '◉', word: 'blocked', role: 'failure' }
    default:
      return { glyph: '—', word: '', role: 'textMuted' }
  }
}

export function noteWords(entry: RosterEntry, health: Health | null): string {
  const state = trustOf(entry)
  const parts: string[] = []
  switch (state) {
    case 'on': {
      const outcome = health?.outcome ?? 'loads'
      if (outcome !== 'loads') parts.push(health?.reasons[0] ?? outcome)
      else if (entry.availableVersion) parts.push(`↑ ${entry.availableVersion} available`)
      break
    }
    case 'pending':
      parts.push(
        entry.pending === 'update'
          ? `${entry.record?.previous?.version ?? '?'} → ${entry.version} · r reloads`
          : entry.pending === 'on'
            ? 'turned on · r reloads'
            : 'turned off · r reloads',
      )
      break
    case 'off':
      if (entry.shadowedBy) parts.push('shadowed by project')
      else if (entry.changedSinceApproval) parts.push('changed — re-approve')
      else if (!entry.approved) parts.push('not approved · i approves')
      break
    case 'found':
      parts.push(entry.home === 'proposal' ? 'proposed · i fetches' : `${MERCURY_PROJECT_DIR}/${PROJECT_EXTENSIONS_DIR} · i installs`)
      break
    case 'blocked':
      parts.push(entry.blockedBy === 'policy' ? 'blocked by policy' : 'b unblocks')
      break
    default:
      break
  }
  if (state !== 'on' && state !== 'pending' && entry.availableVersion) parts.push(`↑ ${entry.availableVersion} available`)
  if (entry.noLongerOffered) parts.push(`no longer offered by ${entry.label}`)
  if (entry.sourceRemoved && entry.home === 'installed') parts.push(`from ${entry.label} (removed)`)
  if (entry.changedOnDisk) parts.push('changed on disk')
  if (entry.record?.pendingFirstLoad && entry.previous) parts.push(`previous ${entry.previous.version} kept`)
  if (entry.bundledUpdatedWith) parts.push(entry.bundledUpdatedWith)
  return parts.join(' · ')
}

function trustOf(entry: RosterEntry): TrustState {
  return trustStateOf(entry)
}

export function sourceStateWord(state: SourceState): StateWord {
  switch (state) {
    case 'ok':
      return { glyph: '●', word: 'ok', role: 'success' }
    case 'stale':
      return { glyph: '↻', word: 'stale', role: 'warning' }
    case 'unreachable':
      return { glyph: '✕', word: 'unreach', role: 'failure' }
    default:
      return { glyph: '○', word: 'unchecked', role: 'textMuted' }
  }
}

export function age(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return 'never'
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function sourceWhereWords(row: SourceRow): string {
  const parts: string[] = []
  if (row.state === 'unreachable') {
    parts.push(row.record.lastError ?? 'unreachable', 'u retries', row.record.where)
    if (row.catalogue) parts.push('cached catalogue still lists')
  } else {
    parts.push(row.record.where)
    if (row.catalogueError) parts.push(row.catalogueError)
  }
  if (row.catalogue) parts.push(`${row.offered} offered`, `${row.installed} installed`)
  if (row.record.kind !== 'folder') parts.push(age(row.record.checkedAt))
  return parts.join(' · ')
}

export function installedRollup(summary: RosterSummary, wide: boolean): string {
  const parts: string[] = [wide ? `${summary.total} extension${summary.total === 1 ? '' : 's'}` : `${summary.total}`]
  if (summary.on > 0) parts.push(`${summary.on} on`)
  if (summary.partial > 0) parts.push(`${summary.partial} partial`)
  if (summary.broken > 0) parts.push(`${summary.broken} broken`)
  if (summary.pending > 0) parts.push(`${summary.pending} reload`)
  if (summary.updates > 0) parts.push(`${summary.updates} update${summary.updates === 1 ? '' : 's'}`)
  if (wide) parts.push(`${summary.sources} source${summary.sources === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

export function sourcesRollup(rows: SourceRow[], wide: boolean): string {
  const offered = rows.reduce((n, r) => n + r.offered, 0)
  const installed = rows.reduce((n, r) => n + r.installed, 0)
  const updates = rows.reduce((n, r) => n + r.updates, 0)
  const parts = [`${rows.length} source${rows.length === 1 ? '' : 's'}`]
  if (offered > 0) parts.push(`${offered} offered`)
  if (installed > 0) parts.push(`${installed} installed`)
  if (updates > 0) parts.push(`${updates} update${updates === 1 ? '' : 's'}`)
  void wide
  return parts.join(' · ')
}
