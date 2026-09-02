// ============================================================================
//  src/extensions/types.ts — the shapes every renderer reads: the roster
//  entry (one per extension this machine knows), its trust state, and the
//  health readout. Renderers derive nothing; they paint these.
// ============================================================================
import type { ExtensionManifest } from './manifest.js'
import type { InstalledRecord, SourceRecord } from './records.js'

/** Where an extension lives (01 §3). */
export type ExtensionHome = 'installed' | 'project' | 'session' | 'bundled' | 'proposal'

/** The trust states (03 §1). `available` exists only inside a source view. */
export type TrustState = 'available' | 'found' | 'off' | 'pending' | 'on' | 'blocked'

/** The three health outcomes (04 §1); a health outcome applies only to a switched-on extension. */
export type HealthOutcome = 'loads' | 'partial' | 'broken'

export type Health = {
  outcome: HealthOutcome
  /** One line each, in probe order; empty when `loads`. */
  reasons: string[]
  /** Notes that are not defects (an agent's ignored privileged field). */
  notes: string[]
}

export type BlockedBy = 'operator' | 'policy' | null

export type RosterEntry = {
  id: string
  name: string
  version: string
  description: string
  label: string
  home: ExtensionHome
  /** The folder Mercury reads; null for a proposal (nothing fetched) or a record whose folder is gone. */
  root: string | null
  manifest: ExtensionManifest | null
  manifestWarnings: string[]
  /** The manifest's first error when it is missing or invalid. */
  manifestErrors: string[]
  record: InstalledRecord | null
  source: SourceRecord | null
  contributionsHash: string | null
  /** The approval on file matches the current contributions hash. */
  approved: boolean
  /** An approval exists but for another contributions hash. */
  changedSinceApproval: boolean
  /** The switch as the settings say (everywhere / this project / off), before blocking and shadowing. */
  switchedOn: boolean
  switchScope: 'everywhere' | 'project' | 'off'
  blockedBy: BlockedBy
  /** The id of the extension shadowing this one, when another home wins the name. */
  shadowedBy: string | null
  /** Why the running session has not swapped yet. */
  pending: 'on' | 'off' | 'update' | null
  /** A newer version the source lists (only a refresh discovers it). */
  availableVersion: string | null
  /** The source no longer offers this extension. */
  noLongerOffered: boolean
  /** The source was removed; the copy keeps working. */
  sourceRemoved: boolean
  /** A folder source's copy changed on disk without a version bump. */
  changedOnDisk: boolean
  /** The proposal a project's settings make (`extensions.wanted`). */
  proposal: { source: string; ref?: string } | null
  /** The installed copy's previous version, when one is kept. */
  previous: { version: string; path: string } | null
  /** The bundled roster's note after a Mercury update changed the contributions. */
  bundledUpdatedWith: string | null
}

/** The per-contribution switches on the installed record, or all-on for the other homes. */
export type ActiveExtension = {
  entry: RosterEntry
  manifest: ExtensionManifest
  root: string
  health: Health
}

export type RosterSummary = {
  total: number
  on: number
  partial: number
  broken: number
  off: number
  pending: number
  found: number
  blocked: number
  updates: number
  sources: number
}
