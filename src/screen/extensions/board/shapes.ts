import type { CardKind } from '../../../integrations/extensions/card.js'
import type { ManifestNeeds } from '../../../integrations/extensions/manifest.js'
import type { SourceRow } from '../../../integrations/extensions/sources.js'
import type { Health, RosterEntry } from '../../../integrations/extensions/types.js'

export type BoardRow =
  | { kind: 'ext'; entry: RosterEntry; health: Health | null }
  | { kind: 'src'; row: SourceRow }

export function rowKeyOf(row: BoardRow): string {
  return row.kind === 'ext' ? `ext:${row.entry.id}` : `src:${row.row.label}`
}


export type CardSpec = {
  id: string
  cardKind: CardKind
  root: string
  label: string
  where: string | null
  commit: string | null
  previous: { root: string; version: string } | null
  back: BoardSeed
}

export type BoardSeed = { section?: 'installed' | 'sources'; row?: string }

export type View =
  | { kind: 'board'; seed: BoardSeed }
  | { kind: 'source'; label: string }
  | { kind: 'ext'; id: string }
  | { kind: 'card'; card: CardSpec }


export type Slot =
  | { mode: 'add'; text: string; busy: string | null; error: string | null }
  | { mode: 'filter'; text: string }
  | { mode: 'uninstall'; id: string; name: string; version: string; label: string; dataBytes: number; inPlace: boolean }
  | { mode: 'remove-source'; label: string; installedIds: string[] }
  | { mode: 'fetch'; id: string; name: string; url: string; ref: string | null }
  | { mode: 'option'; id: string; schema: NonNullable<ManifestNeeds['options']>; keys: string[]; index: number; text: string }
