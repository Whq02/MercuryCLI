import { activateMetaSource, liveMetaConnectFacts, metaConnectRowAction } from '../../../models/roads/meta/metaLogin.js';
import { moonshotStoredRegion } from '../../../models/roads/moonshot/moonshotAccounts.js';
import { activateGeminiSource } from '../../../models/roads/gemini/geminiLogin.js';
import { GEMINI_API_KEY_PAGE, geminiGuideOpeningStep, liveGeminiConnectFacts, geminiConnectRowAction } from '../../../models/sign-in/gemini-connect/geminiConnectGuide.js';
import { openBrowser } from '../../../platform/host-os/browser.js';
import type { LoginsArmV1, LoginsRosterRowV1 } from './facts.js';
import type { LoginsPickId } from './pickLines.js';
import type { LoginsFlowContext } from './context.js';

export function openRosterFlowOf(ctx: LoginsFlowContext, row: LoginsRosterRowV1): void {
  if (row.kind === 'external-agent') {
    ctx.setDraft('');
    ctx.setNotice(null);
    ctx.openPick('devin-cli');
    return;
  }
  openFlowOf(ctx, row.arm);
}

export function openFlowOf(ctx: LoginsFlowContext, arm: LoginsArmV1): void {
  const { xaiApiReceipt, mistralApiReceipt, setFlow, setNotice, setDraft, openPick } = ctx;
  setDraft('');
  setNotice(null);
  if (arm.row.value.startsWith('compat/')) {
    setFlow({ kind: 'key', leg: arm.row.value as `compat/${string}`, note: null, storing: false });
    return;
  }
  switch (arm.row.value) {
    case 'anthropic':
      openPick('anthropic');
      return;
    case 'zai':
      openPick('zai');
      return;
    case 'meta':
      openPick('meta');
      return;
    case 'mistral':
      mistralApiReceipt.current = 'Mistral API key kept.';
      setFlow({ kind: 'key', leg: 'mistral', note: null, storing: false });
      return;
    case 'nous':
      openPick('nous');
      return;
    case 'orcarouter':
      openPick('orcarouter');
      return;
    case 'zen':
      setFlow({ kind: 'key', leg: 'zen', note: null, storing: false });
      return;
    case 'minimax':
    case 'together':
    case 'cohere':
    case 'groq':
    case 'melious':
      setFlow({ kind: 'key', leg: arm.row.value, note: null, storing: false });
      return;
    case 'cerebras':
      setFlow({ kind: 'key', leg: 'cerebras', note: null, storing: false });
      return;
    case 'fireworks':
      setFlow({ kind: 'key', leg: 'fireworks', note: null, storing: false });
      return;
    case 'qwen':
      setFlow({ kind: 'key', leg: 'qwen', note: null, storing: false });
      return;
    case 'deepseek':
      setFlow({ kind: 'key', leg: 'deepseek', note: null, storing: false });
      return;
    case 'xai':
      xaiApiReceipt.current = 'xAI API key kept.';
      openPick('xai');
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
}

export function resolvePickOf(ctx: LoginsFlowContext, pick: LoginsPickId, value: string): void {
  const { setFlow, setDraft, startDeviceRun, openGuideStep, startHandlesRun, startDevinCliRun, model, openPick } = ctx;
  setDraft('');
  switch (pick) {
    case 'anthropic':
      if (value === 'key') {
        setFlow({ kind: 'key', leg: 'anthropic-key', note: null, storing: false });
        return;
      }
      setFlow({ kind: 'anthropic' });
      model.reset();
      model.start(value === 'claudeai');
      return;
    case 'xai':
      if (value === 'key') setFlow({ kind: 'key', leg: 'xai', note: null, storing: false });
      else startDeviceRun('xai');
      return;
    case 'nous':
      if (value === 'key') setFlow({ kind: 'key', leg: 'nous', note: null, storing: false });
      else startDeviceRun('nous');
      return;
    case 'orcarouter':
      if (value === 'key') setFlow({ kind: 'key', leg: 'orcarouter', note: null, storing: false });
      else startDeviceRun('orcarouter');
      return;
    case 'meta':
      if ((value === 'key' || value === 'device') && metaConnectRowAction(liveMetaConnectFacts(), value) === 'activate') {
        setFlow({ kind: 'receipt', ...activateMetaSource(value === 'key' ? 'api-key' : 'muse-code') });
        return;
      }
      if (value === 'key') setFlow({ kind: 'key', leg: 'meta', note: null, storing: false });
      else startDeviceRun('meta');
      return;
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
      if ((value === 'key' || value === 'google' || value === 'plan') && geminiConnectRowAction(liveGeminiConnectFacts(), value) === 'activate') {
        setFlow({ kind: 'receipt', ...activateGeminiSource(value === 'key' ? 'api-key' : value === 'plan' ? 'plan' : 'oauth') });
        return;
      }
      if (value === 'plan') {
        startHandlesRun('gemini-plan');
        return;
      }
      if (value === 'key') {
        setFlow({ kind: 'key', leg: 'gemini-key', note: null, storing: false, opened: 'opening' });
        void openBrowser(GEMINI_API_KEY_PAGE.address).then(ok => {
          setFlow(f => (f?.kind === 'key' && f.leg === 'gemini-key' ? { ...f, opened: ok ? 'opened' : 'failed' } : f));
        });
        return;
      }
      if (value === 'client') {
        openGuideStep(5, 'pick');
        return;
      }
      if (geminiGuideOpeningStep(liveGeminiConnectFacts()) === 6) {
        startHandlesRun('gemini-oauth');
        return;
      }
      openGuideStep(1, 'walk');
      return;
    case 'devin-cli':
      if (value === 'login') startDevinCliRun('login');
      else if (value === 'status') startDevinCliRun('status');
      else if (value === 'logout') openPick('devin-cli-logout-confirm', 0);
      return;
    case 'devin-cli-logout-confirm':
      if (value === 'confirm') startDevinCliRun('logout');
      else openPick('devin-cli', 2);
      return;
  }
}
