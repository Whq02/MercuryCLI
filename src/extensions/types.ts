import type { ExtensionManifest } from './manifest.js'
import type { InstalledRecord, SourceRecord } from './records.js'

export type ExtensionHome = 'installed' | 'project' | 'session' | 'bundled' | 'proposal'

export type TrustState = 'available' | 'found' | 'off' | 'pending' | 'on' | 'blocked'

export type HealthOutcome = 'loads' | 'partial' | 'broken'

export type Health = {
  outcome: HealthOutcome
  reasons: string[]
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
  root: string | null
  manifest: ExtensionManifest | null
  manifestWarnings: string[]
  manifestErrors: string[]
  record: InstalledRecord | null
  source: SourceRecord | null
  contributionsHash: string | null
  approved: boolean
  changedSinceApproval: boolean
  switchedOn: boolean
  switchScope: 'everywhere' | 'project' | 'off'
  blockedBy: BlockedBy
  shadowedBy: string | null
  pending: 'on' | 'off' | 'update' | null
  availableVersion: string | null
  noLongerOffered: boolean
  sourceRemoved: boolean
  changedOnDisk: boolean
  proposal: { source: string; ref?: string } | null
  previous: { version: string; path: string } | null
  bundledUpdatedWith: string | null
}

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
