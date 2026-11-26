import { readSignInRefusal, signInRefusalWords, type SignInRefusal } from '../../../models/roads/signInRefusal.js';
import { deriveFamilySlotGroups, familyDisplayName, type AccountSlot, type FamilySlotGroup } from '../../../models/roads/accountSlots.js';
import { resolveProviderUsability, type ProviderId, type ProviderUsability } from '../../../models/roads/providerUsability.js';
import type { ProviderFamilyPresence } from '../../../models/roads/providerUsage.js';
import { providerDisplayName } from '../../../models/roads/routeLaw.js';
import { mostRecentSignInFamily } from '../../../models/catalogue/computedDefault.js';
import { wrapPlain } from '../BootHealthScreen.js';
import { DEVIN_EXTERNAL_AGENT_LABEL, DEVIN_EXTERNAL_AGENT_VALUE, loginFamilyFocusFor, loginFamilyNameOf, loginFamilyRows, type LoginFamilyRow } from '../../../models/sign-in/flow-cards/loginFamilyRows.js';
import { DEVIN_CLI_ACTION_SUMMARY, DEVIN_CLI_ACTION_TITLE, DEVIN_CLI_CHIP, devinCliDetailLines } from './devinCliAction.js';
import { keysOf } from '../../../platform/primitives/entriesOf.js'
export const DETAIL_W = 38;

const UNAVAILABLE_REASON_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['no-api-key:', 'no key'],
  ['no-account:', 'not signed in'],
  ['no-credential:', 'not signed in'],
  ['no-auth:', 'not signed in'],
  ['not-configured:', 'not configured'],
  ['no-server:', 'no server discovered'],
  ['discovery-pending:', 'not probed yet'],
  ['disabled:', 'disabled'],
  ['no-executable:', 'unavailable'],
];

function unavailableReasonWords(reason: string | undefined): string {
  if (reason === undefined || reason === '') return 'unavailable';
  for (const [prefix, words] of UNAVAILABLE_REASON_WORDS) {
    if (reason.startsWith(prefix)) return words;
  }
  if (/^[a-z][a-z0-9-]*:/.test(reason)) return 'unavailable';
  return reason;
}

export interface LoginsScreenFactsV1 {
  groups: FamilySlotGroup[];
  usability: Record<ProviderId, ProviderUsability>;
  defaultFamily?: string;
  refusals?: Partial<Record<ProviderId, SignInRefusal>>;
}

export function collectLoginsScreenFacts(): LoginsScreenFactsV1 {
  const defaultFamily = mostRecentSignInFamily();
  const usability = resolveProviderUsability();
  const refusals: Partial<Record<ProviderId, SignInRefusal>> = {};
  for (const family of keysOf(usability)) {
    const refusal = readSignInRefusal(family);
    if (!refusal) continue;
    refusals[family] = refusal;
    usability[family] = { ...usability[family], usable: false, blockers: [signInRefusalWords(refusal, family)] };
  }
  return {
    groups: deriveFamilySlotGroups(),
    usability,
    refusals,
    ...(defaultFamily !== undefined ? { defaultFamily } : {}),
  };
}

export interface LoginsArmV1 {
  row: LoginFamilyRow;
  familyId: ProviderId;
}

export function loginsCatalogue(): LoginsArmV1[] {
  return loginFamilyRows({ engineLegs: true }).map(row => ({
    row,
    familyId: row.value.startsWith('compat/') ? 'openai-compat' : (row.value as ProviderId),
  }));
}

export function loginsFamilyCounts(groups: readonly FamilySlotGroup[]): { familyIds: ProviderId[]; signed: number } {
  const familyIds = [...new Set(loginsCatalogue().map(a => a.familyId))];
  const signed = familyIds.filter(id => (groups.find(g => g.family.id === id)?.slots ?? []).some(s => s.signedIn)).length;
  return { familyIds, signed };
}

export function loginsExpiredFamilies(groups: readonly FamilySlotGroup[]): ProviderId[] {
  return groups.filter(g => g.slots.some(s => s.expired === true && !s.signedIn)).map(g => g.family.id as ProviderId);
}

export function loginsGlance(groups: readonly FamilySlotGroup[]): string {
  const expired = loginsExpiredFamilies(groups);
  if (expired.length > 0) return `${providerDisplayName(expired[0]!)} sign-in expired — sign in again`;
  const { familyIds, signed } = loginsFamilyCounts(groups);
  return signed > 0 ? `${signed} of ${familyIds.length} signed in` : 'not signed in — sign in to providers';
}

export function loginsArmSlots(arm: LoginsArmV1, group: FamilySlotGroup | undefined): AccountSlot[] {
  const slots = group?.slots ?? [];
  if (arm.row.value.startsWith('compat/')) return slots.filter(slot => slot.id.startsWith(`openai-compat:${arm.row.value.slice(7)}:`));
  return slots;
}

export function loginsSwitchableFamily(
  arm: LoginsArmV1,
  facts: LoginsScreenFactsV1,
): 'anthropic' | 'openai' | null {
  if (arm.familyId !== 'anthropic' && arm.familyId !== 'openai') return null;
  const slots = facts.groups.find(g => g.family.id === arm.familyId)?.slots ?? [];
  if (arm.familyId === 'anthropic') {
    const signIn = slots.some(s => s.scope !== undefined && !s.scope.foreignHarness && s.signedIn);
    const managedKey = slots.some(s => s.removal.route === 'anthropic-managed-key' && s.signedIn);
    return signIn && managedKey ? 'anthropic' : null;
  }
  const subscription = slots.some(s => s.kind === 'subscription' && s.signedIn);
  const key = slots.some(s => s.kind === 'api-key' && s.signedIn);
  return subscription && key ? 'openai' : null;
}

export const clampText = (s: string, w: number): string => (s.length > w ? s.slice(0, w - 1) + '…' : s);

export interface LoginsRowStateV1 {
  chip: string;
  loud: boolean;
  signedIn: boolean;
  refusal?: SignInRefusal;
}

export function loginsRowStateOf(arm: LoginsArmV1, facts: LoginsScreenFactsV1): LoginsRowStateV1 {
  const group = facts.groups.find(g => g.family.id === arm.familyId);
  if (group === undefined) {
    return { chip: 'not in this build', loud: false, signedIn: false };
  }
  const slots = loginsArmSlots(arm, group);
  const signedInSlots = slots.filter(s => s.signedIn);
  const signedIn = signedInSlots.length > 0;
  const refusal = facts.refusals?.[arm.familyId];
  if (refusal && slots.length > 0) return { chip: signInRefusalWords(refusal, arm.familyId), loud: true, signedIn, refusal };
  const expiredSlot = slots.find(s => s.expired === true);
  const expired =
    expiredSlot !== undefined ||
    (group.family as ProviderFamilyPresence & { expired?: boolean }).expired === true;
  let chip: string;
  if (!signedIn) {
    chip =
      expiredSlot !== undefined
        ? expiredSlot.identity || expiredSlot.kindLabel
        : group.family.available === false
          ? unavailableReasonWords(group.family.reason)
          : 'not signed in';
  } else {
    const first = signedInSlots[0]!;
    chip = first.identity || first.kindLabel;
    if (signedInSlots.length > 1) chip += ` +${signedInSlots.length - 1}`;
  }
  let loud = false;
  if (expired && (signedIn || expiredSlot !== undefined)) {
    chip += ' · expired';
    loud = true;
  }
  const lane = facts.usability[arm.familyId];
  if (signedIn && lane !== undefined) {
    if (lane.usable && lane.limit === 'rejected') {
      chip += ' · window reached';
      loud = true;
    } else if (!lane.usable && !expired) {
      chip += ' · not ready';
      loud = true;
    }
  }
  return { chip, loud, signedIn };
}

export function loginsSortedArms(facts: LoginsScreenFactsV1): LoginsArmV1[] {
  const arms = loginsCatalogue();
  return [
    ...arms.filter(a => loginsRowStateOf(a, facts).signedIn),
    ...arms.filter(a => !loginsRowStateOf(a, facts).signedIn),
  ];
}

export type LoginsRosterRowV1 =
  | { kind: 'provider'; arm: LoginsArmV1 }
  | { kind: 'external-agent'; id: 'devin'; label: string; value: typeof DEVIN_EXTERNAL_AGENT_VALUE };

export function loginsRosterRows(facts: LoginsScreenFactsV1): LoginsRosterRowV1[] {
  return [
    ...loginsSortedArms(facts).map(arm => ({ kind: 'provider' as const, arm })),
    { kind: 'external-agent', id: 'devin', label: DEVIN_EXTERNAL_AGENT_LABEL, value: DEVIN_EXTERNAL_AGENT_VALUE },
  ];
}

export function loginsRosterRowValue(row: LoginsRosterRowV1): LoginFamilyRow['value'] {
  return row.kind === 'provider' ? row.arm.row.value : row.value;
}

export function loginsRosterRowLabel(row: LoginsRosterRowV1): string {
  return row.kind === 'provider' ? row.arm.row.label : row.label;
}

export function loginsRosterEntryOf(row: LoginsRosterRowV1, facts: LoginsScreenFactsV1): LoginsEntry {
  if (row.kind === 'provider') return loginsEntryOf(row.arm, facts);
  return {
    label: row.label,
    detailLabel: DEVIN_CLI_ACTION_TITLE,
    group: 'external agents',
    groupTitle: 'external agents',
    summary: DEVIN_CLI_ACTION_SUMMARY,
    valueLabel: DEVIN_CLI_CHIP,
    valueIsDefault: true,
    pinnedVal: null,
    detail: null,
  };
}

export function loginsRosterDetailLines(row: LoginsRosterRowV1, facts: LoginsScreenFactsV1): string[] {
  if (row.kind === 'provider') return loginsDetailLines(row.arm, facts);
  return devinCliDetailLines();
}
export type LoginsEntry = {
  label: string;
  detailLabel?: string;
  group: string;
  groupTitle: string;
  summary: string;
  valueLabel: string;
  valueIsDefault: boolean;
  pinnedVal: null;
  detail: null;
  inert?: boolean;
};

export function loginsEntryOf(arm: LoginsArmV1, facts: LoginsScreenFactsV1): LoginsEntry {
  const state = loginsRowStateOf(arm, facts);
  const klass = state.signedIn ? 'signed in' : 'available';
  return {
    label: arm.row.label,
    detailLabel: loginFamilyNameOf(arm.row),
    group: klass,
    groupTitle: klass,
    summary: `${familyDisplayName(arm.familyId)} · ${state.chip}`,
    valueLabel: state.chip,
    valueIsDefault: !state.loud,
    pinnedVal: null,
    detail: null,
  };
}

export function loginsDetailLines(arm: LoginsArmV1, facts: LoginsScreenFactsV1): string[] {
  const group = facts.groups.find(g => g.family.id === arm.familyId);
  const state = loginsRowStateOf(arm, facts);
  const lines: string[] = [familyDisplayName(arm.familyId), ''];
  lines.push(...wrapPlain(arm.row.label, DETAIL_W));
  lines.push('');
  lines.push(`state: ${state.chip}`);
  const slots = loginsArmSlots(arm, group);
  if (slots.length === 0) {
    lines.push('· no sign-in on this arm yet');
  } else {
    for (const slot of slots) {
      lines.push(
        ...wrapPlain(
          `· ${slot.kindLabel} — ${slot.identity || 'present'}${slot.active ? ' · active' : ''}${slot.signedIn ? '' : ' · not signed in'}${slot.stateNote ? ` · ${slot.stateNote}` : ''}`,
          DETAIL_W,
        ),
      );
    }
  }
  const lane = facts.usability[arm.familyId];
  if (lane !== undefined) {
    lines.push('');
    if (lane.usable) {
      lines.push(`ready · ${lane.credential}${lane.limit === 'rejected' ? ' · window reached' : ''}`);
    } else {
      for (const blocker of lane.blockers.length > 0 ? lane.blockers : ['not ready']) {
        lines.push(...wrapPlain(`· ${blocker}`, DETAIL_W));
      }
    }
  }
  if (loginsSwitchableFamily(arm, facts) !== null) {
    lines.push('');
    lines.push(...wrapPlain('both slots signed in — s switches the active slot (the next turn rides it)', DETAIL_W));
  }
  return lines;
}

export function lateSettleNotice(familyId: string): string {
  return `${familyDisplayName(familyId)} sign-in completed after cancel — the approval landed while the flow was closing, so the account IS signed in. ⌫ on its row (or /accounts) signs it out.`;
}

export function loginsSummaryRows(facts: LoginsScreenFactsV1, notice?: string | null): Array<{ key: string; value: string; tone?: 'teal' | 'faint' }> {
  if (notice != null && notice !== '') {
    return [{ key: 'Notice', value: notice, tone: 'teal' }, ...loginsSummaryRows(facts)];
  }
  const { familyIds, signed } = loginsFamilyCounts(facts.groups);
  const ready = familyIds.filter(id => facts.usability[id]?.usable === true).length;
  const recorded = loginFamilyFocusFor(facts.defaultFamily);
  return [
    { key: 'Families', value: `${familyIds.length}` },
    { key: 'Signed in', value: `${signed} of ${familyIds.length}`, tone: signed > 0 ? 'teal' : 'faint' },
    { key: 'Ready', value: `${ready} lane${ready === 1 ? '' : 's'}`, tone: ready > 0 ? 'teal' : 'faint' },
    ...(recorded !== undefined ? [{ key: 'Default', value: familyDisplayName(recorded) }] : []),
  ];
}

export function loginsStatusLine(facts: LoginsScreenFactsV1): string {
  const { familyIds, signed } = loginsFamilyCounts(facts.groups);
  const ready = familyIds.filter(id => facts.usability[id]?.usable === true).length;
  return signed === 0
    ? `no family signed in yet · ${ready} ready without one`
    : `${signed} of ${familyIds.length} families signed in · ${ready} ready`;
}

export function loginsFlowReady(_value: LoginFamilyRow['value']): boolean {
  return true;
}

export function loginsLegendOf(switchable = false): string {
  return switchable ? '↑↓ move · pgup/pgdn page · ↵ sign in · s switch slot · esc back' : '↑↓ move · pgup/pgdn page · ↵ sign in · esc back';
}
