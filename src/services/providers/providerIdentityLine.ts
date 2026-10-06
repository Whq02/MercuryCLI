import { signInLedgerEpoch } from '../../utils/accounts/signInLedger.js'
import { credentialEnvNames } from '../../utils/router/providerSecrets.js'
import { accountIdentityShown, familyAccountWord } from '../wallet/identityWords.js'
import { catalogueEpoch } from './catalogueEpoch.js'
import { deriveFamilySlotGroups, type AccountSlot, type AccountSlotReads, type FamilySlotGroup } from './accountSlots.js'
import { presenceIdentityWords, providerFamilyPresences, type ProviderFamilyPresence } from './providerUsage.js'

export const NO_ACCOUNT_WORDS = 'no account'
export const SIGNED_IN_AS_WORDS = 'Signed in as'

export type ProviderIdentityLine =
  | { kind: 'account'; text: string }
  | { kind: 'label'; text: string }
  | { kind: 'none'; text: typeof NO_ACCOUNT_WORDS }

const DOOR_WORDS: Readonly<Record<string, string>> = { 'OAuth-minted key': 'OAuth key' }

function doorWordOf(slot: AccountSlot): string {
  const bare = slot.kindLabel.replace(/ · (env|helper)$/, '')
  return DOOR_WORDS[bare] ?? bare
}

function keyTailOf(slot: AccountSlot): string | undefined {
  return /…\S+$/.exec(slot.identity)?.[0]
}

function isKeySlot(slot: AccountSlot): boolean {
  return slot.kind === 'api-key' || slot.kindLabel === 'OAuth-minted key'
}

export function providerIdentityLineOf(
  family: Pick<ProviderFamilyPresence, 'credentialed' | 'credentialLabel' | 'identity'> & { id: string },
  slots: readonly AccountSlot[],
  shown: boolean = accountIdentityShown(),
): ProviderIdentityLine {
  if (!family.credentialed) return { kind: 'none', text: NO_ACCOUNT_WORDS }
  const identity = family.identity?.trim()
  if (identity !== undefined && identity !== '') {
    return shown ? { kind: 'account', text: identity } : { kind: 'label', text: familyAccountWord(family.id) ?? 'signed in' }
  }
  const signedIn = slots.filter(slot => slot.signedIn)
  const active = signedIn.find(slot => slot.active) ?? signedIn[0]
  if (active !== undefined && isKeySlot(active)) {
    const tail = keyTailOf(active)
    if (tail !== undefined) return { kind: 'label', text: shown ? `${doorWordOf(active)} · ${tail}` : doorWordOf(active) }
  }
  return { kind: 'label', text: presenceIdentityWords(family, shown) ?? (shown ? active?.identity : undefined) ?? active?.kindLabel ?? 'signed in' }
}

export function providerDoorAccount(slot: AccountSlot, identity?: string, shown: boolean = accountIdentityShown()): string | undefined {
  if (!shown) return undefined
  if (slot.kind !== 'api-key' && identity !== undefined) return identity
  if (slot.signInEmail !== undefined) return slot.signInEmail
  if (slot.identity.includes('@')) return slot.identity
  return keyTailOf(slot)
}

export function providerIdentitySentence(line: ProviderIdentityLine): string {
  return line.kind === 'account' ? `${SIGNED_IN_AS_WORDS} ${line.text}` : line.text
}

const IDENTITY_MEMO_MS = 2_000
let memo: { key: string; at: number; groups: FamilySlotGroup[] } | null = null

function presenceDigest(): string {
  try {
    return JSON.stringify(providerFamilyPresences())
  } catch {
    return 'none'
  }
}

function memoKey(): string {
  let env = ''
  for (const name of credentialEnvNames()) env += `${name}=${process.env[name] ?? ''}\u0000`
  return `${signInLedgerEpoch()}:${catalogueEpoch()}:${env}:${presenceDigest()}`
}

function familyGroups(reads?: AccountSlotReads): FamilySlotGroup[] {
  if (reads !== undefined) return deriveFamilySlotGroups(undefined, reads)
  const key = memoKey()
  const now = Date.now()
  if (memo !== null && memo.key === key && now - memo.at < IDENTITY_MEMO_MS) return memo.groups
  let groups: FamilySlotGroup[]
  try {
    groups = deriveFamilySlotGroups()
  } catch {
    groups = []
  }
  memo = { key, at: now, groups }
  return groups
}

export function providerIdentityLine(family: string, reads?: AccountSlotReads): ProviderIdentityLine {
  const group = familyGroups(reads).find(candidate => candidate.family.id === family)
  if (group === undefined) return { kind: 'none', text: NO_ACCOUNT_WORDS }
  return providerIdentityLineOf(group.family, group.slots)
}

export function shownIdentityWords(family: string, words: string, shown: boolean = accountIdentityShown(), reads?: AccountSlotReads): string {
  if (shown) return words
  const bare = words.replace(/\s*…\S+$/, '')
  const identity = familyGroups(reads).find(candidate => candidate.family.id === family)?.family.identity?.trim()
  const carries = bare.includes('@') || (identity !== undefined && identity !== '' && bare.includes(identity))
  return carries ? (familyAccountWord(family) ?? 'signed in') : bare
}
