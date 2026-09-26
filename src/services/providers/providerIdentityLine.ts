import { signInLedgerEpoch } from '../../utils/accounts/signInLedger.js'
import { credentialEnvNames } from '../../utils/router/providerSecrets.js'
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
  family: Pick<ProviderFamilyPresence, 'credentialed' | 'credentialLabel' | 'identity'>,
  slots: readonly AccountSlot[],
): ProviderIdentityLine {
  if (!family.credentialed) return { kind: 'none', text: NO_ACCOUNT_WORDS }
  const identity = family.identity?.trim()
  if (identity !== undefined && identity !== '') return { kind: 'account', text: identity }
  const signedIn = slots.filter(slot => slot.signedIn)
  const active = signedIn.find(slot => slot.active) ?? signedIn[0]
  if (active !== undefined && isKeySlot(active)) {
    const tail = keyTailOf(active)
    if (tail !== undefined) return { kind: 'label', text: `${doorWordOf(active)} · ${tail}` }
  }
  return { kind: 'label', text: presenceIdentityWords(family) ?? active?.identity ?? active?.kindLabel ?? 'signed in' }
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

export function resetProviderIdentityMemo(): void {
  memo = null
}

export function providerIdentityLine(family: string, reads?: AccountSlotReads): ProviderIdentityLine {
  const group = familyGroups(reads).find(candidate => candidate.family.id === family)
  if (group === undefined) return { kind: 'none', text: NO_ACCOUNT_WORDS }
  return providerIdentityLineOf(group.family, group.slots)
}
