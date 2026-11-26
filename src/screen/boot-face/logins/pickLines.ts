import { compatKeyEnvName } from '../../../models/roads/openaicompat/compatAccounts.js';
import { ANTHROPIC_WORKSPACE_PROMPT } from '../../../models/roads/anthropic/anthropicWorkspace.js';
import { zaiPlanLabel } from '../../../models/roads/zai/zaiLogin.js';
import { XAI_CONNECT_ROWS } from '../../../models/roads/xai/xaiLogin.js';
import { XAI_MANAGEMENT_KEY_PAGE } from '../../../models/roads/xai/xaiUsageState.js';
import { liveMetaConnectFacts, metaConnectRows, type MetaConnectFacts } from '../../../models/roads/meta/metaLogin.js';
import { MISTRAL_ADMIN_KEY_PAGE } from '../../../models/roads/mistral/mistralUsageState.js';
import { NOUS_CONNECT_ROWS } from '../../../models/roads/nous/nousLogin.js';
import { ORCAROUTER_CONNECT_ROWS } from '../../../models/roads/orcarouter/orcarouterLogin.js';
import { QWEN_KEY_KINDS_SHORT } from '../../../models/roads/qwen/qwenLogin.js';
import { GEMINI_CONNECT_INTRO, GEMINI_KEY_BILLING_NOTE, geminiConnectRows, geminiKeyLegLines, liveGeminiConnectFacts, type GeminiConnectFacts, type GeminiGuideOpenState } from '../../../models/sign-in/gemini-connect/geminiConnectGuide.js';
import { wrapPlain } from '../BootHealthScreen.js';
import { anthropicArmPickRows, keyPageLine, openaiArmPickRows } from '../../../models/sign-in/flow-cards/loginFamilyRows.js';
import { DETAIL_W } from './facts.js';
import { wrapClauses, maskedDraftLine, wrapHard } from './anthropicLines.js';
import { devinCliActionOptions, devinCliLogoutConfirmOptions } from './devinCliAction.js';

export type LoginsPickId = 'anthropic' | 'openai' | 'zai' | 'moonshot' | 'huggingface' | 'kimi-region' | 'openrouter' | 'gemini' | 'xai' | 'nous' | 'orcarouter' | 'meta' | 'devin-cli' | 'devin-cli-logout-confirm';
export type FaceKeyLegId =
  | 'anthropic-key'
  | 'anthropic-workspace'
  | 'openai-key'
  | 'zai-general'
  | 'zai-coding'
  | 'deepseek'
  | 'xai'
  | 'xai-management'
  | 'meta'
  | 'moonshot-key'
  | 'hf-token'
  | 'openrouter-key'
  | 'gemini-key'
  | 'mistral'
  | 'mistral-admin'
  | 'nous'
  | 'zen'
  | 'minimax'
  | 'together'
  | 'cohere'
  | 'groq'
  | 'melious'
  | 'orcarouter'
  | 'cerebras'
  | 'fireworks'
  | 'qwen'
  | `compat/${string}`;

export function geminiPickOptions(facts: GeminiConnectFacts): Array<{ label: string; value: string }> {
  return geminiConnectRows(facts);
}

export function metaPickOptions(facts: MetaConnectFacts): Array<{ label: string; value: string }> {
  return metaConnectRows(facts);
}

export function loginsPickOptions(
  pick: LoginsPickId,
  geminiFacts?: GeminiConnectFacts,
  metaFacts?: MetaConnectFacts,
): Array<{ label: string; value: string }> {
  switch (pick) {
    case 'xai':
      return XAI_CONNECT_ROWS;
    case 'nous':
      return NOUS_CONNECT_ROWS;
    case 'orcarouter':
      return ORCAROUTER_CONNECT_ROWS;
    case 'meta':
      return metaPickOptions(metaFacts ?? liveMetaConnectFacts());
    case 'openrouter':
      return [
        { label: 'Sign in with the browser — OAuth mints a scoped key', value: 'browser' },
        { label: 'Headless — OpenRouter shows a code you paste here', value: 'headless' },
        { label: 'Paste an API key (stored locally, mode 600)', value: 'key' },
      ];
    case 'gemini':
      return geminiPickOptions(geminiFacts ?? liveGeminiConnectFacts());
    case 'anthropic':
      return [...anthropicArmPickRows];
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
        { label: 'Paste a Moonshot API key (stored locally, mode 600)', value: 'key' },
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
    case 'devin-cli':
      return devinCliActionOptions();
    case 'devin-cli-logout-confirm':
      return devinCliLogoutConfirmOptions();
  }
}

export function loginsPickPaneLines(pick: LoginsPickId, pickSel = 0): string[] {
  const body = ((): string => {
    switch (pick) {
      case 'xai':
        return 'Sign in with your Grok account (SuperGrok / X Premium) or paste an API key. xAI decides subscription eligibility; consent may say Grok Build.';
      case 'nous':
        return 'Sign in with your Nous Portal account in the browser, or paste an API key. Either one bills the Portal credits or subscription behind it.';
      case 'orcarouter':
        return 'Sign in with your OrcaRouter account in the browser, or paste an API key. Requests bill OrcaRouter credits.';
      case 'meta':
        return 'Sign in with Meta for a Muse Code subscription (device code in your browser), or paste a pay-as-you-go Model API key.';
      case 'anthropic':
        return 'One Anthropic family, two credentials: the Claude subscription signs in with the browser; usage-based billing signs in to the Anthropic Console, which mints an API key.';
      case 'openai':
        return 'One OpenAI family, two credentials: the ChatGPT subscription signs in with the browser (d on the wait switches to a device code); an API key bills usage-based.';
      case 'zai':
        return 'Z.AI signs in with API keys only. Which key is this? A GLM Coding Plan key is valid on the Coding Plan base and refused on the general one, so the answer picks the base.';
      case 'moonshot':
        return 'A Kimi account signs in with a device code and runs on its plan; a Moonshot platform key bills usage-based. Either one lights the Kimi rows in /model.';
      case 'huggingface':
        return 'One Hub token reaches every open model on Inference Providers (monthly credits first, then pay-as-you-go at provider rates).';
      case 'kimi-region':
        return 'The choice picks the sign-in host and the base your turns ride; it is remembered with the login.';
      case 'openrouter':
        return "One credential unlocks OpenRouter's whole multi-model catalogue (credits-billed).";
      case 'gemini':
        return pickSel === 1 ? GEMINI_KEY_BILLING_NOTE : GEMINI_CONNECT_INTRO;
      case 'devin-cli':
        return 'Devin CLI is an external agent — not a model provider for /model. Credentials stay with Devin CLI; once signed in, attach from chat with /crew attach devin.';
      case 'devin-cli-logout-confirm':
        return 'Confirm before running devin auth logout. This removes Devin CLI credentials stored by Devin CLI.';
    }
  })();
  return [
    ...(body ? wrapPlain(body, DETAIL_W) : []),
    ...(pick === 'kimi-region' || pick === 'anthropic' || pick === 'devin-cli' || pick === 'devin-cli-logout-confirm' ? [] : wrapClauses(keyPageLine(pick), DETAIL_W)),
    '',
    pick === 'kimi-region' ? 'esc — back to the Kimi choice' : pick === 'devin-cli-logout-confirm' ? 'esc — back to Devin CLI' : 'esc — back to the roster',
  ];
}

export function keyLegTitle(leg: FaceKeyLegId): string {
  switch (leg) {
    case 'anthropic-key': return 'Anthropic API key';
    case 'anthropic-workspace': return 'Anthropic workspace ID';
    case 'openai-key':
      return 'OpenAI API key';
    case 'zai-general':
      return zaiPlanLabel('general');
    case 'zai-coding':
      return zaiPlanLabel('coding');
    case 'meta':
      return 'Meta Model API key';
    case 'nous':
      return 'Nous Portal API key';
    case 'deepseek':
      return 'DeepSeek API key';
    case 'xai':
      return 'xAI API key';
    case 'xai-management':
      return 'xAI management key (optional)';
    case 'moonshot-key':
      return 'Moonshot API key';
    case 'hf-token':
      return 'Hugging Face token';
    case 'openrouter-key':
      return 'OpenRouter API key';
    case 'gemini-key':
      return 'Gemini API key';
    case 'mistral':
      return 'Mistral API key';
    case 'mistral-admin':
      return 'Mistral Admin API key (optional)';
    case 'groq':
      return 'Groq API key';
    case 'melious':
      return 'Melious AI API key';
    case 'orcarouter':
      return 'OrcaRouter API key';
    case 'cerebras':
      return 'Cerebras API key';
    case 'fireworks':
      return 'Fireworks API key';
    case 'qwen':
      return 'QwenCloud or Model Studio API key';
    case 'zen':
      return 'OpenCode Zen API key';
    case 'minimax':
      return 'MiniMax API key';
    case 'together':
      return 'Together AI API key';
    case 'cohere':
      return 'Cohere API key';
    default: return `${leg.slice(7)} endpoint API key`;
  }
}

export function keyLegStoreLine(leg: FaceKeyLegId): string {
  switch (leg) {
    case 'anthropic-key': return 'Paste your Anthropic API key';
    case 'anthropic-workspace': return ANTHROPIC_WORKSPACE_PROMPT;
    case 'openai-key':
      return 'Stored auth-scoped (mode 600), never logged; OPENAI_API_KEY wins over the store.';
    case 'zai-general':
    case 'zai-coding':
      return 'Stored auth-scoped (mode 600), never logged; ZAI_API_KEY wins over the store.';
    case 'meta':
      return 'Stored auth-scoped (mode 600); MODEL_API_KEY, then META_API_KEY, wins. Pay-as-you-go; Sign in with Meta connects a Muse Code plan.';
    case 'nous':
      return 'Stored auth-scoped (mode 600), never logged; NOUS_API_KEY wins over the store. Bills the Portal credits or subscription behind the key.';
    case 'deepseek':
      return 'Proven on the balance endpoint first; stored auth-scoped (mode 600); DEEPSEEK_API_KEY wins.';
    case 'xai':
      return 'Stored auth-scoped (mode 600); XAI_API_KEY wins. An optional management key follows for /usage.';
    case 'xai-management':
      return 'Stored auth-scoped (mode 600); XAI_MANAGEMENT_API_KEY wins.';
    case 'moonshot-key':
      return 'Proven on the balance endpoint first; stored auth-scoped (mode 600); MOONSHOT_API_KEY wins; a Kimi sign-in outranks it.';
    case 'hf-token':
      return 'Proven through whoami first; stored auth-scoped (mode 600); HF_TOKEN wins over the store.';
    case 'openrouter-key':
      return 'Stored auth-scoped (mode 600), never logged; OPENROUTER_API_KEY wins over the store.';
    case 'gemini-key':
      return 'Stored auth-scoped (mode 600), never logged; GOOGLE_API_KEY / GEMINI_API_KEY win over the store.';
    case 'mistral':
      return 'Proven on the model list first; stored auth-scoped (mode 600); MISTRAL_API_KEY wins. An optional Admin API key follows for /usage.';
    case 'mistral-admin':
      return 'Stored auth-scoped (mode 600); MISTRAL_ADMIN_API_KEY wins. Enterprise plans issue it at admin.mistral.ai.';
    case 'groq':
      return 'Checked on the model list first; stored auth-scoped (mode 600); GROQ_API_KEY wins. Text models only.';
    case 'melious':
      return 'MELIOUS_API_KEY wins over a stored key.';
    case 'orcarouter':
      return 'Requests bill OrcaRouter credits. ORCAROUTER_API_KEY wins over the stored key.';
    case 'cerebras':
      return 'Checked on the model list first; stored auth-scoped (mode 600); CEREBRAS_API_KEY wins. Text models only.';
    case 'fireworks':
      return 'Checked on the model list first; stored auth-scoped (mode 600); FIREWORKS_API_KEY wins. Text models only.';
    case 'qwen':
      return `${QWEN_KEY_KINDS_SHORT}, text models only, bound to its endpoint; stored auth-scoped (mode 600); DASHSCOPE_API_KEY wins.`;
    case 'zen':
      return 'Checked on the usage endpoint first; stored auth-scoped (mode 600); OPENCODE_API_KEY wins. One key, every model the gateway lists.';
    case 'minimax':
      return 'Proven on the model list first; stored auth-scoped (mode 600); MINIMAX_API_KEY wins. An M Plan key shows its windows in /usage.';
    case 'together':
      return 'Proven on the model list first; stored auth-scoped (mode 600); TOGETHER_API_KEY wins. One key, every chat model the gateway lists.';
    case 'cohere':
      return 'Proven on the model list first; stored auth-scoped (mode 600); COHERE_API_KEY wins.';
    default: return `Stored for ${leg.slice(7)} only (auth-scoped, mode 600); ${compatKeyEnvName(leg.slice(7))} wins over the store.`;
  }
}

export function keyLegGuardOpts(leg: FaceKeyLegId): { stores: string; looksLike?: string } {
  switch (leg) {
    case 'anthropic-key': return { stores: 'an Anthropic API key' };
    case 'anthropic-workspace': return { stores: 'an Anthropic workspace ID' };
    case 'openai-key':
      return { stores: 'an OpenAI key. Anthropic usage-based billing signs in through the Anthropic row, under Usage-based billing, instead' };
    case 'zai-general':
      return { stores: `a ${zaiPlanLabel('general')}` };
    case 'zai-coding':
      return { stores: `a ${zaiPlanLabel('coding')}` };
    case 'meta':
      return { stores: 'a Meta Model API key' };
    case 'nous':
      return { stores: 'a Nous Portal API key' };
    case 'deepseek':
      return { stores: 'a DeepSeek API key' };
    case 'xai':
      return { stores: 'an xAI API key' };
    case 'xai-management':
      return { stores: 'an xAI management key' };
    case 'moonshot-key':
      return { stores: 'a Moonshot platform key' };
    case 'hf-token':
      return { stores: 'a Hugging Face token (hf_…)', looksLike: 'a token' };
    case 'openrouter-key':
      return { stores: 'an OpenRouter key (sk-or-…)' };
    case 'gemini-key':
      return { stores: 'a Google Gemini key (AIza…)' };
    case 'mistral':
      return { stores: 'a Mistral API key' };
    case 'mistral-admin':
      return { stores: 'a Mistral Admin API key' };
    case 'groq':
      return { stores: 'a Groq API key' };
    case 'melious':
      return { stores: 'a Melious AI API key' };
    case 'orcarouter':
      return { stores: 'an OrcaRouter API key' };
    case 'cerebras':
      return { stores: 'a Cerebras API key' };
    case 'fireworks':
      return { stores: 'a Fireworks API key' };
    case 'qwen':
      return { stores: 'a QwenCloud or Model Studio API key' };
    case 'zen':
      return { stores: 'an OpenCode Zen API key (sk-…)' };
    case 'minimax':
      return { stores: 'a MiniMax API key' };
    case 'together':
      return { stores: 'a Together AI API key' };
    case 'cohere':
      return { stores: 'a Cohere API key' };
    default: return { stores: `the key for endpoint ${leg.slice(7)}` };
  }
}

export function keyPromptPaneLines(leg: FaceKeyLegId, note: string | null, draftLen: number, storing: boolean, opened?: GeminiGuideOpenState): string[] {
  const lines: string[] = [keyLegTitle(leg)];
  if (leg === 'gemini-key') {
    const [, sentence, address] = geminiKeyLegLines(opened);
    lines.push(...wrapPlain(sentence!.text, DETAIL_W), ...wrapHard(address!.text, DETAIL_W), ...wrapPlain(GEMINI_KEY_BILLING_NOTE, DETAIL_W));
  }
  if (leg === 'deepseek' && note === null) lines.push(...wrapClauses(keyPageLine('deepseek'), DETAIL_W));
  if (leg === 'xai' && note === null) lines.push(...wrapClauses(keyPageLine('xai'), DETAIL_W));
  if (leg === 'xai-management' && note === null) lines.push(...wrapPlain(XAI_MANAGEMENT_KEY_PAGE, DETAIL_W));
  if (leg === 'meta' && note === null) lines.push(...wrapClauses(keyPageLine('meta'), DETAIL_W));
  if (leg === 'mistral' && note === null) lines.push(...wrapClauses(keyPageLine('mistral'), DETAIL_W));
  if (leg === 'mistral-admin' && note === null) lines.push(...wrapPlain(MISTRAL_ADMIN_KEY_PAGE, DETAIL_W));
  if (leg === 'nous' && note === null) lines.push(...wrapClauses(keyPageLine('nous'), DETAIL_W));
  if (leg === 'zen' && note === null) lines.push(...wrapClauses(keyPageLine('zen'), DETAIL_W));
  if ((leg === 'minimax' || leg === 'together' || leg === 'cohere' || leg === 'groq' || leg === 'orcarouter' || leg === 'melious' || leg === 'cerebras' || leg === 'fireworks' || leg === 'qwen') && note === null) lines.push(...wrapClauses(keyPageLine(leg), DETAIL_W));
  lines.push(...wrapPlain(keyLegStoreLine(leg), DETAIL_W));
  lines.push(maskedDraftLine(draftLen).replace('code:', leg === 'anthropic-workspace' ? 'workspace:' : 'key:'));
  if (note !== null) {
    lines.push('');
    lines.push(...wrapPlain(note, DETAIL_W));
  }
  lines.push(storing ? 'checking the key…' : leg === 'xai-management' || leg === 'mistral-admin' ? '↵ stores · empty/esc skips; API key stays' : leg === 'xai' ? '↵ stores · empty keeps existing · esc back' : '↵ stores it · esc back');
  return lines;
}
