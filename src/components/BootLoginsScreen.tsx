import React, { useMemo, useRef, useState } from 'react';
import { basename } from 'node:path';
import { Box, useInput } from '../ink.js';
import { createSplashCore, WORD_W, type BootMenuData } from '../../assets/splash/splash-core.mjs';
import {
  useAnthropicLoginModel,
  type AnthropicLoginSnapshot,
} from './mercury-ui/screens/anthropicLoginModel.js';
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js';
import { storeOpenaiApiKeyLogin } from '../services/providers/openai/openaiLogin.js';
import { storeZaiApiKeyLogin, zaiPlanLabel } from '../services/providers/zai/zaiLogin.js';
import { storeDeepseekApiKeyLogin } from '../services/providers/deepseek/deepseekLogin.js';
import {
  runKimiDeviceLogin,
  storeMoonshotApiKeyLogin,
} from '../services/providers/moonshot/moonshotLogin.js';
import { moonshotStoredRegion, type KimiRegion } from '../services/providers/moonshot/moonshotAccounts.js';
import {
  runHuggingfaceDeviceLogin,
  storeHuggingfaceTokenLogin,
} from '../services/providers/huggingface/huggingfaceLogin.js';
import {
  OPENAI_DEVICE_STOPPED_RECEIPT,
  finishOpenaiSubscriptionConnect,
  openaiConnectFailedReceipt,
} from '../services/providers/openai/openaiLogin.js';
import {
  beginOpenaiBrowserConnect,
  beginOpenaiDeviceConnect,
} from '../services/providers/openai/openaiAccounts.js';
import {
  finishOpenrouterConnect,
  openrouterConnectFailedReceipt,
  storeOpenrouterApiKeyLogin,
} from '../services/providers/openrouter/openrouterLogin.js';
import { beginOpenrouterConnect } from '../services/providers/openrouter/openrouterAccounts.js';
import {
  finishGeminiOauthConnect,
  geminiConnectFailedReceipt,
  storeGeminiApiKeyLogin,
} from '../services/providers/gemini/geminiLogin.js';
import {
  beginGeminiBrowserConnect,
  geminiOauthClientConfig,
  geminiOauthClientMissingCopy,
  GEMINI_CLIENT_STORED_UNVERIFIED_NOTE,
  writeGeminiOauthClientConfig,
} from '../services/providers/gemini/geminiAccounts.js';
import { useSetAppStateMaybe } from '../state/AppState.js';
import { openBrowser } from '../utils/browser.js';
import { setClipboard } from '../ink/termio/osc.js';
import {
  deriveFamilySlotGroups,
  familyDisplayName,
  type AccountSlot,
  type FamilySlotGroup,
} from '../services/providers/accountSlots.js';
import {
  resolveProviderUsability,
  type ProviderId,
  type ProviderUsability,
} from '../services/providers/providerUsability.js';
import type { ProviderFamilyPresence } from '../services/providers/providerUsage.js';
import { mostRecentSignInFamily } from '../utils/model/computedDefault.js';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { renderModelChip } from '../utils/model/model.js';
import { wrapPlain } from './BootHealthScreen.js';
import {
  loginFamilyFocusFor,
  loginFamilyRows,
  openaiArmPickRows,
  type LoginFamilyRow,
} from './loginFamilyRows.js';
import { InteractiveRow } from './mercury-ui/InteractiveRow.js';
import { renderSceneLine } from './mercury-ui/SceneCanvas.js';
import { getSessionAccent, getSessionCritterKey } from './mercury-ui/sessionAccent.js';
import { useGreetingShimmer } from './mercury-ui/useGreetingShimmer.js';
import { useInteractiveList } from './mercury-ui/useInteractiveList.js';
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js';
import { useSplashCoreAccent } from './mercury-ui/useSplashCoreAccent.js';

/**
 * BootLoginsScreen — the Boot face's OWN logins door (the operator's ruling: the full sign-in catalogue lives on the face "with
 * its own container and everything … a different UI, but they should share
 * the same home"). A composeBootMenu layer sibling of the settings / kit /
 * health / resume / saturn screens: full-composition replacement,
 * fullScene+onClose, esc restores the face with selection intact.
 *
 * ONE HOME, MANY SKINS (law 2): the rows are THE row owner's
 * (loginFamilyRows — the same list /logins and the first-run walk render);
 * every state chip derives from THE presence/slot owner
 * (deriveFamilySlotGroups, itself over providerFamilyPresences) and THE
 * readiness resolver (resolveProviderUsability) — zero second enumerations,
 * zero second writers, never an optimistic flip. The two Anthropic rows
 * read their own ARMS of the one anthropic family: the subscription row
 * wears the claude.ai/subscription slots, the usage-based row wears the
 * API-key slot the Console mint stores.
 *
 * NEVER THE CHAT (law 1): this module reaches no route verb — opening,
 * walking and closing this layer cannot move the surface, structurally.
 *
 * Facts are INJECTABLE (proof stills and staticRender legs freeze them);
 * the live default reads the owners once at mount.
 */

const DETAIL_W = 38;
const CHIP_W = 26;

export interface LoginsScreenFactsV1 {
  /** THE slot owner's per-family view (presence + slots), one read. */
  groups: FamilySlotGroup[];
  /** THE readiness resolver's map, one read. */
  usability: Record<ProviderId, ProviderUsability>;
  /** The default provider — the family of the most recent sign-in that
   *  still holds a credential (the computed default's owner), one read;
   *  absent = no sign-in anywhere. Facts-borne so every composer below
   *  stays pure (a still never reads the machine's live credentials). */
  defaultFamily?: string;
}

/** The live read — each field its OWNING resolver, nothing else. */
export function collectLoginsScreenFacts(): LoginsScreenFactsV1 {
  const defaultFamily = mostRecentSignInFamily();
  return {
    groups: deriveFamilySlotGroups(),
    usability: resolveProviderUsability(),
    ...(defaultFamily !== undefined ? { defaultFamily } : {}),
  };
}

/** A catalogue row bound to the family ARM its sign-in credentials: the
 *  subscription row and the usage-based row are two arms of the ONE
 *  anthropic family; every engine row is its family whole. */
export interface LoginsArmV1 {
  row: LoginFamilyRow;
  familyId: ProviderId;
  arm: 'subscription' | 'key' | 'family';
}

/** The face's catalogue: THE row owner's list with engine legs offered
 *  (the layer settles engine outcomes itself), each row mapped onto its
 *  presence family. The walk's "sign in later" row is structurally absent
 *  (no onSkip seam exists here — esc already closes the layer). */
export function loginsCatalogue(): LoginsArmV1[] {
  return loginFamilyRows({ engineLegs: true }).map(row => ({
    row,
    familyId: row.value === 'claudeai' || row.value === 'console' ? 'anthropic' : (row.value as ProviderId),
    arm: row.value === 'claudeai' ? 'subscription' : row.value === 'console' ? 'key' : 'family',
  }));
}

/** The slots one ROW reads: its arm's slice of the family's slot list. */
export function loginsArmSlots(arm: LoginsArmV1, group: FamilySlotGroup | undefined): AccountSlot[] {
  const slots = group?.slots ?? [];
  if (arm.arm === 'subscription') return slots.filter(s => s.kind !== 'api-key');
  if (arm.arm === 'key') return slots.filter(s => s.kind === 'api-key');
  return slots;
}

/** The focused row's switchable two-slot family, or null (the `s` gesture
 *  exists exactly where the pair does). The pair is the
 *  family's two Mercury-held slot KINDS both signed in: anthropic = the
 *  claude.ai sign-in + the /logins MANAGED key (env pins and the settings
 *  helper are not Mercury seats); openai = the ChatGPT subscription + an
 *  API key (env or stored — the seat preference governs either). */
export function loginsSwitchableFamily(
  arm: LoginsArmV1,
  facts: LoginsScreenFactsV1,
): 'anthropic' | 'openai' | null {
  if (arm.familyId !== 'anthropic' && arm.familyId !== 'openai') return null;
  const slots = facts.groups.find(g => g.family.id === arm.familyId)?.slots ?? [];
  if (arm.familyId === 'anthropic') {
    const signIn = slots.some(s => s.scope !== undefined && !s.scope.claudeFamily && s.signedIn);
    const managedKey = slots.some(s => s.removal.route === 'anthropic-managed-key' && s.signedIn);
    return signIn && managedKey ? 'anthropic' : null;
  }
  const subscription = slots.some(s => s.kind === 'subscription' && s.signedIn);
  const key = slots.some(s => s.kind === 'api-key' && s.signedIn);
  return subscription && key ? 'openai' : null;
}

const fitChip = (text: string): string => (text.length > CHIP_W ? text.slice(0, CHIP_W - 1) + '…' : text);
const clampText = (s: string, w: number): string => (s.length > w ? s.slice(0, w - 1) + '…' : s);

export interface LoginsRowStateV1 {
  /** The value column's words (an identity, a state, a reason). */
  chip: string;
  /** Something WRONG is asserted (expired · not ready · window reached) —
   *  the row stands out; plain absence reads like a default. */
  loud: boolean;
  /** The grouping fact: any sign-in on this row's arm. */
  signedIn: boolean;
}

/** One row's truthful state, fused from the owners — never a guess. */
export function loginsRowStateOf(arm: LoginsArmV1, facts: LoginsScreenFactsV1): LoginsRowStateV1 {
  const group = facts.groups.find(g => g.family.id === arm.familyId);
  if (group === undefined) {
    // Absent ≠ empty: the snapshot did not carry this family at all.
    return { chip: 'not in this build', loud: false, signedIn: false };
  }
  const slots = loginsArmSlots(arm, group);
  const signedInSlots = slots.filter(s => s.signedIn);
  const signedIn = signedInSlots.length > 0;
  let chip: string;
  if (!signedIn) {
    chip =
      group.family.available === false
        ? fitChip(group.family.reason ?? 'unavailable')
        : 'not signed in';
  } else {
    const first = signedInSlots[0]!;
    chip = fitChip(first.identity || first.kindLabel);
    if (signedInSlots.length > 1) chip += ` +${signedInSlots.length - 1}`;
  }
  let loud = false;
  // The subscription arm's present-but-dead honesty (the presence owner's
  // own optional fact — anthropicCredentialPresence records an observed
  // expiry; existence stays true, ready must not be pretended).
  const expired =
    arm.arm === 'subscription' &&
    (group.family as ProviderFamilyPresence & { expired?: boolean }).expired === true;
  if (expired && signedIn) {
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

/** The composed order: signed-in rows first (the catalogue's own order
 *  within each class) — the operator's live lanes float to the top and the
 *  section titles carry the class. */
export function loginsSortedArms(facts: LoginsScreenFactsV1): LoginsArmV1[] {
  const arms = loginsCatalogue();
  return [
    ...arms.filter(a => loginsRowStateOf(a, facts).signedIn),
    ...arms.filter(a => !loginsRowStateOf(a, facts).signedIn),
  ];
}

/** One composer entry (structurally what composeBootMenu consumes). */
export type LoginsEntry = {
  label: string;
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
    label: clampText(arm.row.label, 40),
    group: klass,
    groupTitle: klass,
    summary: `${familyDisplayName(arm.familyId)} · ${state.chip}`,
    valueLabel: state.chip,
    valueIsDefault: !state.loud,
    pinnedVal: null,
    detail: null,
  };
}

/** The selected row's trail (pure; SETTING DETAIL body): the arm's own
 *  sentence, each slot with its kind/identity/active truth, then the
 *  readiness verdict — a not-ready lane's typed blockers VERBATIM (the
 *  /logins readiness block's law), never a generic "unavailable". */
export function loginsDetailLines(arm: LoginsArmV1, facts: LoginsScreenFactsV1): string[] {
  const group = facts.groups.find(g => g.family.id === arm.familyId);
  const state = loginsRowStateOf(arm, facts);
  const lines: string[] = [
    `${familyDisplayName(arm.familyId)}${arm.arm === 'subscription' ? ' · subscription arm' : arm.arm === 'key' ? ' · usage-based arm' : ''}`,
    '',
  ];
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

/** The late-settle disclosure sentence (the disclose-not-unwind ruling's
 *  E1): ONE spelling for every family whose connect completed after the
 *  operator cancelled — painted as a loud panel row, spoken beside the
 *  repainted roster/chips, never only a dropped stale settle. */
export function lateSettleNotice(familyId: string): string {
  return `${familyDisplayName(familyId)} sign-in completed after cancel — the approval landed while the flow was closing, so the account IS signed in. ⌫ on its row (or /accounts) signs it out.`;
}

/** The LOGINS panel rows (pure): counts over the catalogue's DISTINCT
 *  families (the two Anthropic rows are one family), from the one owner.
 *  A late-settle notice rides FIRST and loud — the operator cancelled and
 *  a sign-in landed anyway; the panel must say so where they look. */
export function loginsSummaryRows(facts: LoginsScreenFactsV1, notice?: string | null): Array<{ key: string; value: string; tone?: 'teal' | 'faint' }> {
  if (notice != null && notice !== '') {
    return [{ key: 'Notice', value: notice, tone: 'teal' }, ...loginsSummaryRows(facts)];
  }
  const familyIds = [...new Set(loginsCatalogue().map(a => a.familyId))];
  const signed = familyIds.filter(id => (facts.groups.find(g => g.family.id === id)?.slots ?? []).some(s => s.signedIn)).length;
  const ready = familyIds.filter(id => facts.usability[id]?.usable === true).length;
  const recorded = loginFamilyFocusFor(facts.defaultFamily);
  return [
    { key: 'Families', value: `${familyIds.length}` },
    { key: 'Signed in', value: `${signed} of ${familyIds.length}`, tone: signed > 0 ? 'teal' : 'faint' },
    { key: 'Ready', value: `${ready} lane${ready === 1 ? '' : 's'}`, tone: ready > 0 ? 'teal' : 'faint' },
    ...(recorded !== undefined ? [{ key: 'Default', value: familyDisplayName(recorded === 'claudeai' || recorded === 'console' ? 'anthropic' : recorded) }] : []),
  ];
}

/** The status bar's standing line (pure; the pin reads it). */
export function loginsStatusLine(facts: LoginsScreenFactsV1): string {
  const familyIds = [...new Set(loginsCatalogue().map(a => a.familyId))];
  const signed = familyIds.filter(id => (facts.groups.find(g => g.family.id === id)?.slots ?? []).some(s => s.signedIn)).length;
  const ready = familyIds.filter(id => facts.usability[id]?.usable === true).length;
  return signed === 0
    ? `no family signed in yet · ${ready} ready without one`
    : `${signed} of ${familyIds.length} families signed in · ${ready} ready`;
}

/** The rows whose sign-in FLOW is built on this layer (widened commit by
 *  commit as the panes land; every other row keeps its truthful chip and
 *  no dead ↵). By the card recut every catalogue row is here. */
export function loginsFlowReady(_value: LoginFamilyRow['value']): boolean {
  // A6b closed the set: EVERY catalogue row's flow is built on this layer.
  return true;
}

/** The list keys (pure): only the moves that exist — ↵ exactly where a
 *  flow is built (the when-gate keeps every other row honest), `s` exactly
 *  where the focused family's two-slot pair is signed in. */
export function loginsLegendOf(switchable = false): string {
  return switchable ? '↑↓ move · ↵ sign in · s switch slot · esc back' : '↑↓ move · ↵ sign in · esc back';
}

// ── THE ANTHROPIC FLOW PANE (A4): the machine's states as SETTING DETAIL —
//    the roster stays composed beneath; the pane owns the panel while the
//    flow is open (the manager's action layering). Every sentence with flow
//    meaning is the MACHINE's own (snapshot.flow carries it verbatim); the
//    pane adds face chrome only. The paste draft is MASKED — a code's
//    bytes never paint anywhere. ─────────────────────────────────────────

const DRAFT_DOTS_MAX = 24;

/** The masked draft line (never the bytes). */
export function maskedDraftLine(draftLen: number): string {
  return `code: ${'•'.repeat(Math.min(draftLen, DRAFT_DOTS_MAX))}${draftLen > DRAFT_DOTS_MAX ? '…' : ''}▌`;
}

/** Hard character wrap for unbreakable words (URLs): wrapPlain keeps whole
 *  words and would hand the composer one long line to clip — a clipped
 *  sign-in URL is unusable, so it breaks at the width instead. */
export function wrapHard(text: string, width: number): string[] {
  const lines: string[] = [];
  for (let at = 0; at < text.length; at += width) lines.push(text.slice(at, at + width));
  return lines.length > 0 ? lines : [''];
}

/** The flow pane's lines per machine state (pure; the stills compose the
 *  same). Every state ends in a painted way out — never stranded. */
export function anthropicFlowPaneLines(snap: AnthropicLoginSnapshot, draftLen: number): string[] {
  const flow = snap.flow;
  switch (flow.name) {
    case 'idle':
      return ['starting…'];
    case 'ready':
      return ['Opening your browser…', '', 'esc cancels — nothing is stored'];
    case 'waiting': {
      const lines: string[] = ['A browser window has been opened —', 'finish signing in there.'];
      if (flow.forcedMethod) lines.push(`(login method pre-selected: ${flow.forcedMethod})`);
      if (snap.pastePromptUp) {
        // Compact by design: the draft line and the way out must FIT the
        // panel at the wide tier — decoration never crowds them off.
        lines.push('Browser did not open? Use this URL:');
        lines.push(...wrapHard(flow.url, DETAIL_W));
        lines.push(snap.copied ? 'copied to clipboard' : 'c copies the URL');
        lines.push('Paste code here if prompted:');
        lines.push(maskedDraftLine(draftLen));
        lines.push('esc cancels the wait');
      } else {
        lines.push('', 'the paste fallback appears in a moment');
        lines.push('', 'esc cancels the wait');
      }
      return lines;
    }
    case 'creating-key':
      return ['Minting the key…', '', 'esc cancels — nothing else is stored'];
    case 'success': {
      const lines: string[] = [`Signed in${snap.accountLabel !== null ? ` as ${snap.accountLabel}` : ''}.`];
      if (flow.warning !== undefined) {
        lines.push('');
        lines.push(...wrapPlain(flow.warning, DETAIL_W));
      }
      if (snap.shadowWarning !== null) {
        lines.push('');
        lines.push(...wrapPlain(snap.shadowWarning, DETAIL_W));
      }
      lines.push('', '↵ done — the roster refreshes');
      return lines;
    }
    case 'error': {
      const lines: string[] = [...wrapPlain(flow.message, DETAIL_W), ''];
      lines.push(flow.retry !== undefined ? '↵ retries · esc closes' : 'esc closes');
      return lines;
    }
    case 'about-to-retry':
      return ['Retrying…'];
  }
}

/** The flow legend per state (pure): only the moves that exist. */
export function anthropicFlowLegendOf(snap: AnthropicLoginSnapshot, draftLen: number): string {
  const flow = snap.flow;
  if (flow.name === 'waiting' && snap.pastePromptUp) {
    return draftLen > 0 ? '↵ submit code · esc cancel' : '↵ submit code · c copy url · esc cancel';
  }
  if (flow.name === 'success') return '↵ done';
  if (flow.name === 'error' && flow.retry !== undefined) return '↵ retry · esc close';
  return 'esc cancel';
}

/** The flow's status-bar words (pure). */
export function anthropicFlowStatusOf(snap: AnthropicLoginSnapshot): string {
  const flow = snap.flow;
  if (flow.name === 'waiting') return 'waiting on the browser sign-in';
  if (flow.name === 'creating-key') return 'minting the usage-based key';
  if (flow.name === 'success') return 'signed in — ↵ returns to the roster';
  if (flow.name === 'error') return 'the sign-in did not settle';
  return 'starting the sign-in';
}

// ── THE PICKS + THE KEY LEGS (A5): sub-choices swap the ENTRIES (the
//    manager's pick layering); a key prompt owns the pane with the masked
//    draft; a settled leg paints the DRIVER's receipt verbatim. Choice
//    labels are the landed cards' own — one vocabulary, never re-worded. ──

export type LoginsPickId = 'openai' | 'zai' | 'moonshot' | 'huggingface' | 'kimi-region' | 'openrouter' | 'gemini';
export type FaceKeyLegId =
  | 'openai-key'
  | 'zai-general'
  | 'zai-coding'
  | 'deepseek'
  | 'moonshot-key'
  | 'hf-token'
  | 'openrouter-key'
  | 'gemini-key';

/** The Gemini choice's labels are LIVE facts (the client gate) — pure over
 *  the two booleans so stills and the screen compose the same. */
export function geminiPickOptions(clientMissing: boolean, clientStored: boolean): Array<{ label: string; value: string }> {
  return [
    { label: 'Paste an API key (stored locally, mode 600)', value: 'key' },
    {
      label: clientMissing
        ? 'Google OAuth — needs an OAuth client first (set it below)'
        : 'Sign in with Google (OAuth, browser)',
      value: 'oauth',
    },
    {
      label: clientStored
        ? 'Update the stored OAuth client (id/secret)'
        : 'Set the OAuth client (id/secret from Google Cloud Console)',
      value: 'client',
    },
  ];
}

/** A pick's option rows — the in-chat cards' labels VERBATIM. The Gemini
 *  card's labels ride the client gate: injectable for stills, live-read
 *  by default. */
export function loginsPickOptions(
  pick: LoginsPickId,
  geminiFacts?: { clientMissing: boolean; clientStored: boolean },
): Array<{ label: string; value: string }> {
  switch (pick) {
    case 'openrouter':
      return [
        { label: 'Sign in with the browser — OAuth mints a scoped key', value: 'browser' },
        { label: 'Headless — OpenRouter shows a code you paste here', value: 'headless' },
        { label: 'Paste an API key (stored locally, mode 600)', value: 'key' },
      ];
    case 'gemini': {
      const facts = geminiFacts ?? {
        clientMissing: Boolean(geminiOauthClientMissingCopy()),
        clientStored: Boolean(geminiOauthClientConfig()),
      };
      return geminiPickOptions(facts.clientMissing, facts.clientStored);
    }
    case 'openai':
      // THE one home (OS-AUTH-1's hoist): the pair comes from the row
      // owner — the in-chat card renders the same rows by construction.
      return [...openaiArmPickRows];
    case 'zai':
      return [
        { label: 'GLM Coding Plan key — api.z.ai/api/coding/paas/v4', value: 'coding' },
        { label: 'Z.AI API key (general, pay-as-you-go) — api.z.ai/api/paas/v4', value: 'general' },
      ];
    case 'moonshot':
      return [
        { label: 'Sign in with Kimi — device code in your browser', value: 'region' },
        { label: 'Paste a Moonshot API key (platform.kimi.ai; stored locally, mode 600)', value: 'key' },
      ];
    case 'huggingface':
      return [
        { label: 'Sign in with Hugging Face — device code in your browser', value: 'device' },
        { label: 'Paste a token (Inference Providers permission; stored locally, mode 600)', value: 'token' },
      ];
    case 'kimi-region':
      return [
        { label: 'Global — kimi.ai (auth.kimi.ai · api.kimi.ai/coding/v1)', value: 'global' },
        { label: 'Mainland China — kimi.com (auth.kimi.com · api.kimi.com/coding/v1)', value: 'mainland-cn' },
      ];
  }
}

/** The pick's explainer pane (the landed cards' own sentences, wrapped). */
export function loginsPickPaneLines(pick: LoginsPickId): string[] {
  const body = ((): string => {
    switch (pick) {
      case 'openai':
        return 'One OpenAI family, two credentials: the ChatGPT subscription signs in with the browser (d on the wait switches to a device code); an API key bills usage-based.';
      case 'zai':
        return 'Z.AI signs in with API keys only (z.ai/manage-apikey). Which key is this? A GLM Coding Plan key is valid on the Coding Plan base and refused on the general one, so the answer picks the base.';
      case 'moonshot':
        return 'A Kimi account signs in with a device code and runs on its plan; a Moonshot platform key bills usage-based. Either one lights the Kimi rows in /model.';
      case 'huggingface':
        return 'One Hub token reaches every open model on Inference Providers (monthly credits first, then pay-as-you-go at provider rates).';
      case 'kimi-region':
        return 'The choice picks the sign-in host and the base your turns ride; it is remembered with the login.';
      case 'openrouter':
        return "One credential unlocks OpenRouter's whole multi-model catalogue (credits-billed).";
      case 'gemini':
        return 'API-key sign-in works immediately; Google OAuth needs your own OAuth client (a one-time Google Cloud setup).';
    }
  })();
  return [
    ...wrapPlain(body, DETAIL_W),
    '',
    pick === 'kimi-region' ? 'esc — back to the Kimi choice' : 'esc — back to the roster',
  ];
}

/** The key legs' face words (titles + store sentences; the guards and the
 *  receipts are the shared owners' — keyPasteGuards and the drivers). */
export function keyLegTitle(leg: FaceKeyLegId): string {
  switch (leg) {
    case 'openai-key':
      return 'OpenAI API key';
    case 'zai-general':
      return zaiPlanLabel('general');
    case 'zai-coding':
      return zaiPlanLabel('coding');
    case 'deepseek':
      return 'DeepSeek API key';
    case 'moonshot-key':
      return 'Moonshot API key';
    case 'hf-token':
      return 'Hugging Face token';
    case 'openrouter-key':
      return 'OpenRouter API key';
    case 'gemini-key':
      return 'Gemini API key';
  }
}

export function keyLegStoreLine(leg: FaceKeyLegId): string {
  // Compact by design (the pane must keep the note and the way out on
  // screen): one sentence, the env-pin honesty named.
  switch (leg) {
    case 'openai-key':
      return 'Stored auth-scoped (mode 600), never logged; OPENAI_API_KEY wins over the store.';
    case 'zai-general':
    case 'zai-coding':
      return 'Stored auth-scoped (mode 600), never logged; ZAI_API_KEY wins over the store.';
    case 'deepseek':
      return 'Proven on the balance endpoint first; stored auth-scoped (mode 600); DEEPSEEK_API_KEY wins.';
    case 'moonshot-key':
      return 'Proven on the balance endpoint first; stored auth-scoped (mode 600); MOONSHOT_API_KEY wins; a Kimi sign-in outranks it.';
    case 'hf-token':
      return 'Proven through whoami first; stored auth-scoped (mode 600); HF_TOKEN wins over the store.';
    case 'openrouter-key':
      return 'Stored auth-scoped (mode 600), never logged; OPENROUTER_API_KEY wins over the store.';
    case 'gemini-key':
      return 'Stored auth-scoped (mode 600), never logged; GOOGLE_API_KEY / GEMINI_API_KEY win over the store.';
  }
}

/** The guard options per leg — the ONE spelling's parameters (the in-chat
 *  legs pass the same; the sentences stay byte-identical either home). */
export function keyLegGuardOpts(leg: FaceKeyLegId): { stores: string; looksLike?: string } {
  switch (leg) {
    case 'openai-key':
      return { stores: 'an OpenAI key. Anthropic usage-based billing signs in through the Console row instead' };
    case 'zai-general':
      return { stores: `a ${zaiPlanLabel('general')}` };
    case 'zai-coding':
      return { stores: `a ${zaiPlanLabel('coding')}` };
    case 'deepseek':
      return { stores: 'a DeepSeek API key' };
    case 'moonshot-key':
      return { stores: 'a Moonshot platform key' };
    case 'hf-token':
      return { stores: 'a Hugging Face token (hf_…)', looksLike: 'a token' };
    case 'openrouter-key':
      return { stores: 'an OpenRouter key (sk-or-…)' };
    case 'gemini-key':
      return { stores: 'a Google Gemini key (AIza…)' };
  }
}

/** The key prompt pane (pure): title · store sentence · MASKED draft ·
 *  the note (a guard or the driver's refusal, verbatim) · the way out.
 *  Compact by design — the note and the way out must FIT the panel. */
export function keyPromptPaneLines(leg: FaceKeyLegId, note: string | null, draftLen: number, storing: boolean): string[] {
  const lines: string[] = [keyLegTitle(leg)];
  lines.push(...wrapPlain(keyLegStoreLine(leg), DETAIL_W));
  lines.push(maskedDraftLine(draftLen).replace('code:', 'key:'));
  if (note !== null) {
    lines.push('');
    lines.push(...wrapPlain(note, DETAIL_W));
  }
  lines.push(storing ? 'checking the key…' : '↵ stores it · esc back');
  return lines;
}

/** A settled leg's receipt pane (pure): the DRIVER's sentence verbatim,
 *  the way out ALWAYS the last visible line (never-stranded — a long
 *  receipt clamps with an ellipsis rather than pushing the exit off; the
 *  ok/not-ok word rides the status bar). */
const RECEIPT_PANE_MAX = 9;
export function receiptPaneLines(receipt: string, _ok: boolean): string[] {
  const wrapped = wrapPlain(receipt, DETAIL_W);
  const body =
    wrapped.length > RECEIPT_PANE_MAX ? [...wrapped.slice(0, RECEIPT_PANE_MAX - 1), '…'] : wrapped;
  return [...body, '↵ done — the roster refreshes'];
}

// ── THE DEVICE WAITS (A6a): the RFC 8628 families' wait pane over the
//    drivers' event stream (moonshotLogin · huggingfaceLogin). TZ-FREE BY
//    CONSTRUCTION: the expiry composes RELATIVE to the injected clock
//    (never a local time string), so the stills stand on every machine. ──

export type FaceDeviceFamily = 'moonshot' | 'huggingface';

export interface DeviceWaitStateV1 {
  family: FaceDeviceFamily;
  /** The Kimi region words (moonshot only; the pick's remembered answer). */
  regionWords?: string;
  phase: 'starting' | 'waiting' | 'finishing';
  userCode?: string;
  verificationUri?: string;
  expiresAtMs?: number;
  polls: number;
  note?: string;
  copied: boolean;
}

export function deviceFamilyWords(family: FaceDeviceFamily, regionWords?: string): string {
  return family === 'moonshot'
    ? `Kimi (device code${regionWords !== undefined ? ` · ${regionWords}` : ''})`
    : 'Hugging Face (device code)';
}

function expiryWords(expiresAtMs: number | undefined, nowMs: number): string {
  if (expiresAtMs === undefined) return '';
  const minutes = Math.max(0, Math.round((expiresAtMs - nowMs) / 60000));
  return minutes <= 0 ? ' · expiring now' : ` · expires in ${minutes}m`;
}

/** The device wait pane (pure): the landed wait screens' facts compact —
 *  the one-time code big, the verification URL hard-wrapped, the poll
 *  count, a transport fault named (clamped — the way out must stay on
 *  screen), the copy ack, the way out ALWAYS last. The family words ride
 *  the status bar, not this pane (the panel is narrow). */
export function deviceWaitPaneLines(d: DeviceWaitStateV1, nowMs: number): string[] {
  if (d.phase === 'starting') {
    return [`Connect ${deviceFamilyWords(d.family, d.regionWords)}`, '', 'Requesting a device code…', '', 'esc cancels — nothing is stored'];
  }
  if (d.phase === 'finishing') {
    return [
      `Connect ${deviceFamilyWords(d.family, d.regionWords)}`,
      '',
      d.family === 'moonshot'
        ? 'Authorized — storing the sign-in and'
        : 'Authorized — reading your Hub identity',
      d.family === 'moonshot' ? 'reading your usage…' : 'and the live catalogue…',
    ];
  }
  const lines: string[] = ['On the sign-in page, enter this code:'];
  lines.push(`    ${d.userCode ?? ''}`);
  lines.push('If nothing opened, visit:');
  lines.push(...wrapHard(d.verificationUri ?? '', DETAIL_W));
  lines.push(`waiting${d.polls > 0 ? ` (${d.polls} check${d.polls === 1 ? '' : 's'})` : ''}${expiryWords(d.expiresAtMs, nowMs)}`);
  if (d.note !== undefined) {
    const wrapped = wrapPlain(d.note, DETAIL_W);
    lines.push(...(wrapped.length > 2 ? [...wrapped.slice(0, 1), wrapped[1]!.slice(0, DETAIL_W - 1) + '…'] : wrapped));
  }
  lines.push(d.copied ? 'copied to clipboard' : 'c copies the URL · esc cancels');
  return lines;
}

// ── THE HANDLES WAITS + THE CLIENT PROMPT (A6b): the loopback/PKCE
//    families' wait pane over their connect HANDLES (openaiAccounts ·
//    openrouterAccounts · geminiAccounts), the OpenAI device leg's honest
//    stop-watching esc, and the Gemini OAuth-client two-field prompt. ────

export type HandlesLegId = 'openai-browser' | 'openrouter-browser' | 'openrouter-headless' | 'gemini-oauth';

export interface HandlesWaitStateV1 {
  leg: HandlesLegId;
  phase: 'waiting' | 'exchanging';
  authorizeUrl?: string;
  listenerNote?: string;
  copied: boolean;
}

/** The handles wait pane (pure): the leg's landed sentence compact, the
 *  URL hard-wrapped, the MASKED paste, the way out — d only on the leg
 *  that has a device sibling. */
export function handlesWaitPaneLines(h: HandlesWaitStateV1, draftLen: number): string[] {
  if (h.phase === 'exchanging') {
    const words =
      h.leg === 'openrouter-browser' || h.leg === 'openrouter-headless'
        ? 'Exchanging the authorization code — OpenRouter mints the key…'
        : 'Exchanging the authorization code…';
    return [...wrapPlain(words, DETAIL_W), '', 'esc cancels'];
  }
  const opening =
    h.leg === 'openrouter-headless'
      ? 'Open this URL on any signed-in browser; OpenRouter displays a code — paste it below.'
      : h.leg === 'gemini-oauth'
        ? 'A browser window should be opening for the Google sign-in; the loopback listener completes automatically.'
        : 'A browser window should be opening; the loopback listener completes automatically.';
  const lines: string[] = [...wrapPlain(opening, DETAIL_W)];
  if (h.listenerNote !== undefined) {
    const wrapped = wrapPlain(h.listenerNote, DETAIL_W);
    lines.push(...(wrapped.length > 2 ? [...wrapped.slice(0, 1), wrapped[1]!.slice(0, DETAIL_W - 1) + '…'] : wrapped));
  }
  lines.push(h.leg === 'openrouter-headless' ? 'URL:' : 'If nothing opened, visit:');
  lines.push(...wrapHard(h.authorizeUrl ?? '', DETAIL_W));
  lines.push(maskedDraftLine(draftLen).replace('code:', h.leg === 'openrouter-headless' ? 'code:' : 'paste:'));
  lines.push(
    h.copied
      ? 'copied to clipboard'
      : h.leg === 'openai-browser'
        ? 'c copy · d device · esc cancel'
        : 'c copy url · esc cancel',
  );
  return lines;
}

export interface OpenaiDeviceStateV1 {
  userCode?: string;
  verifyHint?: string;
  copied: boolean;
}

/** The OpenAI device pane (pure): the one-time code + the verify hint;
 *  esc is the honest STOP-WATCHING (the poll lands if approved). */
export function openaiDevicePaneLines(d: OpenaiDeviceStateV1): string[] {
  if (d.userCode === undefined) {
    return ['Requesting a device code…', '', 'esc cancels — nothing is stored'];
  }
  const lines: string[] = ['On any signed-in browser, enter this', 'one-time code:'];
  lines.push(`    ${d.userCode}`);
  if (d.verifyHint !== undefined) lines.push(...wrapPlain(d.verifyHint, DETAIL_W));
  lines.push('Waiting for approval…');
  lines.push(d.copied ? 'copied to clipboard' : 'c copies the code · esc stops watching');
  return lines;
}

export interface GeminiClientStateV1 {
  field: 'id' | 'secret';
  clientId: string;
  note: string | null;
}

/** The Gemini OAuth-client prompt (pure): the one-time Google Cloud setup
 *  — the id draft paints PLAIN (not a secret; the update flow starts from
 *  the stored id), the secret draft MASKED and optional. */
export function geminiClientPaneLines(c: GeminiClientStateV1, draftLen: number, draft: string): string[] {
  const lines: string[] = ['Set the Google OAuth client (one-time)'];
  lines.push(...wrapPlain('Google Cloud Console → Credentials → OAuth client ID, type "Desktop app"; enable the Generative Language API.', DETAIL_W));
  if (c.field === 'id') {
    lines.push(`id: ${clampText(draft, DETAIL_W - 5)}▌`);
  } else {
    lines.push(...wrapPlain(`id: ${c.clientId} ✓`, DETAIL_W));
    lines.push(`secret (optional, ↵ skips): ${maskedDraftLine(draftLen).replace('code: ', '')}`);
  }
  if (c.note !== null) lines.push(...wrapPlain(c.note, DETAIL_W));
  // The no-probe honesty (one spelling with the in-chat card): the store
  // takes the id on faith; the sentence names where wrongness surfaces.
  if (c.field === 'secret') lines.push(...wrapPlain(GEMINI_CLIENT_STORED_UNVERIFIED_NOTE, DETAIL_W));
  lines.push(c.field === 'id' ? '↵ continues · esc back' : '↵ stores · esc back to the id');
  return lines;
}

/** The union a composed frame renders (the stills compose the same). */
export type LoginsFlowPaneV1 =
  | { kind: 'anthropic'; snap: AnthropicLoginSnapshot; draftLen: number }
  | { kind: 'pick'; pick: LoginsPickId; pickSel: number }
  | { kind: 'key'; leg: FaceKeyLegId; note: string | null; draftLen: number; storing: boolean }
  | { kind: 'device'; device: DeviceWaitStateV1; nowMs: number }
  | { kind: 'handles'; handles: HandlesWaitStateV1; draftLen: number }
  | { kind: 'opdevice'; opdevice: OpenaiDeviceStateV1 }
  | { kind: 'client'; client: GeminiClientStateV1; draftLen: number; draft: string }
  | { kind: 'receipt'; receipt: string; ok: boolean };

export function loginsFlowLegendOf(pane: LoginsFlowPaneV1): string {
  switch (pane.kind) {
    case 'anthropic':
      return anthropicFlowLegendOf(pane.snap, pane.draftLen);
    case 'pick':
      return '↑↓ move · ↵ pick · esc back';
    case 'key':
      return pane.storing ? 'checking…' : '↵ store key · esc back';
    case 'device':
      return pane.device.phase === 'waiting' ? 'c copy url · esc cancel' : 'esc cancel';
    case 'handles':
      return pane.handles.leg === 'openai-browser' && pane.handles.phase === 'waiting'
        ? '↵ submit paste · c copy · d device · esc cancel'
        : pane.handles.phase === 'waiting'
          ? '↵ submit paste · c copy · esc cancel'
          : 'esc cancel';
    case 'opdevice':
      return 'c copy code · esc stop watching';
    case 'client':
      return pane.client.field === 'id' ? '↵ continue · esc back' : '↵ store · esc back';
    case 'receipt':
      return '↵ done';
  }
}

export function loginsFlowStatusOf(pane: LoginsFlowPaneV1): string {
  switch (pane.kind) {
    case 'anthropic':
      return anthropicFlowStatusOf(pane.snap);
    case 'pick':
      switch (pane.pick) {
        case 'openai':
          return 'OpenAI — subscription or key';
        case 'zai':
          return 'which Z.AI key is this?';
        case 'moonshot':
          return 'Kimi — sign in or paste a key';
        case 'huggingface':
          return 'Hugging Face — sign in or paste a token';
        case 'kimi-region':
          return 'which deployment holds your account?';
        case 'openrouter':
          return 'OpenRouter — three doors';
        case 'gemini':
          return 'Gemini — key, OAuth, or the client';
      }
      break;
    case 'key':
      return pane.storing ? 'checking the key' : `paste ${keyLegTitle(pane.leg)}`;
    case 'device':
      return pane.device.phase === 'finishing'
        ? 'authorized — settling the sign-in'
        : `waiting on the ${pane.device.family === 'moonshot' ? 'Kimi' : 'Hub'} device code`;
    case 'handles':
      return pane.handles.phase === 'exchanging'
        ? 'exchanging the authorization code'
        : pane.handles.leg === 'gemini-oauth'
          ? 'waiting on the Google sign-in'
          : pane.handles.leg === 'openai-browser'
            ? 'waiting on the OpenAI sign-in'
            : 'waiting on the OpenRouter sign-in';
    case 'opdevice':
      return 'waiting on the OpenAI device code';
    case 'client':
      return 'the one-time Google OAuth client';
    case 'receipt':
      return pane.ok ? 'connected — ↵ returns to the roster' : 'not connected — ↵ returns to the roster';
  }
}

export function loginsFlowPaneLines(pane: LoginsFlowPaneV1): string[] {
  switch (pane.kind) {
    case 'anthropic':
      return anthropicFlowPaneLines(pane.snap, pane.draftLen);
    case 'pick':
      return loginsPickPaneLines(pane.pick);
    case 'key':
      return keyPromptPaneLines(pane.leg, pane.note, pane.draftLen, pane.storing);
    case 'device':
      return deviceWaitPaneLines(pane.device, pane.nowMs);
    case 'handles':
      return handlesWaitPaneLines(pane.handles, pane.draftLen);
    case 'opdevice':
      return openaiDevicePaneLines(pane.opdevice);
    case 'client':
      return geminiClientPaneLines(pane.client, pane.draftLen, pane.draft);
    case 'receipt':
      return receiptPaneLines(pane.receipt, pane.ok);
  }
}

/** The screen's menuM (pure — the stills and the real mount compose the
 *  SAME model; a still can never drift from the screen's own composers). */
export function loginsMenuModelOf(
  facts: LoginsScreenFactsV1,
  opts: {
    selIdx: number;
    environment: { model: string; critter: string; critterHue: string; dirBase: string; dirTail: string };
    statusNote?: string | null;
    glowWord?: BootMenuData['glowWord'];
    /** The late-settle disclosure (E1): a connect that completed after the
     *  operator's cancel — the panel's first, loud row. */
    notice?: string | null;
    /** An open flow owns the panel, the legend and the status bar (the
     *  manager's action layering); a PICK swaps the entries for its option
     *  rows; every other flow keeps the roster composed beneath. */
    flow?: LoginsFlowPaneV1;
  },
): BootMenuData {
  const arms = loginsSortedArms(facts);
  const selected = opts.selIdx >= 0 ? arms[opts.selIdx] : undefined;
  const pick = opts.flow?.kind === 'pick' ? opts.flow : null;
  const flowPane =
    opts.flow !== undefined
      ? {
          detailOverride: loginsFlowPaneLines(opts.flow),
          legend: loginsFlowLegendOf(opts.flow),
          statusRight: loginsFlowStatusOf(opts.flow),
        }
      : null;
  return {
    title: 'logins',
    summaryTitle: 'LOGINS',
    summaryRows: loginsSummaryRows(facts, opts.notice ?? null),
    // The classic tier's half of the disclosure (the wide tier reads the
    // Notice summary row above; BOTH derive from this one opts.notice —
    // below 110 columns the summary panel never paints, and the late-settle
    // disclosure must be loud at EVERY size).
    noticeLine: opts.notice ?? null,
    environment: opts.environment,
    entries:
      pick !== null
        ? loginsPickOptions(pick.pick).map(option => ({
            label: option.label,
            group: 'pick',
            groupTitle:
              pick.pick === 'openai'
                ? 'OpenAI'
                : pick.pick === 'zai'
                  ? 'which key is this?'
                  : pick.pick === 'moonshot'
                    ? 'Kimi (Moonshot)'
                    : pick.pick === 'huggingface'
                      ? 'Hugging Face'
                      : pick.pick === 'openrouter'
                        ? 'OpenRouter'
                        : pick.pick === 'gemini'
                          ? 'Google Gemini'
                          : 'which deployment?',
            summary: '',
            valueLabel: '',
            valueIsDefault: true,
            pinnedVal: null,
            detail: null,
          }))
        : arms.map(a => loginsEntryOf(a, facts)),
    selIdx: pick !== null ? pick.pickSel : opts.selIdx,
    statusRight: opts.statusNote ?? loginsStatusLine(facts),
    legend: loginsLegendOf(selected !== undefined && loginsSwitchableFamily(selected, facts) !== null),
    moreHint: '… (the trail continues — a taller terminal shows it whole)',
    ...(selected !== undefined ? { detailOverride: loginsDetailLines(selected, facts) } : {}),
    ...(opts.glowWord !== undefined ? { glowWord: opts.glowWord } : {}),
    ...(flowPane ?? {}),
  };
}

interface BootLoginsScreenProps {
  onClose?: () => void;
  /** The persistent Boot scene contract: the screen owns the whole viewport
   *  on the shared flat ground, exactly like the sibling layers. */
  fullScene?: { columns: number; rows: number };
  /** Injected facts — a proof/still hands them; absent ⇒ the live owners,
   *  read once at mount. */
  facts?: LoginsScreenFactsV1;
}

export function BootLoginsScreen({ onClose, fullScene, facts: given }: BootLoginsScreenProps = {}): React.ReactNode {
  const t = useMercuryTokens();
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const columns = fullScene?.columns ?? termCols;
  const rows = fullScene?.rows ?? termRows;

  // THE FACTS — the one owners, read once at mount; a settled sign-in
  // RE-READS them (never an optimistic flip). An injected model runs no
  // live read, ever — its refresh is a no-op by law.
  const [facts, setFacts] = useState<LoginsScreenFactsV1>(() => given ?? collectLoginsScreenFacts());
  const arms = useMemo(() => loginsSortedArms(facts), [facts]);

  // THE OPEN FLOW: which sub-view owns the panel (null = the roster).
  type OpenFlowState =
    | { kind: 'anthropic' }
    | { kind: 'pick'; pick: LoginsPickId }
    | { kind: 'key'; leg: FaceKeyLegId; note: string | null; storing: boolean }
    | { kind: 'device'; device: DeviceWaitStateV1 }
    | { kind: 'handles'; handles: HandlesWaitStateV1 }
    | { kind: 'opdevice'; opdevice: OpenaiDeviceStateV1 }
    | { kind: 'client'; client: GeminiClientStateV1 }
    | { kind: 'receipt'; receipt: string; ok: boolean };
  const [flow, setFlow] = useState<OpenFlowState | null>(null);
  const flowRef = useRef(flow);
  flowRef.current = flow;
  // THE LATE-SETTLE NOTICE (E1, the disclose-not-unwind ruling): a connect
  // that completed AFTER the operator's cancel is never a dropped stale
  // settle — the panel's first row says so, the facts re-read, the chips
  // repaint. Cleared on the next flow open (the operator has seen it).
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // The device/handles runs' cancel/identity: bumping the run id abandons
  // the old run (a driver reads cancelled() true; a handles landing checks
  // the id before painting). The handles ref carries the live cancel +
  // paste-completion doors.
  const deviceRunRef = useRef(0);
  const handlesRef = useRef<{ cancel: (reason?: string) => void; completeWithRedirect: (pasted: string) => void } | null>(null);

  const refreshFacts = (): void => {
    if (given === undefined) setFacts(collectLoginsScreenFacts());
  };

  // THE POST-LOGIN SETTLE (A7): the runPostLoginRefresh parity subset
  // lawful OUTSIDE a chat — main.tsx's own post-walk set (managed
  // settings · policy limits · user cache · feature gates · the bypass
  // killswitch re-check where a store exists). No chat exists here, so
  // there are no messages to strip; auth-dependent hooks elsewhere in the
  // boot (a parked chat's MCP connections) re-read through the authVersion
  // bump, which rides the MAYBE setter — with no store there is nothing
  // to bump, and a later chat birth reads the fresh credentials from
  // their owners. Fires on SETTLED sign-ins only, fail-soft throughout;
  // injected-facts mounts (proofs) never run it.
  const setAppStateMaybe = useSetAppStateMaybe();
  const postLoginSettle = (): void => {
    if (given !== undefined) return;
    void (async () => {
      try {
        const [managed, limits, user, gates, killswitch] = await Promise.all([
          import('../services/remoteManagedSettings/index.js'),
          import('../services/policyLimits/index.js'),
          import('../utils/user.js'),
          import('../services/analytics/featureGates.js'),
          import('../utils/permissions/bypassPermissionsKillswitch.js'),
        ]);
        void managed.refreshRemoteManagedSettings().catch(() => {});
        void limits.refreshPolicyLimits().catch(() => {});
        // User data resets BEFORE the gate refresh so it picks up the
        // fresh credentials (the /logins command's own ordering).
        user.resetUserCache();
        await gates.refreshFeatureGates().catch(() => {});
        killswitch.resetBypassPermissionsCheck();
        if (setAppStateMaybe !== null) {
          // The bump captures the posture on the way through (the store's
          // updater runs synchronously); the killswitch re-check follows
          // with that captured posture — never a side effect inside the
          // updater itself.
          let capturedContext: Parameters<typeof killswitch.checkAndDisableBypassPermissionsIfNeeded>[0] | null = null;
          setAppStateMaybe(prev => {
            capturedContext = prev.toolPermissionContext;
            return { ...prev, authVersion: (prev.authVersion ?? 0) + 1 };
          });
          if (capturedContext !== null) {
            void killswitch.checkAndDisableBypassPermissionsIfNeeded(capturedContext, setAppStateMaybe).catch(() => {});
          }
        }
      } catch {
        /* fail-soft: the roster already re-read the owners */
      }
    })();
  };
  const closeFlow = (): void => {
    deviceRunRef.current += 1; // any live device/handles run is abandoned
    handlesRef.current?.cancel('cancelled from the logins layer');
    handlesRef.current = null;
    setFlow(null);
    setDraft('');
  };

  // E1's full round for a connect that completed AFTER the cancel: the
  // loud panel row, the roster re-read, and the SAME post-login settle a
  // live sign-in earns (authVersion/chip bump; a landed credential is a
  // landed credential, however it arrived).
  const discloseLateSettle = (sentence: string): void => {
    setNotice(sentence);
    refreshFacts();
    postLoginSettle();
  };

  // THE DEVICE RUNS (A6a): the RFC 8628 families over their DRIVERS —
  // the driver owns start/poll/prove/store/receipt; this glue maps events
  // onto the wait pane, opens the browser on the FIRST waiting event (the
  // skin's move, the landed law), and lands the outcome as a receipt pane.
  // Esc bumps the run id: the driver sees cancelled() and its late landing
  // is ignored (nothing stored — the driver's own cancel law).
  const startDeviceRun = (family: FaceDeviceFamily, region?: KimiRegion): void => {
    const run = (deviceRunRef.current += 1);
    const live = (): boolean => run === deviceRunRef.current;
    const regionWords = family === 'moonshot' ? (region === 'mainland-cn' ? 'Mainland China — kimi.com' : 'Global — kimi.ai') : undefined;
    const seed: DeviceWaitStateV1 = {
      family,
      ...(regionWords !== undefined ? { regionWords } : {}),
      phase: 'starting',
      polls: 0,
      copied: false,
    };
    setFlow({ kind: 'device', device: seed });
    const patchDevice = (over: Partial<DeviceWaitStateV1>): void => {
      if (!live()) return;
      setFlow(current => (current?.kind === 'device' ? { kind: 'device', device: { ...current.device, ...over } } : current));
    };
    const onEvent = (event: {
      phase: 'starting' | 'waiting' | 'finishing';
      start?: { userCode: string; verificationUri: string; verificationUriComplete?: string; expiresAtMs: number };
      polls?: number;
      note?: string;
    }): void => {
      if (!live()) return;
      if (event.phase === 'starting') {
        patchDevice({ phase: 'starting' });
        return;
      }
      if (event.phase === 'finishing') {
        patchDevice({ phase: 'finishing' });
        return;
      }
      const uri = event.start !== undefined ? (event.start.verificationUriComplete ?? event.start.verificationUri) : undefined;
      patchDevice({
        phase: 'waiting',
        ...(event.start !== undefined
          ? { userCode: event.start.userCode, verificationUri: uri, expiresAtMs: event.start.expiresAtMs }
          : {}),
        polls: event.polls ?? 0,
        ...(event.note !== undefined ? { note: event.note } : { note: undefined }),
      });
      if (event.polls === 0 && uri !== undefined) void openBrowser(uri);
    };
    const land = (outcome: { ok: boolean; receipt: string }): void => {
      if (!live()) return;
      setDraft('');
      setFlow({ kind: 'receipt', receipt: outcome.receipt, ok: outcome.ok });
    };
    // A driver outcome carrying settledAfterCancel is NEVER a droppable
    // stale settle: the approval landed while the flow was closing and the
    // store holds it — disclose loudly with the driver's own sentence.
    const landOrDisclose = (outcome: { ok: boolean; receipt: string; settledAfterCancel?: true }): void => {
      if (outcome.settledAfterCancel === true) {
        discloseLateSettle(outcome.receipt);
        return;
      }
      land(outcome);
    };
    if (family === 'moonshot') {
      void runKimiDeviceLogin({ region: region ?? 'global', cancelled: () => !live(), onEvent }).then(landOrDisclose);
    } else {
      void runHuggingfaceDeviceLogin({ cancelled: () => !live(), onEvent }).then(landOrDisclose);
    }
  };

  // THE HANDLES RUNS (A6b): the loopback/PKCE families over their connect
  // HANDLES — the accounts machinery owns listener/exchange; this glue
  // paints the wait, forwards the paste, and settles through the family's
  // ONE login door (finish/fail receipts — never a re-spelled sentence).
  const startHandlesRun = (leg: HandlesLegId): void => {
    const run = (deviceRunRef.current += 1);
    const live = (): boolean => run === deviceRunRef.current;
    const onListenerIssue = (message: string): void => {
      if (!live()) return;
      setFlow(f => (f?.kind === 'handles' ? { kind: 'handles', handles: { ...f.handles, listenerNote: message } } : f));
    };
    // The abandon disclosure (E1): an exchange that completes after this
    // run's cancel stores server-truth — the layer says so loudly instead
    // of dropping the landing with the stale run.
    const legFamily = leg === 'openai-browser' ? 'openai' : leg === 'gemini-oauth' ? 'gemini' : 'openrouter';
    const onSettledAfterCancel = (): void => discloseLateSettle(lateSettleNotice(legFamily));
    const handles =
      leg === 'openai-browser'
        ? beginOpenaiBrowserConnect({ onListenerIssue, onSettledAfterCancel })
        : leg === 'gemini-oauth'
          ? beginGeminiBrowserConnect({ onListenerIssue, onSettledAfterCancel })
          : beginOpenrouterConnect({ mode: leg === 'openrouter-browser' ? 'browser' : 'headless', onListenerIssue, onSettledAfterCancel });
    handlesRef.current = { cancel: reason => handles.cancel(reason), completeWithRedirect: pasted => handles.completeWithRedirect(pasted) };
    setFlow({
      kind: 'handles',
      handles: { leg, phase: 'waiting', ...(handles.authorizeUrl ? { authorizeUrl: handles.authorizeUrl } : {}), copied: false },
    });
    const land = (outcome: { ok: boolean; receipt: string }): void => {
      if (!live()) return;
      handlesRef.current = null;
      setDraft('');
      setFlow({ kind: 'receipt', receipt: outcome.receipt, ok: outcome.ok });
    };
    if (leg === 'openai-browser') {
      (handles.result as Promise<Parameters<typeof finishOpenaiSubscriptionConnect>[0]>)
        .then(async ref => land(await finishOpenaiSubscriptionConnect(ref)))
        .catch(error => land({ ok: false, receipt: openaiConnectFailedReceipt(error, 'browser') }));
    } else if (leg === 'gemini-oauth') {
      (handles.result as Promise<unknown>)
        .then(async () => land(await finishGeminiOauthConnect()))
        .catch(error => land({ ok: false, receipt: geminiConnectFailedReceipt(error) }));
    } else {
      (handles.result as Promise<Parameters<typeof finishOpenrouterConnect>[0]>)
        .then(async ref => land(await finishOpenrouterConnect(ref)))
        .catch(error => land({ ok: false, receipt: openrouterConnectFailedReceipt(error) }));
    }
  };

  // The OpenAI device leg (the landed d-switch's destination): esc is the
  // honest STOP-WATCHING — the background poll still lands an approved
  // code (the receipt says so); no cancel handle exists by design.
  const startOpenaiDeviceRun = (): void => {
    const run = (deviceRunRef.current += 1);
    const live = (): boolean => run === deviceRunRef.current;
    setFlow({ kind: 'opdevice', opdevice: { copied: false } });
    beginOpenaiDeviceConnect()
      .then(start => {
        if (!live()) return;
        setFlow(f => (f?.kind === 'opdevice' ? { kind: 'opdevice', opdevice: { ...f.opdevice, userCode: start.userCode, verifyHint: start.verifyHint } } : f));
        start.result
          .then(async ref => {
            if (!live()) {
              // The landed stop-watching design: the poll has no cancel and
              // an approved code still lands — E1 makes the landing LOUD
              // (the receipt only pre-warned; this is the completion).
              void ref;
              discloseLateSettle(lateSettleNotice('openai'));
              return;
            }
            setDraft('');
            setFlow({ kind: 'receipt', ...(await finishOpenaiSubscriptionConnect(ref)) });
          })
          .catch(error => {
            if (!live()) return;
            setFlow({ kind: 'receipt', receipt: openaiConnectFailedReceipt(error, 'device'), ok: false });
          });
      })
      .catch(error => {
        if (!live()) return;
        setFlow({ kind: 'receipt', receipt: openaiConnectFailedReceipt(error, 'device'), ok: false });
      });
  };

  // THE ANTHROPIC MACHINE (the /logins card's own, A1): one machine for
  // the layer's life; reset() before each open so an abandoned flow's late
  // settle writes nothing (the generation law). No notify channel — this
  // layer paints its own refresh and mounts outside the AppState provider.
  const model = useAnthropicLoginModel({
    onDone: () => {
      // The setup-token arm's auto-finish never runs here (mode 'login');
      // done means the success pane settled — close, re-read, settle.
      refreshFacts();
      postLoginSettle();
      closeFlow();
    },
  });
  // Opening a pick resets its cursor (a stale index from the previous pick
  // must not carry over); the region question seeds the REMEMBERED region.
  const openPick = (pick: LoginsPickId, cursor = 0): void => {
    setFlow({ kind: 'pick', pick });
    pickList.moveTo(cursor);
  };

  const openFlow = (arm: LoginsArmV1): void => {
    setDraft('');
    setNotice(null); // the operator moved on — the late-settle notice was seen
    switch (arm.row.value) {
      case 'claudeai':
        setFlow({ kind: 'anthropic' });
        model.reset();
        model.start(true);
        return;
      case 'console':
        // Purely Anthropic (OS-AUTH-1's split): straight to the machine's
        // console arm — no interposed provider choice exists any more.
        setFlow({ kind: 'anthropic' });
        model.reset();
        model.start(false);
        return;
      case 'zai':
        openPick('zai');
        return;
      case 'deepseek':
        setFlow({ kind: 'key', leg: 'deepseek', note: null, storing: false });
        return;
      case 'moonshot':
        openPick('moonshot');
        return;
      case 'huggingface':
        openPick('huggingface');
        return;
      case 'openai':
        // OS-AUTH-1: the row is two-credential now (the key moved home from
        // the console door), so the pick is REAL — the old 'no invented
        // pick' law retired WITH its reason (the row was subscription-only;
        // it no longer is). The d-switch lives on within the subscription
        // arm's wait.
        openPick('openai');
        return;
      case 'openrouter':
        openPick('openrouter');
        return;
      case 'gemini':
        openPick('gemini');
        return;
    }
  };

  // A pick's landing: the OpenAI family's two arms; the Z.AI plan answer;
  // the Kimi/Hub choices (device via the region question, or a key/token).
  const resolvePick = (pick: LoginsPickId, value: string): void => {
    setDraft('');
    switch (pick) {
      case 'openai':
        if (value === 'key') {
          setFlow({ kind: 'key', leg: 'openai-key', note: null, storing: false });
          return;
        }
        startHandlesRun('openai-browser');
        return;
      case 'zai':
        setFlow({ kind: 'key', leg: value === 'coding' ? 'zai-coding' : 'zai-general', note: null, storing: false });
        return;
      case 'moonshot':
        if (value === 'key') {
          setFlow({ kind: 'key', leg: 'moonshot-key', note: null, storing: false });
          return;
        }
        openPick('kimi-region', moonshotStoredRegion() === 'mainland-cn' ? 1 : 0);
        return;
      case 'huggingface':
        if (value === 'token') {
          setFlow({ kind: 'key', leg: 'hf-token', note: null, storing: false });
          return;
        }
        startDeviceRun('huggingface');
        return;
      case 'kimi-region':
        startDeviceRun('moonshot', value === 'mainland-cn' ? 'mainland-cn' : 'global');
        return;
      case 'openrouter':
        if (value === 'key') {
          setFlow({ kind: 'key', leg: 'openrouter-key', note: null, storing: false });
          return;
        }
        startHandlesRun(value === 'browser' ? 'openrouter-browser' : 'openrouter-headless');
        return;
      case 'gemini':
        if (value === 'key') {
          setFlow({ kind: 'key', leg: 'gemini-key', note: null, storing: false });
          return;
        }
        if (value === 'client' || Boolean(geminiOauthClientMissingCopy())) {
          // The landed redirect: choosing OAuth with no client set lands
          // the client prompt first. The update flow starts from the
          // STORED id, visible and editable.
          const storedId = geminiOauthClientConfig()?.clientId ?? '';
          setDraft(storedId);
          setFlow({ kind: 'client', client: { field: 'id', clientId: storedId, note: null } });
          return;
        }
        startHandlesRun('gemini-oauth');
        return;
    }
  };

  // The key legs' submit: the ONE guard spelling, then the family's own
  // DRIVER — the receipt pane speaks the driver's sentence verbatim; a
  // not-stored answer corrects at the prompt (the landed legs' posture).
  const submitKey = (leg: FaceKeyLegId, raw: string): void => {
    const value = raw.trim();
    if (!value) return;
    const guard = keyPasteGuardNote(value, keyLegGuardOpts(leg));
    if (guard !== null) {
      setFlow({ kind: 'key', leg, note: guard, storing: false });
      return;
    }
    setFlow({ kind: 'key', leg, note: null, storing: true });
    const settle = (outcome: { ok: boolean; stored: boolean; receipt: string }): void => {
      if (flowRef.current?.kind !== 'key') return; // esc'd meanwhile — nothing to paint
      if (!outcome.stored) {
        setFlow({ kind: 'key', leg, note: outcome.receipt, storing: false });
        return;
      }
      setDraft('');
      setFlow({ kind: 'receipt', receipt: outcome.receipt, ok: outcome.ok });
    };
    if (leg === 'openai-key') void storeOpenaiApiKeyLogin(value).then(settle);
    else if (leg === 'deepseek') void storeDeepseekApiKeyLogin(value).then(settle);
    else if (leg === 'moonshot-key')
      void storeMoonshotApiKeyLogin(value).then(outcome => settle({ ok: outcome.ok, stored: outcome.stored, receipt: outcome.receipt }));
    else if (leg === 'hf-token') void storeHuggingfaceTokenLogin(value).then(settle);
    else if (leg === 'openrouter-key') void storeOpenrouterApiKeyLogin(value).then(settle);
    else if (leg === 'gemini-key') void storeGeminiApiKeyLogin(value).then(settle);
    else settle(storeZaiApiKeyLogin(value, leg === 'zai-coding' ? 'coding' : 'general'));
  };

  // esc from a key prompt: back where the leg came from (the landed legs'
  // own back edges — the OpenAI key backs to its family's pick; a Z.AI key
  // backs to the plan question; the Kimi key and the Hub token back to
  // their family's choice; DeepSeek backs to the roster).
  const keyEscape = (leg: FaceKeyLegId): void => {
    setDraft('');
    if (leg === 'openai-key') openPick('openai');
    else if (leg === 'zai-general' || leg === 'zai-coding') openPick('zai');
    else if (leg === 'moonshot-key') openPick('moonshot');
    else if (leg === 'hf-token') openPick('huggingface');
    else if (leg === 'openrouter-key') openPick('openrouter');
    else if (leg === 'gemini-key') openPick('gemini');
    else closeFlow();
  };

  // The most recent sign-in's row (the default provider) opens focused (the
  // row owner's own focus law — the same map /logins' opening menu rides).
  const recordedFocus = loginFamilyFocusFor(mostRecentSignInFamily());

  const list = useInteractiveList<LoginsArmV1>({
    rows: arms,
    rowId: a => `logins:${a.row.value}`,
    idNamespace: 'boot-logins',
    ...(recordedFocus !== undefined ? { initialId: `logins:${recordedFocus}` } : {}),
    // The open flow owns input; the roster parks beneath it with the
    // selection intact (the sibling layers' own layering law).
    active: flow === null,
    onClose: () => onClose?.(),
    actions: [
      {
        key: 'return',
        hint: 'sign in',
        // ↵ exactly where a flow is BUILT (widened commit by commit) — a
        // row without its flow keeps a truthful chip and no dead key.
        when: a => loginsFlowReady(a.row.value),
        run: a => {
          if (a !== null && loginsFlowReady(a.row.value)) openFlow(a);
          return null;
        },
      },
      {
        key: 's',
        hint: 'switch active slot',
        // `s` exactly where the family's two-slot pair is signed in (the
        // legend advertises it under the same predicate). The switch runs
        // through the ONE owner; the receipt words ride the status note and
        // the roster re-reads so the active chips repaint the new seat.
        when: a => given === undefined && loginsSwitchableFamily(a, facts) !== null,
        run: a => {
          if (a === null || given !== undefined) return null;
          const family = loginsSwitchableFamily(a, facts);
          if (family === null) return null;
          const { switchActiveSlot } =
            require('../services/providers/slotSwitch.js') as typeof import('../services/providers/slotSwitch.js');
          const outcome = switchActiveSlot(family);
          refreshFacts();
          return outcome.receipt;
        },
      },
    ],
  });

  // THE PICK LIST (the manager's pick layering): a sub-choice swaps the
  // entries; ↵ resolves; esc returns to the roster with nothing opened.
  const pickOptions = flow?.kind === 'pick' ? loginsPickOptions(flow.pick) : [];
  const pickList = useInteractiveList<{ label: string; value: string }>({
    rows: pickOptions,
    rowId: r => `logins-pick:${r.value}`,
    idNamespace: 'boot-logins-pick',
    active: flow?.kind === 'pick',
    // The region question backs one step (to the Kimi choice — its own
    // entry); every first-tier pick backs to the roster.
    onClose: () => {
      if (flowRef.current?.kind === 'pick' && flowRef.current.pick === 'kimi-region') {
        openPick('moonshot');
        return;
      }
      closeFlow();
    },
    actions: [
      {
        key: 'return',
        hint: 'pick',
        run: r => {
          const current = flowRef.current;
          if (r !== null && current?.kind === 'pick') resolvePick(current.pick, r.value);
          return null;
        },
      },
    ],
  });

  // THE FLOW'S KEYS (active while a NON-PICK flow is open — the pick list
  // owns its own; consumed here so no owner beneath sees them — the esc
  // chain: prompt → its pick or the roster → the face). Esc semantics per
  // state are the in-chat cards' own: a success/receipt pane settles DONE
  // (never "interrupted"); every other state abandons with nothing stored.
  useInput(
    (input, key, event) => {
      event.stopImmediatePropagation();
      const current = flowRef.current;
      if (current === null) return;
      if (current.kind === 'receipt') {
        if (key.return || key.escape) {
          refreshFacts();
          if (current.ok) postLoginSettle();
          closeFlow();
        }
        return;
      }
      if (current.kind === 'device') {
        // Esc abandons the wait lawfully: the run id bumps, the driver
        // reads cancelled() and settles silently, nothing is stored; the
        // family's own choice returns (never stranded, never the roster
        // lost). 'c' copies the verification URL while waiting.
        if (key.escape) {
          deviceRunRef.current += 1;
          setDraft('');
          openPick(current.device.family);
          return;
        }
        if (
          input === 'c' &&
          !key.ctrl &&
          !key.meta &&
          current.device.phase === 'waiting' &&
          current.device.verificationUri !== undefined
        ) {
          const run = deviceRunRef.current;
          void setClipboard(current.device.verificationUri).then(sequence => {
            if (sequence) process.stdout.write(sequence);
            if (run !== deviceRunRef.current) return;
            setFlow(f => (f?.kind === 'device' ? { kind: 'device', device: { ...f.device, copied: true } } : f));
            setTimeout(() => {
              if (run !== deviceRunRef.current) return;
              setFlow(f => (f?.kind === 'device' ? { kind: 'device', device: { ...f.device, copied: false } } : f));
            }, 2000);
          });
        }
        return;
      }
      if (current.kind === 'handles') {
        const h = current.handles;
        if (key.escape) {
          // Cancel through the handles (the listener closes; the result
          // rejects into the abandoned run) and back where the leg came
          // from. Pre-fire, nothing stores; an exchange already completing
          // lands DISCLOSED through onSettledAfterCancel (the notice row +
          // facts re-read), never silently.
          deviceRunRef.current += 1;
          handlesRef.current?.cancel('cancelled from the logins layer');
          handlesRef.current = null;
          setDraft('');
          if (h.leg === 'openai-browser') closeFlow();
          else if (h.leg === 'gemini-oauth') openPick('gemini');
          else openPick('openrouter');
          return;
        }
        if (key.return) {
          const value = draftRef.current.trim();
          if (value === '' || h.phase !== 'waiting') return;
          setDraft('');
          setFlow(f => (f?.kind === 'handles' ? { kind: 'handles', handles: { ...f.handles, phase: 'exchanging' } } : f));
          handlesRef.current?.completeWithRedirect(value);
          return;
        }
        if (input === 'c' && !key.ctrl && !key.meta && h.phase === 'waiting' && draftRef.current === '' && h.authorizeUrl !== undefined) {
          const run = deviceRunRef.current;
          void setClipboard(h.authorizeUrl).then(sequence => {
            if (sequence) process.stdout.write(sequence);
            if (run !== deviceRunRef.current) return;
            setFlow(f => (f?.kind === 'handles' ? { kind: 'handles', handles: { ...f.handles, copied: true } } : f));
            setTimeout(() => {
              if (run !== deviceRunRef.current) return;
              setFlow(f => (f?.kind === 'handles' ? { kind: 'handles', handles: { ...f.handles, copied: false } } : f));
            }, 2000);
          });
          return;
        }
        if (input === 'd' && !key.ctrl && !key.meta && h.leg === 'openai-browser' && h.phase === 'waiting' && draftRef.current === '') {
          // The landed d-switch: cancel the browser flow (its rejection
          // lands in the abandoned run) and remount as the device leg.
          handlesRef.current?.cancel('switching to the device-code flow');
          handlesRef.current = null;
          setDraft('');
          startOpenaiDeviceRun();
          return;
        }
        if (h.phase !== 'waiting') return;
        if (key.backspace || key.delete) {
          setDraft(d => d.slice(0, -1));
          return;
        }
        if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
        // eslint-disable-next-line no-control-regex
        if (input.length > 0 && !/[\x00-\x1f\x7f]/.test(input)) setDraft(d => d + input);
        return;
      }
      if (current.kind === 'opdevice') {
        if (key.escape) {
          // The honest stop-watching: no cancel handle exists BY DESIGN —
          // an approved code still lands in the background, and the
          // receipt says exactly that.
          deviceRunRef.current += 1;
          setDraft('');
          setFlow({ kind: 'receipt', receipt: OPENAI_DEVICE_STOPPED_RECEIPT, ok: false });
          return;
        }
        if (input === 'c' && !key.ctrl && !key.meta && current.opdevice.userCode !== undefined) {
          const run = deviceRunRef.current;
          void setClipboard(current.opdevice.userCode).then(sequence => {
            if (sequence) process.stdout.write(sequence);
            if (run !== deviceRunRef.current) return;
            setFlow(f => (f?.kind === 'opdevice' ? { kind: 'opdevice', opdevice: { ...f.opdevice, copied: true } } : f));
            setTimeout(() => {
              if (run !== deviceRunRef.current) return;
              setFlow(f => (f?.kind === 'opdevice' ? { kind: 'opdevice', opdevice: { ...f.opdevice, copied: false } } : f));
            }, 2000);
          });
        }
        return;
      }
      if (current.kind === 'client') {
        const c = current.client;
        if (key.escape) {
          if (c.field === 'secret') {
            // One esc = one layer: back to the id field, id preserved.
            setDraft(c.clientId);
            setFlow({ kind: 'client', client: { field: 'id', clientId: c.clientId, note: null } });
            return;
          }
          setDraft('');
          openPick('gemini');
          return;
        }
        if (key.return) {
          if (c.field === 'id') {
            const value = draftRef.current.trim();
            if (!value) {
              setFlow({ kind: 'client', client: { ...c, note: 'The client id is required (the secret is optional for Desktop clients).' } });
              return;
            }
            setDraft('');
            setFlow({ kind: 'client', client: { field: 'secret', clientId: value, note: null } });
            return;
          }
          try {
            writeGeminiOauthClientConfig({
              clientId: c.clientId,
              ...(draftRef.current.trim() ? { clientSecret: draftRef.current.trim() } : {}),
            });
          } catch (error) {
            setFlow({ kind: 'client', client: { ...c, note: `Could not store the client config: ${String((error as Error).message ?? error)}` } });
            return;
          }
          setDraft('');
          openPick('gemini');
          return;
        }
        if (key.backspace || key.delete) {
          setDraft(d => d.slice(0, -1));
          return;
        }
        if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
        // eslint-disable-next-line no-control-regex
        if (input.length > 0 && !/[\x00-\x1f\x7f]/.test(input)) setDraft(d => d + input);
        return;
      }
      if (current.kind === 'key') {
        if (key.escape) {
          if (!current.storing) keyEscape(current.leg);
          return;
        }
        if (key.return) {
          if (!current.storing) submitKey(current.leg, draftRef.current);
          return;
        }
        if (current.storing) return;
        if (key.backspace || key.delete) {
          setDraft(d => d.slice(0, -1));
          return;
        }
        if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
        // eslint-disable-next-line no-control-regex
        if (input.length > 0 && !/[\x00-\x1f\x7f]/.test(input)) setDraft(d => d + input);
        return;
      }
      // current.kind === 'anthropic' — the machine's own screens.
      const snap = model.flow;
      if (key.escape) {
        if (snap.name === 'success') {
          refreshFacts();
          postLoginSettle();
        } else {
          model.reset();
        }
        closeFlow();
        return;
      }
      if (key.return) {
        if (snap.name === 'success') {
          refreshFacts();
          postLoginSettle();
          closeFlow();
          return;
        }
        if (snap.name === 'error') {
          setDraft('');
          model.retry();
          return;
        }
        if (snap.name === 'waiting' && model.pastePromptUp) {
          if (!model.submitCode(draftRef.current)) setDraft('');
          return;
        }
        return;
      }
      if (input === 'c' && !key.ctrl && !key.meta && snap.name === 'waiting' && model.pastePromptUp && draftRef.current === '') {
        model.copyUrl();
        return;
      }
      if (key.backspace || key.delete) {
        setDraft(d => d.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      // eslint-disable-next-line no-control-regex
      if (snap.name === 'waiting' && model.pastePromptUp && input.length > 0 && !/[\x00-\x1f\x7f]/.test(input)) {
        setDraft(d => d + input);
      }
    },
    { isActive: flow !== null && flow.kind !== 'pick' },
  );

  // ← is the advertised close synonym on vertical face lists (the sibling
  // layers' own grammar; the vertical list decodes no horizontal motion).
  // Parked while a flow is open — the flow's own keys own the screen.
  useInput(
    (_input, key, event) => {
      if (!key.leftArrow) return;
      event.stopImmediatePropagation();
      onClose?.();
    },
    { isActive: flow === null },
  );

  // ── the ratified composition (the ONE shared design) ─────────────────────
  const { accent: coreAccent, rampStops } = useSplashCoreAccent();
  const core = useMemo(
    () => createSplashCore({ nocolor: false, truecolor: true, accent: coreAccent }),
    [coreAccent],
  );
  const wordGlow = useGreetingShimmer(rampStops, WORD_W);
  const mainModel = useMainLoopModel();

  const menuM = useMemo(() => {
    const critterKey = getSessionCritterKey();
    return loginsMenuModelOf(facts, {
      selIdx: list.selectedIndex,
      environment: {
        model: renderModelChip(mainModel),
        critter: critterKey.charAt(0).toUpperCase() + critterKey.slice(1),
        critterHue: getSessionAccent().accent,
        dirBase: basename(process.cwd()) || process.cwd(),
        dirTail: '',
      },
      statusNote: list.note,
      glowWord: wordGlow,
      notice,
      ...(flow !== null
        ? {
            flow:
              flow.kind === 'anthropic'
                ? {
                    kind: 'anthropic' as const,
                    snap: {
                      flow: model.flow,
                      pastePromptUp: model.pastePromptUp,
                      copied: model.copied,
                      shadowWarning: model.shadowWarning,
                      accountLabel: model.accountLabel,
                    },
                    draftLen: draft.length,
                  }
                : flow.kind === 'pick'
                  ? { kind: 'pick' as const, pick: flow.pick, pickSel: pickList.selectedIndex }
                  : flow.kind === 'key'
                    ? { kind: 'key' as const, leg: flow.leg, note: flow.note, draftLen: draft.length, storing: flow.storing }
                    : flow.kind === 'device'
                      ? { kind: 'device' as const, device: flow.device, nowMs: Date.now() }
                      : flow.kind === 'handles'
                        ? { kind: 'handles' as const, handles: flow.handles, draftLen: draft.length }
                        : flow.kind === 'opdevice'
                          ? { kind: 'opdevice' as const, opdevice: flow.opdevice }
                          : flow.kind === 'client'
                            ? { kind: 'client' as const, client: flow.client, draftLen: draft.length, draft }
                            : { kind: 'receipt' as const, receipt: flow.receipt, ok: flow.ok },
          }
        : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facts, list.selectedIndex, list.note, mainModel, flow, pickList.selectedIndex, model.flow, model.pastePromptUp, model.copied, model.shadowWarning, model.accountLabel, draft, wordGlow?.peakCell, wordGlow?.gainLevel]);

  const composition = useMemo(() => {
    const menu = core.composeBootMenu(columns, rows, menuM) as {
      lines: string[];
      entryLines: Array<{ entry: number; line: number }>;
    };
    const { placed, top } = core.placeBlock(menu.lines, rows) as { placed: string[]; top: number };
    return {
      placed,
      entryAt: new Map<number, number>(menu.entryLines.map(e => [e.line + top, e.entry])),
    };
  }, [core, columns, rows, menuM]);

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {Array.from({ length: rows }, (_, i) => {
        const line = composition.placed[i] ?? '';
        const entryIdx = composition.entryAt.get(i);
        // Pointer parity rides whichever list owns the composed entries:
        // the roster's arms, or an open pick's option rows. Every other
        // flow parks all targets (a click must not swap rows under it).
        const target =
          entryIdx === undefined
            ? null
            : flow === null && arms[entryIdx] !== undefined
              ? { props: list.rowProps(arms[entryIdx]!, entryIdx), hoverLabel: arms[entryIdx]!.row.label }
              : flow?.kind === 'pick' && pickOptions[entryIdx] !== undefined
                ? { props: pickList.rowProps(pickOptions[entryIdx]!, entryIdx), hoverLabel: pickOptions[entryIdx]!.label }
                : null;
        if (target !== null) {
          const { props, hoverLabel } = target;
          return (
            <InteractiveRow
              key={props.id}
              id={props.id}
              selected={props.selected}
              unavailable={props.unavailable}
              onSelect={props.onSelect}
              onActivate={props.onActivate}
              selectionBand={false}
              hoverStyle="chrome-ink"
              height={1}
            >
              {hover =>
                renderSceneLine(line, hover && !props.selected ? { label: hoverLabel, color: t.info } : undefined)
              }
            </InteractiveRow>
          );
        }
        return (
          <Box key={`loginsline-${i}`} height={1} flexShrink={0}>
            {line.length > 0 ? renderSceneLine(line) : null}
          </Box>
        );
      })}
    </Box>
  );
}
