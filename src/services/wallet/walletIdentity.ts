import { stringWidth } from '../../ink/stringWidth.js'
import { truncateToWidth } from '../../utils/truncate.js'
import { accountWordOf, identityKindOf, identityWords, isWalletProvider, type IdentityKind } from './identityWords.js'
import {
  activeWalletEntry,
  walletEntries,
  type WalletEntry,
  type WalletIdentitySource,
  type WalletProvider,
} from './wallet.js'

export { accountWordOf, identityKindOf, isWalletProvider }
export type { IdentityKind }

export type IdentitySource = WalletIdentitySource | 'none'

export interface EntryIdentity {
  entryId: string
  provider: WalletProvider
  kind: IdentityKind
  source: IdentitySource
  active: boolean
  shown: string
  account?: string
  host?: string
  label?: string
  keyTail?: string
}

export interface FamilyIdentity {
  provider: WalletProvider
  active?: EntryIdentity
  others: EntryIdentity[]
}

export interface WalletIdentityReads {
  entries?: () => readonly WalletEntry[]
  active?: (provider: WalletProvider) => WalletEntry | undefined
}

const MIN_ELIDED_ACCOUNT = 5

export function entryIdentity(entry: WalletEntry, active = false): EntryIdentity {
  const kind = identityKindOf(entry)
  const base = {
    entryId: entry.id,
    provider: entry.provider,
    kind,
    active,
    ...(entry.host !== undefined ? { host: entry.host } : {}),
  }
  if (kind === 'api-key') {
    return {
      ...base,
      source: 'none',
      label: entry.label,
      ...(entry.keyTail !== undefined ? { keyTail: entry.keyTail } : {}),
      shown: entry.keyTail !== undefined ? `${entry.label} · ${entry.keyTail}` : entry.label,
    }
  }
  const source = entry.identity?.source
  const account = (entry.identity?.email ?? entry.identity?.name)?.trim()
  if (source !== undefined && account !== undefined && account !== '') {
    return { ...base, source, account, shown: identityWords(entry.provider, kind, account, entry.host) }
  }
  return { ...base, source: 'none', shown: identityWords(entry.provider, kind, undefined, entry.host) }
}

export function familyIdentity(provider: WalletProvider, reads: WalletIdentityReads = {}): FamilyIdentity {
  const all: readonly WalletEntry[] = (reads.entries ?? walletEntries)()
  const entries = all.filter(entry => entry.provider === provider)
  const activeEntry = (reads.active ?? activeWalletEntry)(provider)
  const activeId =
    activeEntry !== undefined && entries.some(entry => entry.id === activeEntry.id) ? activeEntry.id : undefined
  const identities = entries.map(entry => entryIdentity(entry, entry.id === activeId))
  const active = identities.find(identity => identity.active)
  return {
    provider,
    ...(active !== undefined ? { active } : {}),
    others: identities.filter(identity => !identity.active),
  }
}

export function fitIdentityLine(identity: EntryIdentity, width?: number, prefix = ''): string {
  const full = `${prefix}${identity.shown}`
  if (width === undefined || stringWidth(full) <= width) return full
  if (width < 1) return ''
  if (identity.account !== undefined) {
    const frame = stringWidth(`${prefix}${identityWords(identity.provider, identity.kind, '', identity.host)}`)
    const room = width - frame
    if (room >= MIN_ELIDED_ACCOUNT) {
      return `${prefix}${identityWords(identity.provider, identity.kind, truncateToWidth(identity.account, room), identity.host)}`
    }
    return truncateToWidth(`${prefix}${accountWordOf(identity.provider)} · ${identity.account}`, width)
  }
  if (identity.keyTail !== undefined && identity.label !== undefined) {
    const tail = ` · ${identity.keyTail}`
    const room = width - stringWidth(prefix) - stringWidth(tail)
    if (room >= MIN_ELIDED_ACCOUNT) return `${prefix}${truncateToWidth(identity.label, room)}${tail}`
  }
  return truncateToWidth(full, width)
}

export function familyIdentityLines(
  family: string,
  options: { width?: number; reads?: WalletIdentityReads } = {},
): string[] {
  if (!isWalletProvider(family)) return []
  const view = familyIdentity(family, options.reads)
  const all = [...(view.active !== undefined ? [view.active] : []), ...view.others]
  if (!all.some(identity => identity.kind !== 'api-key')) return []
  const prefix = view.active !== undefined ? 'also ' : ''
  return [
    ...(view.active !== undefined ? [fitIdentityLine(view.active, options.width)] : []),
    ...view.others.map(identity => fitIdentityLine(identity, options.width, prefix)),
  ]
}
