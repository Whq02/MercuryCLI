import { keyPasteGuardNote } from '../mercury-ui/screens/keyPasteGuards.js';
import { storeCompatApiKeyLogin } from '../../services/providers/openaicompat/compatLogin.js';
import { storeOpenaiApiKeyLogin } from '../../services/providers/openai/openaiLogin.js';
import { storeAnthropicApiKeyLogin } from '../../services/providers/anthropic/anthropicLogin.js';
import { storeZaiApiKeyLogin } from '../../services/providers/zai/zaiLogin.js';
import { storeDeepseekApiKeyLogin } from '../../services/providers/deepseek/deepseekLogin.js';
import { storeXaiApiKeyLogin, storeXaiManagementKeyLogin } from '../../services/providers/xai/xaiLogin.js';
import { resolveXaiApiKey } from '../../services/providers/xai/xaiAccounts.js';
import { storeMetaApiKeyLogin } from '../../services/providers/meta/metaLogin.js';
import { storeMistralApiKeyLogin, storeMistralAdminKeyLogin } from '../../services/providers/mistral/mistralLogin.js';
import { storeNousApiKeyLogin } from '../../services/providers/nous/nousLogin.js';
import { storeZenApiKeyLogin } from '../../services/providers/zen/zenLogin.js';
import { storeMinimaxApiKeyLogin } from '../../services/providers/minimax/minimaxLogin.js';
import { storeTogetherApiKeyLogin } from '../../services/providers/together/togetherLogin.js';
import { storeCohereApiKeyLogin } from '../../services/providers/cohere/cohereLogin.js';
import { storeGroqApiKeyLogin } from '../../services/providers/groq/groqLogin.js';
import { storeMeliousApiKeyLogin } from '../../services/providers/melious/meliousLogin.js';
import { storeOrcarouterApiKeyLogin } from '../../services/providers/orcarouter/orcarouterLogin.js';
import { storeCerebrasApiKeyLogin } from '../../services/providers/cerebras/cerebrasLogin.js';
import { storeFireworksApiKeyLogin } from '../../services/providers/fireworks/fireworksLogin.js';
import { storeQwenApiKeyLogin } from '../../services/providers/qwen/qwenLogin.js';
import { storeMoonshotApiKeyLogin } from '../../services/providers/moonshot/moonshotLogin.js';
import { storeHuggingfaceTokenLogin } from '../../services/providers/huggingface/huggingfaceLogin.js';
import { storeOpenrouterApiKeyLogin } from '../../services/providers/openrouter/openrouterLogin.js';
import { storeGeminiApiKeyLogin } from '../../services/providers/gemini/geminiLogin.js';
import { keyLegGuardOpts, type FaceKeyLegId } from './pickLines.js';
import type { LoginsFlowContext } from './context.js';

export function submitKeyOf(ctx: LoginsFlowContext, leg: FaceKeyLegId, raw: string): void {
  const { flowRef, anthropicKeyDraft, anthropicKeyRequest, xaiApiReceipt, mistralApiReceipt, setFlow, setDraft } = ctx;
  const value = raw.trim();
  if (leg === 'anthropic-key' || leg === 'anthropic-workspace') {
    if (!value || anthropicKeyRequest.current) return;
    const request = new AbortController();
    anthropicKeyRequest.current = request;
    const key = leg === 'anthropic-workspace' ? anthropicKeyDraft.current : value;
    setFlow({ kind: 'key', leg, note: null, storing: true });
    void storeAnthropicApiKeyLogin(key, { workspaceId: leg === 'anthropic-workspace' ? value : undefined, signal: request.signal }).then(outcome => {
      if (request.signal.aborted) return;
      anthropicKeyRequest.current = null;
      if (outcome.stored) {
        anthropicKeyDraft.current = '';
        setDraft('');
        setFlow({ kind: 'receipt', receipt: outcome.receipt, ok: true });
      } else if (outcome.needsWorkspace) {
        anthropicKeyDraft.current = key;
        setDraft('');
        setFlow({ kind: 'key', leg: 'anthropic-workspace', note: null, storing: false });
      } else setFlow({ kind: 'key', leg, note: outcome.receipt, storing: false });
    });
    return;
  }
  if (!value) {
    if (leg === 'xai-management') setFlow({ kind: 'receipt', receipt: `${xaiApiReceipt.current} Management key unchanged; /logins xai adds it later.`, ok: true });
    else if (leg === 'xai' && resolveXaiApiKey()) setFlow({ kind: 'key', leg: 'xai-management', note: null, storing: false });
    else if (leg === 'mistral-admin') setFlow({ kind: 'receipt', receipt: `${mistralApiReceipt.current} Admin API key unchanged; /logins mistral adds it later.`, ok: true });
    return;
  }
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
    if (leg === 'xai') {
      xaiApiReceipt.current = outcome.receipt;
      setFlow({ kind: 'key', leg: 'xai-management', note: null, storing: false });
    } else if (leg === 'mistral') {
      mistralApiReceipt.current = outcome.receipt;
      setFlow({ kind: 'key', leg: 'mistral-admin', note: null, storing: false });
    } else setFlow({ kind: 'receipt', receipt: leg === 'xai-management' ? `${xaiApiReceipt.current} ${outcome.receipt}` : leg === 'mistral-admin' ? `${mistralApiReceipt.current} ${outcome.receipt}` : outcome.receipt, ok: outcome.ok });
  };
  if (leg.startsWith('compat/')) void storeCompatApiKeyLogin(leg.slice(7), value).then(settle);
  else if (leg === 'openai-key') void storeOpenaiApiKeyLogin(value).then(settle);
  else if (leg === 'deepseek') void storeDeepseekApiKeyLogin(value).then(settle);
  else if (leg === 'xai') void storeXaiApiKeyLogin(value).then(settle);
  else if (leg === 'xai-management') void storeXaiManagementKeyLogin(value).then(settle);
  else if (leg === 'meta') void storeMetaApiKeyLogin(value).then(settle);
  else if (leg === 'mistral') void storeMistralApiKeyLogin(value).then(settle);
  else if (leg === 'mistral-admin') void storeMistralAdminKeyLogin(value).then(settle);
  else if (leg === 'nous') void storeNousApiKeyLogin(value).then(outcome => settle({ ok: outcome.ok, stored: outcome.stored, receipt: outcome.receipt }));
  else if (leg === 'zen') void storeZenApiKeyLogin(value).then(settle);
  else if (leg === 'minimax') void storeMinimaxApiKeyLogin(value).then(settle);
  else if (leg === 'together') void storeTogetherApiKeyLogin(value).then(settle);
  else if (leg === 'cohere') void storeCohereApiKeyLogin(value).then(settle);
  else if (leg === 'groq') void storeGroqApiKeyLogin(value).then(settle);
  else if (leg === 'melious') void storeMeliousApiKeyLogin(value).then(settle);
  else if (leg === 'orcarouter') void storeOrcarouterApiKeyLogin(value).then(settle);
  else if (leg === 'cerebras') void storeCerebrasApiKeyLogin(value).then(settle);
  else if (leg === 'fireworks') void storeFireworksApiKeyLogin(value).then(settle);
  else if (leg === 'qwen') void storeQwenApiKeyLogin(value).then(settle);
  else if (leg === 'moonshot-key')
    void storeMoonshotApiKeyLogin(value).then(outcome => settle({ ok: outcome.ok, stored: outcome.stored, receipt: outcome.receipt }));
  else if (leg === 'hf-token') void storeHuggingfaceTokenLogin(value).then(settle);
  else if (leg === 'openrouter-key') void storeOpenrouterApiKeyLogin(value).then(settle);
  else if (leg === 'gemini-key') void storeGeminiApiKeyLogin(value).then(settle);
  else void storeZaiApiKeyLogin(value, leg === 'zai-coding' ? 'coding' : 'general').then(settle);
}

export function keyEscapeOf(ctx: LoginsFlowContext, leg: FaceKeyLegId): void {
  const { anthropicKeyDraft, anthropicKeyRequest, xaiApiReceipt, mistralApiReceipt, setFlow, setDraft, closeFlow, openPick } = ctx;
  setDraft('');
  if (leg === 'anthropic-key' || leg === 'anthropic-workspace') {
    anthropicKeyRequest.current?.abort();
    anthropicKeyRequest.current = null;
    anthropicKeyDraft.current = '';
    openPick('anthropic');
    return;
  }
  if (leg === 'xai-management') setFlow({ kind: 'receipt', receipt: `${xaiApiReceipt.current} Management key unchanged; /logins xai adds it later.`, ok: true });
  else if (leg === 'mistral-admin') setFlow({ kind: 'receipt', receipt: `${mistralApiReceipt.current} Admin API key unchanged; /logins mistral adds it later.`, ok: true });
  else if (leg === 'openai-key') openPick('openai');
  else if (leg === 'zai-general' || leg === 'zai-coding') openPick('zai');
  else if (leg === 'moonshot-key') openPick('moonshot');
  else if (leg === 'hf-token') openPick('huggingface');
  else if (leg === 'openrouter-key') openPick('openrouter');
  else if (leg === 'gemini-key') openPick('gemini');
  else if (leg === 'meta') openPick('meta');
  else closeFlow();
}
