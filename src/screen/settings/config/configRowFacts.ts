import { getEngineModel, modelDisplayString, renderModelName } from '../../../models/catalogue/engineModel.js'
import { glmThinkingLocked } from '../../../models/facts/pins/glmPins.js'
import { modelThinkingAlwaysOn, modelThinkingOffIsBetweenTools } from '../../../models/facts/capabilities.js'
import { declaredRouteOf } from '../../../models/roads/callModelRouter.js'
import type { ProviderFamilyPresence } from '../../../models/roads/providerUsage.js'
import { shownIdentityWords } from '../../../models/roads/providerIdentityLine.js'
import { LOCAL_PULL_RECOMMENDATION } from '../../../models/roads/local/localAccounts.js'
import { LOCAL_SETUP_OFFER } from '../../../commands/localsetup/words.js'
import type { localRecordFor } from '../../../models/roads/local/localCatalogue.js'
import { heldLocalWindow, localWindowApplication, localWindowModelfileAutoWords, localWindowRefusalWords, localWindowRoomWords, localWindowSettingOf, localWindowValueWords } from '../../../models/roads/local/localWindow.js'

const CONFIG_PROVIDER_PRESENTATION: Record<
  string,
  { label: string; absent: string; manage?: string }
> = {
  anthropic: { label: 'Anthropic', absent: 'not signed in — /logins connects', manage: '/accounts' },
  openai: { label: 'OpenAI', absent: 'not signed in — /logins connects', manage: '/accounts' },
  zai: { label: 'Z.AI', absent: 'no key — /logins zai connects (or ZAI_API_KEY)', manage: '/accounts' },
  openrouter: { label: 'OpenRouter', absent: 'not signed in — /logins connects', manage: '/accounts' },
  gemini: { label: 'Gemini', absent: 'not signed in — /logins connects', manage: '/accounts' },
  moonshot: { label: 'Moonshot', absent: 'not signed in — /logins moonshot connects (or MOONSHOT_API_KEY)', manage: '/accounts' },
  deepseek: { label: 'DeepSeek', absent: 'no key — /logins deepseek connects (or DEEPSEEK_API_KEY)', manage: '/accounts' },
  xai: { label: 'xAI', absent: 'no key — /logins xai connects (or XAI_API_KEY)', manage: '/accounts' },
  meta: { label: 'Meta', absent: 'no key — /logins meta connects (or MODEL_API_KEY)', manage: '/accounts' },
  mistral: { label: 'Mistral', absent: 'no key — /logins mistral connects (or MISTRAL_API_KEY)', manage: '/accounts' },
  'openai-compat': { label: 'Custom endpoint', absent: 'not configured — MERCURY_COMPAT_BASE_URL' },
  huggingface: { label: 'Hugging Face', absent: 'not signed in — /logins connects (or HF_TOKEN)', manage: '/accounts' },
  local: { label: 'Local', absent: `no sign-in — start a local server or MERCURY_LOCAL_BASE_URL, then ${LOCAL_PULL_RECOMMENDATION}, ${LOCAL_SETUP_OFFER}` },
  nous: { label: 'Nous Portal', absent: 'no key — /logins nous connects (or NOUS_API_KEY)', manage: '/accounts' },
  zen: { label: 'OpenCode Zen', absent: 'no key — /logins zen connects (or OPENCODE_API_KEY)', manage: '/accounts' },
  minimax: { label: 'MiniMax', absent: 'no key — /logins minimax connects (or MINIMAX_API_KEY)', manage: '/accounts' },
  together: { label: 'Together AI', absent: 'no key — /logins together connects (or TOGETHER_API_KEY)', manage: '/accounts' },
  cohere: { label: 'Cohere', absent: 'no key — /logins cohere connects (or COHERE_API_KEY)', manage: '/accounts' },
  groq: { label: 'Groq', absent: 'no key — /logins groq connects (or GROQ_API_KEY)', manage: '/accounts' },
  melious: { label: 'Melious AI', absent: 'no key — /logins melious connects (or MELIOUS_API_KEY)', manage: '/accounts' },
  orcarouter: { label: 'OrcaRouter', absent: 'no key — /logins orcarouter connects (or ORCAROUTER_API_KEY)', manage: '/accounts' },
  cerebras: { label: 'Cerebras', absent: 'no key — /logins cerebras connects (or CEREBRAS_API_KEY)', manage: '/accounts' },
  fireworks: { label: 'Fireworks', absent: 'no key — /logins fireworks connects (or FIREWORKS_API_KEY)', manage: '/accounts' },
  qwen: { label: 'Qwen', absent: 'no key — /logins qwen connects (or DASHSCOPE_API_KEY)', manage: '/accounts' },
}


export function configRowApplicability(
  appliesTo: 'anthropic' | 'openrouter',
  route: string,
): { applies: true } | { applies: false; naText: string; refuseNote: string } {
  if (route === appliesTo) return { applies: true }
  const laneLabel = CONFIG_PROVIDER_PRESENTATION[appliesTo]?.label ?? appliesTo
  const activeLabel = CONFIG_PROVIDER_PRESENTATION[route]?.label ?? route
  return {
    applies: false,
    naText: `n/a — applies to ${laneLabel} models (${activeLabel} is active)`,
    refuseNote: `This setting only affects ${laneLabel}; the session runs on ${activeLabel} — /model switches provider.`,
  }
}

export function thinkingRowApplicability(
  model: string,
  reads?: { locked?: (id: string) => boolean; routeOf?: (id: string) => string | null; alwaysOn?: (id: string) => boolean; nameOf?: (id: string) => string },
): { applies: true } | { applies: false; naText: string; refuseNote: string } {
  const route = reads?.routeOf?.(model) ?? declaredRouteOf(model)
  if (route === 'openai') {
    return {
      applies: false,
      naText: `n/a — GPT models take the effort dial (${model} is active)`,
      refuseNote: 'GPT reasoning is the effort level; /effort sets it, and /model switches provider.',
    }
  }
  if (route === 'zai' && (reads?.locked ?? glmThinkingLocked)(model)) {
    return {
      applies: false,
      naText: `n/a — ${model} keeps thinking on`,
      refuseNote: 'This model locks thinking on at the provider; the setting cannot turn it off.',
    }
  }
  if ((reads?.alwaysOn ?? modelThinkingAlwaysOn)(model) && !modelThinkingOffIsBetweenTools(model, {})) {
    return {
      applies: false,
      naText: `n/a — ${(reads?.nameOf ?? renderModelName)(model)} keeps thinking on`,
      refuseNote: 'This model thinks on every request; the setting cannot turn it off — /effort is the lever.',
    }
  }
  return { applies: true }
}

export function mainLoopPointerText(
  effective: string | null,
  reads?: { resolvedModel?: () => string; routeOf?: (model: string) => string },
): string {
  const resolved = reads?.resolvedModel?.() ?? getEngineModel()
  const model = effective ?? resolved
  const route = reads?.routeOf?.(model) ?? declaredRouteOf(model) ?? 'unrecognised'
  const providerLabel = CONFIG_PROVIDER_PRESENTATION[route]?.label ?? route
  const modelText =
    effective !== null ? modelDisplayString(effective) : `default (${modelDisplayString(resolved)})`
  return `${providerLabel} · ${modelText} — /model`
}

export function localModelWindowRow(
  record: ReturnType<typeof localRecordFor>,
  route: string,
  _stamp?: number,
): { applies: boolean; valueText: string; note: string; setByYou: boolean; overFit: boolean; tight: boolean } {
  if (route !== 'local' || record === undefined) {
    const activeLabel = CONFIG_PROVIDER_PRESENTATION[route]?.label ?? route
    return {
      applies: false,
      valueText: `n/a — applies to local models (${activeLabel} is active)`,
      note: 'The served context window of a local model — /model picks a local model first; then ←/→ choose server default · 32k · 64k · 128k · trained max, or auto (the biggest window that fits this machine, chosen at first send and held for the session).',
      setByYou: false,
      overFit: false,
      tight: false,
    }
  }
  const setting = localWindowSettingOf(record)
  const application = localWindowApplication(record)
  const applies = application === 'request' || application === 'load'
  const refusal = applies ? localWindowRefusalWords(record, setting) : undefined
  const room = applies && refusal === undefined ? localWindowRoomWords(record, setting) : undefined
  const held = applies ? heldLocalWindow(record) : undefined
  const rule = held !== undefined && held.setting === setting && held.window !== undefined ? ` Held this session: ${held.words}.` : ''
  const note =
    application === 'server-start'
      ? `${record.id}: this server fixes its window when it starts; Mercury shows the served figure and cannot change it here.`
      : application === 'none'
        ? `${record.id}: an unknown server kind — the setting does not apply.`
        : `${record.id}: auto = ${localWindowModelfileAutoWords(record) ?? "the biggest of 32k · 64k · 128k whose projected load (weights + the KV cache of the layers that keep one, at the server's cache type and slots; the server's measured size once the model is loaded) fits the memory usable for models, never above the trained max; 256k only when you choose trained max or a number yourself — the rule /localsetup's step 5 uses"}; held for the session; a change reloads the model on the next send (the ingested prompt is read again).${refusal !== undefined ? ` The setting is saved but does not fit: ${refusal}.` : room !== undefined ? ` The setting fits this small box but leaves little room: ${room}.` : ''}${rule} ${application === 'request' ? 'Ollama takes it as num_ctx on every request.' : 'LM Studio takes it when the model is loaded.'}`
  return { applies, valueText: `${localWindowValueWords(record, setting)} · ${record.id}`, note, setByYou: applies && setting !== undefined, overFit: refusal !== undefined, tight: room !== undefined }
}

export interface ConfigProviderRow {
  id: string
  label: string
  valueText: string
  credentialed: boolean
}

export function configProviderRows(families: ProviderFamilyPresence[]): ConfigProviderRow[] {
  return families
    .map(family => {
      const meta = CONFIG_PROVIDER_PRESENTATION[family.id] ?? {
        label: family.id,
        absent: 'not connected — see /capabilities',
      }
      return {
        id: `account-${family.id}`,
        label: `${meta.label} account`,
        valueText: family.credentialed
          ? `${shownIdentityWords(family.id, String(family.credentialLabel))}${meta.manage ? ` — ${meta.manage}` : ''}`
          : meta.absent,
        credentialed: family.credentialed,
      }
    })
}
