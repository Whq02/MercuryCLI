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


const DETAIL_W = 38;
const CHIP_W = 26;

export interface LoginsScreenFactsV1 {
  groups: FamilySlotGroup[];
  usability: Record<ProviderId, ProviderUsability>;
  defaultFamily?: string;
}

export function collectLoginsScreenFacts(): LoginsScreenFactsV1 {
  const defaultFamily = mostRecentSignInFamily();
  return {
    groups: deriveFamilySlotGroups(),
    usability: resolveProviderUsability(),
    ...(defaultFamily !== undefined ? { defaultFamily } : {}),
  };
}

export interface LoginsArmV1 {
  row: LoginFamilyRow;
  familyId: ProviderId;
  arm: 'subscription' | 'key' | 'family';
}

export function loginsCatalogue(): LoginsArmV1[] {
  return loginFamilyRows({ engineLegs: true }).map(row => ({
    row,
    familyId: row.value === 'claudeai' || row.value === 'console' ? 'anthropic' : (row.value as ProviderId),
    arm: row.value === 'claudeai' ? 'subscription' : row.value === 'console' ? 'key' : 'family',
  }));
}

export function loginsArmSlots(arm: LoginsArmV1, group: FamilySlotGroup | undefined): AccountSlot[] {
  const slots = group?.slots ?? [];
  if (arm.arm === 'subscription') return slots.filter(s => s.kind !== 'api-key');
  if (arm.arm === 'key') return slots.filter(s => s.kind === 'api-key');
  return slots;
}

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
  chip: string;
  loud: boolean;
  signedIn: boolean;
}

export function loginsRowStateOf(arm: LoginsArmV1, facts: LoginsScreenFactsV1): LoginsRowStateV1 {
  const group = facts.groups.find(g => g.family.id === arm.familyId);
  if (group === undefined) {
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

export function loginsSortedArms(facts: LoginsScreenFactsV1): LoginsArmV1[] {
  const arms = loginsCatalogue();
  return [
    ...arms.filter(a => loginsRowStateOf(a, facts).signedIn),
    ...arms.filter(a => !loginsRowStateOf(a, facts).signedIn),
  ];
}

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

export function lateSettleNotice(familyId: string): string {
  return `${familyDisplayName(familyId)} sign-in completed after cancel — the approval landed while the flow was closing, so the account IS signed in. ⌫ on its row (or /accounts) signs it out.`;
}

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

export function loginsStatusLine(facts: LoginsScreenFactsV1): string {
  const familyIds = [...new Set(loginsCatalogue().map(a => a.familyId))];
  const signed = familyIds.filter(id => (facts.groups.find(g => g.family.id === id)?.slots ?? []).some(s => s.signedIn)).length;
  const ready = familyIds.filter(id => facts.usability[id]?.usable === true).length;
  return signed === 0
    ? `no family signed in yet · ${ready} ready without one`
    : `${signed} of ${familyIds.length} families signed in · ${ready} ready`;
}

export function loginsFlowReady(_value: LoginFamilyRow['value']): boolean {
  return true;
}

export function loginsLegendOf(switchable = false): string {
  return switchable ? '↑↓ move · ↵ sign in · s switch slot · esc back' : '↑↓ move · ↵ sign in · esc back';
}


const DRAFT_DOTS_MAX = 24;

export function maskedDraftLine(draftLen: number): string {
  return `code: ${'•'.repeat(Math.min(draftLen, DRAFT_DOTS_MAX))}${draftLen > DRAFT_DOTS_MAX ? '…' : ''}▌`;
}

export function wrapHard(text: string, width: number): string[] {
  const lines: string[] = [];
  for (let at = 0; at < text.length; at += width) lines.push(text.slice(at, at + width));
  return lines.length > 0 ? lines : [''];
}

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

export function anthropicFlowLegendOf(snap: AnthropicLoginSnapshot, draftLen: number): string {
  const flow = snap.flow;
  if (flow.name === 'waiting' && snap.pastePromptUp) {
    return draftLen > 0 ? '↵ submit code · esc cancel' : '↵ submit code · c copy url · esc cancel';
  }
  if (flow.name === 'success') return '↵ done';
  if (flow.name === 'error' && flow.retry !== undefined) return '↵ retry · esc close';
  return 'esc cancel';
}

export function anthropicFlowStatusOf(snap: AnthropicLoginSnapshot): string {
  const flow = snap.flow;
  if (flow.name === 'waiting') return 'waiting on the browser sign-in';
  if (flow.name === 'creating-key') return 'minting the usage-based key';
  if (flow.name === 'success') return 'signed in — ↵ returns to the roster';
  if (flow.name === 'error') return 'the sign-in did not settle';
  return 'starting the sign-in';
}


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

const RECEIPT_PANE_MAX = 9;
export function receiptPaneLines(receipt: string, _ok: boolean): string[] {
  const wrapped = wrapPlain(receipt, DETAIL_W);
  const body =
    wrapped.length > RECEIPT_PANE_MAX ? [...wrapped.slice(0, RECEIPT_PANE_MAX - 1), '…'] : wrapped;
  return [...body, '↵ done — the roster refreshes'];
}


export type FaceDeviceFamily = 'moonshot' | 'huggingface';

export interface DeviceWaitStateV1 {
  family: FaceDeviceFamily;
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


export type HandlesLegId = 'openai-browser' | 'openrouter-browser' | 'openrouter-headless' | 'gemini-oauth';

export interface HandlesWaitStateV1 {
  leg: HandlesLegId;
  phase: 'waiting' | 'exchanging';
  authorizeUrl?: string;
  listenerNote?: string;
  copied: boolean;
}

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
  lines.push(handlesWaitWayOut(h, draftLen));
  return lines;
}

export function handlesWaitWayOut(h: HandlesWaitStateV1, draftLen: number): string {
  if (h.copied) return 'copied to clipboard';
  const copy = draftLen === 0 && h.authorizeUrl !== undefined;
  const device = draftLen === 0 && h.leg === 'openai-browser';
  if (copy && device) return 'c copy · d device · esc cancel';
  if (copy) return 'c copy url · esc cancel';
  if (device) return 'd device · esc cancel';
  return 'esc cancel';
}

export interface OpenaiDeviceStateV1 {
  userCode?: string;
  verifyHint?: string;
  copied: boolean;
}

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
  if (c.field === 'secret') lines.push(...wrapPlain(GEMINI_CLIENT_STORED_UNVERIFIED_NOTE, DETAIL_W));
  lines.push(c.field === 'id' ? '↵ continues · esc back' : '↵ stores · esc back to the id');
  return lines;
}

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
    case 'handles': {
      if (pane.handles.phase !== 'waiting') return 'esc cancel';
      const copy = pane.draftLen === 0 && pane.handles.authorizeUrl !== undefined;
      const device = pane.draftLen === 0 && pane.handles.leg === 'openai-browser';
      return `↵ submit paste${copy ? ' · c copy' : ''}${device ? ' · d device' : ''} · esc cancel`;
    }
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

export function loginsMenuModelOf(
  facts: LoginsScreenFactsV1,
  opts: {
    selIdx: number;
    environment: { model: string; critter: string; critterHue: string; dirBase: string; dirTail: string };
    statusNote?: string | null;
    glowWord?: BootMenuData['glowWord'];
    notice?: string | null;
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
  fullScene?: { columns: number; rows: number };
  facts?: LoginsScreenFactsV1;
}

export function BootLoginsScreen({ onClose, fullScene, facts: given }: BootLoginsScreenProps = {}): React.ReactNode {
  const t = useMercuryTokens();
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const columns = fullScene?.columns ?? termCols;
  const rows = fullScene?.rows ?? termRows;

  const [facts, setFacts] = useState<LoginsScreenFactsV1>(() => given ?? collectLoginsScreenFacts());
  const arms = useMemo(() => loginsSortedArms(facts), [facts]);

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
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraftState] = useState('');
  const draftRef = useRef('');
  const setDraft = (next: string | ((current: string) => string)): void => {
    const value = typeof next === 'function' ? next(draftRef.current) : next;
    draftRef.current = value;
    setDraftState(value);
  };
  const deviceRunRef = useRef(0);
  const handlesRef = useRef<{ cancel: (reason?: string) => void; completeWithRedirect: (pasted: string) => void } | null>(null);

  const refreshFacts = (): void => {
    if (given === undefined) setFacts(collectLoginsScreenFacts());
  };

  const setAppStateMaybe = useSetAppStateMaybe();
  const postLoginSettle = (): void => {
    if (given !== undefined) return;
    void (async () => {
      try {
        const [user, gates, killswitch] = await Promise.all([
          import('../utils/user.js'),
          import('../services/analytics/featureGates.js'),
          import('../utils/permissions/bypassPermissionsKillswitch.js'),
        ]);
        user.resetUserCache();
        await gates.refreshFeatureGates().catch(() => {});
        killswitch.resetBypassPermissionsCheck();
        if (setAppStateMaybe !== null) {
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
      }
    })();
  };
  const closeFlow = (): void => {
    deviceRunRef.current += 1;
    handlesRef.current?.cancel('cancelled from the logins layer');
    handlesRef.current = null;
    setFlow(null);
    setDraft('');
  };

  const discloseLateSettle = (sentence: string): void => {
    setNotice(sentence);
    refreshFacts();
    postLoginSettle();
  };

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

  const startHandlesRun = (leg: HandlesLegId): void => {
    const run = (deviceRunRef.current += 1);
    const live = (): boolean => run === deviceRunRef.current;
    const onListenerIssue = (message: string): void => {
      if (!live()) return;
      setFlow(f => (f?.kind === 'handles' ? { kind: 'handles', handles: { ...f.handles, listenerNote: message } } : f));
    };
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

  const model = useAnthropicLoginModel({
    onDone: () => {
      refreshFacts();
      postLoginSettle();
      closeFlow();
    },
  });
  const openPick = (pick: LoginsPickId, cursor = 0): void => {
    setFlow({ kind: 'pick', pick });
    pickList.moveTo(cursor);
  };

  const openFlow = (arm: LoginsArmV1): void => {
    setDraft('');
    setNotice(null);
    switch (arm.row.value) {
      case 'claudeai':
        setFlow({ kind: 'anthropic' });
        model.reset();
        model.start(true);
        return;
      case 'console':
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
          const storedId = geminiOauthClientConfig()?.clientId ?? '';
          setDraft(storedId);
          setFlow({ kind: 'client', client: { field: 'id', clientId: storedId, note: null } });
          return;
        }
        startHandlesRun('gemini-oauth');
        return;
    }
  };

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
      if (flowRef.current?.kind !== 'key') return;
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

  const recordedFocus = loginFamilyFocusFor(mostRecentSignInFamily());

  const list = useInteractiveList<LoginsArmV1>({
    rows: arms,
    rowId: a => `logins:${a.row.value}`,
    idNamespace: 'boot-logins',
    ...(recordedFocus !== undefined ? { initialId: `logins:${recordedFocus}` } : {}),
    active: flow === null,
    onClose: () => onClose?.(),
    actions: [
      {
        key: 'return',
        hint: 'sign in',
        when: a => loginsFlowReady(a.row.value),
        run: a => {
          if (a !== null && loginsFlowReady(a.row.value)) openFlow(a);
          return null;
        },
      },
      {
        key: 's',
        hint: 'switch active slot',
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

  const pickOptions = flow?.kind === 'pick' ? loginsPickOptions(flow.pick) : [];
  const pickList = useInteractiveList<{ label: string; value: string }>({
    rows: pickOptions,
    rowId: r => `logins-pick:${r.value}`,
    idNamespace: 'boot-logins-pick',
    active: flow?.kind === 'pick',
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

  useInput(
    (_input, key, event) => {
      if (!key.leftArrow) return;
      event.stopImmediatePropagation();
      onClose?.();
    },
    { isActive: flow === null },
  );

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
