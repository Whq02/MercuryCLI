import type { AnthropicLoginSnapshot } from '../../widgets/faces/anthropicLoginModel.js';
import { GEMINI_CLIENT_STORED_UNVERIFIED_NOTE } from '../../../models/roads/gemini/geminiAccounts.js';
import { geminiGuidePaneLines, geminiGuideStep, type GeminiGuideOpenState, GEMINI_PLAN_LEG_DETAIL, GEMINI_PLAN_LEG_TITLE } from '../../../models/sign-in/gemini-connect/geminiConnectGuide.js';
import { wrapPlain } from '../BootHealthScreen.js';
import { META_LOGIN_FAMILY_LABEL } from '../../../models/sign-in/flow-cards/loginFamilyRows.js';
import { clampText, DETAIL_W } from './facts.js';
import { receiptPaneLines, signedInStatusWayOut, maskedDraftLine, anthropicFlowLegendOf, anthropicFlowStatusOf, anthropicFlowPaneLines, wrapHard } from './anthropicLines.js';
import { keyPromptPaneLines, type FaceKeyLegId, type LoginsPickId, keyLegTitle, loginsPickPaneLines } from './pickLines.js';
import { DEVIN_CLI_ACTION_TITLE, type DevinCliAction } from './devinCliAction.js';

export type FaceDeviceFamily = 'moonshot' | 'huggingface' | 'xai' | 'nous' | 'orcarouter' | 'meta';

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
  if (family === 'xai') return 'Grok (device code)';
  if (family === 'nous') return 'Nous Portal (browser approval)';
  if (family === 'orcarouter') return 'OrcaRouter (device code)';
  if (family === 'meta') return 'Meta (device code)';
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
  if (d.family === 'orcarouter') return d.phase === 'waiting'
    ? ['On the sign-in page, enter this code:', `    ${d.userCode ?? ''}`, ...wrapHard(d.verificationUri ?? '', DETAIL_W), d.copied ? 'copied to clipboard' : 'c copies the URL · esc cancels']
    : ['Connect OrcaRouter', 'esc cancels'];
  if (d.phase === 'starting') {
    return [`Connect ${deviceFamilyWords(d.family, d.regionWords)}`, '', 'Opening sign-in…', '', 'esc cancels — nothing is stored'];
  }
  if (d.phase === 'finishing') {
    return [
      `Connect ${deviceFamilyWords(d.family, d.regionWords)}`,
      '',
      'Finishing sign-in…',
    ];
  }
  const lines: string[] = ['On the sign-in page, enter this code:'];
  lines.push(`    ${d.userCode ?? ''}`);
  lines.push('If nothing opened, visit:');
  lines.push(...wrapHard(d.verificationUri ?? '', DETAIL_W));
  lines.push(`waiting${expiryWords(d.expiresAtMs, nowMs)}`);
  if (d.note !== undefined) {
    const wrapped = wrapPlain(d.note, DETAIL_W);
    lines.push(...(wrapped.length > 2 ? [...wrapped.slice(0, 1), wrapped[1]!.slice(0, DETAIL_W - 1) + '…'] : wrapped));
  }
  lines.push(d.copied ? 'copied to clipboard' : 'c copies the URL · esc cancels');
  return lines;
}


export type HandlesLegId = 'openai-browser' | 'openrouter-browser' | 'openrouter-headless' | 'gemini-oauth' | 'gemini-plan';

export interface HandlesWaitStateV1 {
  leg: HandlesLegId;
  phase: 'waiting' | 'exchanging';
  authorizeUrl?: string;
  listenerNote?: string;
  copied: boolean;
}

export function handlesWaitPaneLines(h: HandlesWaitStateV1, draftLen: number): string[] {
  if (h.phase === 'exchanging') {
    const words = 'Finishing sign-in…';
    return [...wrapPlain(words, DETAIL_W), '', 'esc cancels'];
  }
  const opening =
    h.leg === 'openrouter-headless'
      ? 'Open this URL on any signed-in browser; OpenRouter displays a code — paste it below.'
      : h.leg === 'gemini-oauth'
        ? `${geminiGuideStep(6).title}: ${geminiGuideStep(6).detail}`
        : h.leg === 'gemini-plan'
          ? `${GEMINI_PLAN_LEG_TITLE}: ${GEMINI_PLAN_LEG_DETAIL}`
          : 'Finish signing in in the browser.';
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
    return ['Opening sign-in…', '', 'esc cancels — nothing is stored'];
  }
  const lines: string[] = ['On any signed-in browser, enter this', 'one-time code:'];
  lines.push(`    ${d.userCode}`);
  if (d.verifyHint !== undefined) lines.push(...wrapPlain(d.verifyHint, DETAIL_W));
  lines.push('Waiting for approval…');
  lines.push(d.copied ? 'copied to clipboard' : 'c copies the code · esc stops watching');
  return lines;
}

export interface GeminiClientStateV1 {
  step: 1 | 2 | 3 | 4 | 5;
  from: 'walk' | 'pick';
  field: 'id' | 'secret';
  clientId: string;
  note: string | null;
  opened?: GeminiGuideOpenState;
}

export function geminiClientPaneLines(c: GeminiClientStateV1, draftLen: number, draft: string): string[] {
  const pane = geminiGuidePaneLines({
    step: c.step,
    ...(c.opened ? { opened: c.opened } : {}),
    ...(c.note !== null && c.step !== 5 ? { note: c.note } : {}),
    compact: true,
  });
  const address = (text: string): string[] => {
    const at = text.indexOf('https://');
    return at > 0 ? [text.slice(0, at).trimEnd(), ...wrapHard(text.slice(at), DETAIL_W)] : wrapHard(text, DETAIL_W);
  };
  const wrapped = (tones: string[]): string[] =>
    pane.filter(line => tones.includes(line.tone)).flatMap(line => (line.tone === 'address' ? address(line.text) : wrapPlain(line.text, DETAIL_W)));
  const lines: string[] = wrapped(['title', 'current']);
  if (c.step !== 5) {
    lines.push(...wrapped(['address', 'status', 'note']));
    lines.push('↵ next · o open · esc back');
    lines.push(...wrapped(['detail']));
    return lines;
  }
  if (c.field === 'id') {
    lines.push(`id: ${clampText(draft, DETAIL_W - 5)}▌`);
  } else {
    lines.push(...wrapPlain(`id: ${c.clientId} ✓`, DETAIL_W));
    lines.push(`secret (optional, ↵ skips): ${maskedDraftLine(draftLen).replace('code: ', '')}`);
  }
  if (c.note !== null) lines.push(...wrapPlain(c.note, DETAIL_W));
  lines.push(c.field === 'id' ? '↵ continues · esc back' : '↵ stores · esc back to the id');
  lines.push(...wrapped(['detail']));
  if (c.field === 'secret') lines.push(...wrapPlain(GEMINI_CLIENT_STORED_UNVERIFIED_NOTE, DETAIL_W));
  return lines;
}

export type LoginsFlowPaneV1 =
  | { kind: 'anthropic'; snap: AnthropicLoginSnapshot; draftLen: number; backToPicker?: boolean }
  | { kind: 'pick'; pick: LoginsPickId; pickSel: number }
  | { kind: 'key'; leg: FaceKeyLegId; note: string | null; draftLen: number; storing: boolean; opened?: GeminiGuideOpenState }
  | { kind: 'device'; device: DeviceWaitStateV1; nowMs: number }
  | { kind: 'handles'; handles: HandlesWaitStateV1; draftLen: number }
  | { kind: 'opdevice'; opdevice: OpenaiDeviceStateV1 }
  | { kind: 'client'; client: GeminiClientStateV1; draftLen: number; draft: string }
  | { kind: 'external-run'; action: DevinCliAction }
  | { kind: 'receipt'; receipt: string; ok: boolean; backToPicker?: boolean; external?: true };

export function loginsFlowLegendOf(pane: LoginsFlowPaneV1): string {
  switch (pane.kind) {
    case 'anthropic':
      return anthropicFlowLegendOf(pane.snap, pane.draftLen);
    case 'pick':
      return '↑↓ move · ↵ pick · esc back';
    case 'key':
      return pane.storing ? 'checking…' : pane.leg === 'xai-management' || pane.leg === 'mistral-admin' ? '↵ store key · empty/esc skip' : '↵ store key · esc back';
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
      return pane.client.step !== 5 ? '↵ next · o open · esc back' : pane.client.field === 'id' ? '↵ continue · esc back' : '↵ store · esc back';
    case 'external-run':
      return 'running in terminal…';
    case 'receipt':
      return '↵ done';
  }
}

export function loginsFlowStatusOf(pane: LoginsFlowPaneV1): string {
  switch (pane.kind) {
    case 'anthropic':
      return anthropicFlowStatusOf(pane.snap, pane.backToPicker === true);
    case 'pick':
      switch (pane.pick) {
        case 'xai':
          return 'xAI — Grok subscription or API key';
        case 'nous':
          return 'Nous Portal — account sign-in or API key';
        case 'orcarouter':
          return 'OrcaRouter — device-code sign-in or API key';
        case 'meta':
          return META_LOGIN_FAMILY_LABEL;
        case 'anthropic':
          return 'Anthropic — subscription or usage-based billing';
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
          return 'Gemini — an API key or a Google account';
        case 'devin-cli':
          return DEVIN_CLI_ACTION_TITLE;
        case 'devin-cli-logout-confirm':
          return 'Sign out of Devin CLI?';
      }
      break;
    case 'key':
      return pane.storing ? 'checking the key' : `paste ${keyLegTitle(pane.leg)}`;
    case 'device':
      return pane.device.family === 'orcarouter' ? 'OrcaRouter sign-in' : pane.device.phase === 'finishing'
        ? 'Finishing sign-in…'
        : `waiting on the ${pane.device.family === 'moonshot' ? 'Kimi' : pane.device.family === 'xai' ? 'Grok' : pane.device.family === 'nous' ? 'Nous Portal' : pane.device.family === 'meta' ? 'Meta' : 'Hub'} device code`;
    case 'handles':
      return pane.handles.phase === 'exchanging'
        ? 'Finishing sign-in…'
        : pane.handles.leg === 'gemini-oauth' || pane.handles.leg === 'gemini-plan'
          ? 'waiting on the Google sign-in'
          : pane.handles.leg === 'openai-browser'
            ? 'waiting on the OpenAI sign-in'
            : 'waiting on the OpenRouter sign-in';
    case 'opdevice':
      return 'waiting on the OpenAI device code';
    case 'client':
      return `Google account — step ${pane.client.step} of 6`;
    case 'external-run':
      return `running devin auth ${pane.action}`;
    case 'receipt':
      if (pane.external === true) return 'Devin CLI — ↵ returns to the roster';
      return pane.ok ? `connected — ${signedInStatusWayOut(pane.backToPicker === true)}` : 'not connected — ↵ returns to the roster';
  }
}

export function loginsFlowPaneLines(pane: LoginsFlowPaneV1): string[] {
  switch (pane.kind) {
    case 'anthropic':
      return anthropicFlowPaneLines(pane.snap, pane.draftLen, pane.backToPicker === true);
    case 'pick':
      return loginsPickPaneLines(pane.pick, pane.pickSel);
    case 'key':
      return keyPromptPaneLines(pane.leg, pane.note, pane.draftLen, pane.storing, pane.opened);
    case 'device':
      return deviceWaitPaneLines(pane.device, pane.nowMs);
    case 'handles':
      return handlesWaitPaneLines(pane.handles, pane.draftLen);
    case 'opdevice':
      return openaiDevicePaneLines(pane.opdevice);
    case 'client':
      return geminiClientPaneLines(pane.client, pane.draftLen, pane.draft);
    case 'external-run':
      return [
        DEVIN_CLI_ACTION_TITLE,
        '',
        `Running devin auth ${pane.action}…`,
        '',
        'finish in the terminal to return here',
      ];
    case 'receipt':
      if (pane.external === true) {
        const body = pane.receipt.split('\n').flatMap(line => wrapPlain(line, DETAIL_W));
        const capped = body.length > 10 ? [...body.slice(0, 9), '…'] : body;
        return [DEVIN_CLI_ACTION_TITLE, '', ...capped, '', '↵ done — back to the roster'];
      }
      return receiptPaneLines(pane.receipt, pane.ok, pane.backToPicker === true);
  }
}

export type OpenFlowState =
  | { kind: 'anthropic' }
  | { kind: 'pick'; pick: LoginsPickId }
  | { kind: 'key'; leg: FaceKeyLegId; note: string | null; storing: boolean; opened?: GeminiGuideOpenState }
  | { kind: 'device'; device: DeviceWaitStateV1 }
  | { kind: 'handles'; handles: HandlesWaitStateV1 }
  | { kind: 'opdevice'; opdevice: OpenaiDeviceStateV1 }
  | { kind: 'client'; client: GeminiClientStateV1 }
  | { kind: 'external-run'; action: DevinCliAction }
  | { kind: 'receipt'; receipt: string; ok: boolean; external?: true };
