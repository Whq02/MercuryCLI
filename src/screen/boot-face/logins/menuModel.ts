import type { BootMenuData } from '../../../../assets/splash/splash-core.mjs';
import { loginsSwitchableFamily, loginsRosterEntryOf, loginsLegendOf, loginsSummaryRows, loginsStatusLine, type LoginsScreenFactsV1, loginsRosterRows, loginsRosterDetailLines } from './facts.js';
import { loginsPickOptions } from './pickLines.js';
import type { useAnthropicLoginModel } from '../../widgets/faces/anthropicLoginModel.js';
import { type LoginsFlowPaneV1, loginsFlowPaneLines, type OpenFlowState, loginsFlowStatusOf, loginsFlowLegendOf, loginsFlowNoticeOf } from './flowLines.js';

export function loginsMenuModelOf(
  facts: LoginsScreenFactsV1,
  opts: {
    selIdx: number;
    environment: { model: string; critter: string; critterHue: string; dirBase: string; dirTail: string };
    statusNote?: string | null;
    glowWord?: BootMenuData['glowWord'];
    notice?: string | null;
    devinCliMissing?: string | null;
    flow?: LoginsFlowPaneV1;
  },
): BootMenuData {
  const roster = loginsRosterRows(facts);
  const selected = opts.selIdx >= 0 ? roster[opts.selIdx] : undefined;
  const pick = opts.flow?.kind === 'pick' ? opts.flow : null;
  const signIn = opts.flow !== undefined ? loginsFlowNoticeOf(opts.flow) : null;
  const flowPane =
    opts.flow !== undefined
      ? {
          detailOverride: loginsFlowPaneLines(opts.flow),
          ...((opts.flow.kind === 'key' && (opts.flow.leg === 'xai' || opts.flow.leg === 'xai-management' || opts.flow.leg === 'mistral' || opts.flow.leg === 'mistral-admin')) || (opts.flow.kind === 'receipt' && opts.flow.external === true) || signIn !== null ? { detailOverrideConfirms: true } : {}),
          ...(signIn !== null ? { detailOverrideWhole: signIn } : {}),
          legend: loginsFlowLegendOf(opts.flow),
          statusRight: loginsFlowStatusOf(opts.flow),
        }
      : null;
  return {
    title: 'logins',
    fitLabels: true,
    summaryRows: loginsSummaryRows(facts, opts.notice ?? null),
    noticeLine: opts.notice ?? null,
    environment: opts.environment,
    entries:
      pick !== null
        ? loginsPickOptions(pick.pick).map(option => ({
            label: option.label,
            group: 'pick',
            groupTitle:
              pick.pick === 'anthropic'
                ? 'Anthropic'
                : pick.pick === 'openai'
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
                          : pick.pick === 'xai' ? 'xAI (Grok)' : pick.pick === 'nous' ? 'Nous Portal' : pick.pick === 'orcarouter' ? 'OrcaRouter' : pick.pick === 'meta' ? 'Meta (Muse)' : pick.pick === 'devin-cli' ? 'Devin CLI (external agent)' : pick.pick === 'devin-cli-logout-confirm' ? 'Sign out of Devin CLI' : 'which deployment?',
            summary: '',
            valueLabel: '',
            valueIsDefault: true,
            pinnedVal: null,
            detail: null,
          }))
        : roster.map(row => loginsRosterEntryOf(row, facts)),
    selIdx: pick !== null ? pick.pickSel : opts.selIdx,
    statusRight: opts.statusNote ?? loginsStatusLine(facts),
    legend: loginsLegendOf(selected !== undefined && selected.kind === 'provider' && loginsSwitchableFamily(selected.arm, facts) !== null),
    moreHint: '… (the trail continues — taller terminal)',
    ...(selected !== undefined ? { detailOverride: loginsRosterDetailLines(selected, facts, opts.devinCliMissing ?? null) } : {}),
    ...(opts.glowWord !== undefined ? { glowWord: opts.glowWord } : {}),
    ...(flowPane ?? {}),
  };
}

export function loginsFlowPaneOf(flow: OpenFlowState, model: ReturnType<typeof useAnthropicLoginModel>, draft: string, pickList: { selectedIndex: number }, onSignedIn: (() => void) | undefined): LoginsFlowPaneV1 {
  return (
    flow.kind === 'anthropic'
      ? {
          kind: 'anthropic' as const,
          snap: {
            flow: model.flow,
            pastePromptUp: model.pastePromptUp,
            noCodeYet: model.noCodeYet,
            browserOpened: model.browserOpened,
            copied: model.copied,
            shadowWarning: model.shadowWarning,
            accountLabel: model.accountLabel,
          },
          draftLen: draft.length,
          ...(onSignedIn !== undefined ? { backToPicker: true } : {}),
        }
      : flow.kind === 'pick'
        ? { kind: 'pick' as const, pick: flow.pick, pickSel: pickList.selectedIndex }
        : flow.kind === 'key'
          ? { kind: 'key' as const, leg: flow.leg, note: flow.note, draftLen: draft.length, storing: flow.storing, ...(flow.opened ? { opened: flow.opened } : {}) }
          : flow.kind === 'device'
            ? { kind: 'device' as const, device: flow.device, nowMs: Date.now() }
            : flow.kind === 'handles'
              ? { kind: 'handles' as const, handles: flow.handles, draftLen: draft.length }
              : flow.kind === 'opdevice'
                ? { kind: 'opdevice' as const, opdevice: flow.opdevice }
                : flow.kind === 'client'
                  ? { kind: 'client' as const, client: flow.client, draftLen: draft.length, draft }
                  : flow.kind === 'external-run'
                    ? { kind: 'external-run' as const, action: flow.action }
                    : { kind: 'receipt' as const, receipt: flow.receipt, ok: flow.ok, ...(flow.external === true ? { external: true as const } : {}), ...(onSignedIn !== undefined && flow.external !== true ? { backToPicker: true } : {}) }
  );
}
