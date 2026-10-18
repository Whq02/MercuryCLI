import { readStoredQwenApiKey, readStoredQwenKeyBase } from '../providerSecrets.js'
import { resolveProviderKeyCommand } from '../providerKeyCommand.js'
import { credentialFingerprint } from '../credentialIdentity.js'

export const QWEN_ENV_KEY = 'DASHSCOPE_API_KEY'
export const QWEN_BASE_OVERRIDE_ENV = 'DASHSCOPE_BASE_URL'
const QWEN_WORKSPACE_ENV = 'DASHSCOPE_WORKSPACE_ID'
const QWEN_PROBE_SEAM_ENV = 'MERCURY_QWEN_API_BASE'

type QwenPlan = 'pay-as-you-go' | 'coding-plan' | 'token-plan'

export interface QwenEndpoint {
  id: string
  label: string
  plan: QwenPlan
  baseUrl: string
}

export const QWEN_SHARED_ENDPOINTS: readonly QwenEndpoint[] = [
  { id: 'singapore', label: 'International (Singapore)', plan: 'pay-as-you-go', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
  { id: 'beijing', label: 'China (Beijing)', plan: 'pay-as-you-go', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'hongkong', label: 'China (Hong Kong)', plan: 'pay-as-you-go', baseUrl: 'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'coding-intl', label: 'Coding Plan (international)', plan: 'coding-plan', baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1' },
  { id: 'coding-cn', label: 'Coding Plan (China)', plan: 'coding-plan', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1' },
  { id: 'token-plan-intl', label: 'Token Plan (Singapore)', plan: 'token-plan', baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' },
  { id: 'token-plan-cn', label: 'Token Plan (Beijing)', plan: 'token-plan', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' },
]

const WORKSPACE_REGIONS: readonly { id: string; label: string; region: string }[] = [
  { id: 'workspace-singapore', label: 'International (Singapore) workspace', region: 'ap-southeast-1' },
  { id: 'workspace-virginia', label: 'US (Virginia) workspace', region: 'us-east-1' },
  { id: 'workspace-beijing', label: 'China (Beijing) workspace', region: 'cn-beijing' },
  { id: 'workspace-hongkong', label: 'China (Hong Kong) workspace', region: 'cn-hongkong' },
  { id: 'workspace-frankfurt', label: 'Germany (Frankfurt) workspace', region: 'eu-central-1' },
  { id: 'workspace-tokyo', label: 'Japan (Tokyo) workspace', region: 'ap-northeast-1' },
]

function qwenWorkspaceId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[QWEN_WORKSPACE_ENV]?.trim().toLowerCase()
  return raw && /^[a-z0-9][a-z0-9-]{0,63}$/.test(raw) ? raw : undefined
}

function probeSeam(env: NodeJS.ProcessEnv): string | undefined {
  const seam = env[QWEN_PROBE_SEAM_ENV]?.trim()
  return seam ? seam.replace(/\/+$/, '') : undefined
}

export function qwenEndpointBase(endpoint: QwenEndpoint, env: NodeJS.ProcessEnv = process.env): string {
  const seam = probeSeam(env)
  return seam ? `${seam}/${endpoint.id}` : endpoint.baseUrl
}

export function qwenProbeEndpoints(env: NodeJS.ProcessEnv = process.env): QwenEndpoint[] {
  const workspace = qwenWorkspaceId(env)
  const dedicated = workspace
    ? WORKSPACE_REGIONS.map(row => ({ id: row.id, label: row.label, plan: 'pay-as-you-go' as const, baseUrl: `https://${workspace}.${row.region}.maas.aliyuncs.com/compatible-mode/v1` }))
    : []
  return [...dedicated, ...QWEN_SHARED_ENDPOINTS]
}

function qwenEndpointForBase(baseUrl: string, env: NodeJS.ProcessEnv = process.env): QwenEndpoint | undefined {
  const wanted = baseUrl.replace(/\/+$/, '')
  return qwenProbeEndpoints(env).find(endpoint => qwenEndpointBase(endpoint, env) === wanted)
}

export function qwenEndpointLabelOf(baseUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  return qwenEndpointForBase(baseUrl, env)?.label ?? baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

export function qwenBaseOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[QWEN_BASE_OVERRIDE_ENV]?.trim()
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (!(url.protocol === 'https:' || url.protocol === 'http:') || url.username || url.password || url.search || url.hash) return undefined
  } catch {
    return undefined
  }
  return raw.replace(/\/+$/, '')
}

export function qwenEnvKey(env: NodeJS.ProcessEnv = process.env): { key: string; name: typeof QWEN_ENV_KEY } | undefined {
  const key = env[QWEN_ENV_KEY]?.trim()
  return key ? { key, name: QWEN_ENV_KEY } : undefined
}

function resolveQwenApiKey(env: NodeJS.ProcessEnv = process.env): { key: string; source: 'env' | 'stored' } | undefined {
  const key = qwenEnvKey(env)
  if (key) return { key: key.key, source: 'env' }
  const fromCommand = resolveProviderKeyCommand('qwen')
  if (fromCommand) return { key: fromCommand, source: 'stored' }
  const stored = readStoredQwenApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

const boundBases = new Map<string, string>()

function qwenBindingIdentity(key: string): string {
  return credentialFingerprint(key)
}

export function rememberQwenBoundBase(key: string, baseUrl: string): void {
  boundBases.set(qwenBindingIdentity(key), baseUrl.replace(/\/+$/, ''))
}

export function forgetQwenBoundBases(): void {
  boundBases.clear()
}

export function qwenBoundBase(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = qwenBaseOverride(env)
  if (override) return override
  const key = resolveQwenApiKey(env)
  if (!key) return undefined
  const remembered = boundBases.get(qwenBindingIdentity(key.key))
  if (remembered) return remembered
  if (key.source === 'stored' && readStoredQwenApiKey() === key.key) {
    const stored = readStoredQwenKeyBase()
    if (stored) return stored
  }
  return undefined
}

function qwenApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return qwenBoundBase(env) ?? qwenEndpointBase(QWEN_SHARED_ENDPOINTS[0]!, env)
}

export function qwenChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${qwenApiBase(env)}/chat/completions`
}

export function qwenBoundEndpointLabel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const base = qwenBoundBase(env)
  return base === undefined ? undefined : qwenEndpointLabelOf(base, env)
}

export type QwenCredentialSource = 'env' | 'stored'

interface QwenAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveQwenAccount(env: NodeJS.ProcessEnv = process.env): QwenAccountRef | undefined {
  const key = resolveQwenApiKey(env)
  return key ? { kind: 'api-key', label: key.source === 'env' ? `${QWEN_ENV_KEY} (env)` : 'Model Studio API key (stored, auth-scoped)', keySource: key.source } : undefined
}

export function resolveQwenCredentialSnapshot(env: NodeJS.ProcessEnv = process.env): { key: string; source: QwenCredentialSource } | undefined {
  return resolveQwenApiKey(env)
}

interface QwenDispatchCredential {
  apiKey: string
  source: QwenCredentialSource
  requestUrl: string
}

export async function resolveQwenCredential(io?: { env?: NodeJS.ProcessEnv }): Promise<QwenDispatchCredential | undefined> {
  const env = io?.env ?? process.env
  const key = resolveQwenApiKey(env)
  return key ? { apiKey: key.key, source: key.source, requestUrl: qwenChatCompletionsUrl(env) } : undefined
}

function qwenEndpointListWords(env: NodeJS.ProcessEnv = process.env): string {
  return qwenProbeEndpoints(env).map(endpoint => endpoint.label).join(' · ')
}

export function qwenUnboundKeyRefusal(env: NodeJS.ProcessEnv = process.env): string {
  return `this key belongs to no Model Studio region or plan Mercury knows — it was minted for none of: ${qwenEndpointListWords(env)}; ${QWEN_BASE_OVERRIDE_ENV} names the endpoint it was minted for (a workspace-dedicated domain needs ${QWEN_WORKSPACE_ENV} or the full URL)`
}
