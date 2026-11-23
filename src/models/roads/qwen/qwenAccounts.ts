import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { readStoredQwenApiKey, readStoredQwenKeyBase } from '../../sign-in/account-ledger/providerSecrets.js'
import { resolveProviderKeyCommand } from '../providerKeyCommand.js'
import { credentialFingerprint } from '../../sign-in/account-ledger/credentialIdentity.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

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
  { id: 'qwencloud-token-plan', label: 'QwenCloud Token Plan', plan: 'token-plan', baseUrl: 'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1' },
  { id: 'qwencloud', label: 'QwenCloud (pay-as-you-go)', plan: 'pay-as-you-go', baseUrl: 'https://maas.qwencloudapi.com/compatible-mode/v1' },
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

function qwenWorkspaceId(env: NodeJS.ProcessEnv = hostEnv()): string | undefined {
  const raw = env[QWEN_WORKSPACE_ENV]?.trim().toLowerCase()
  return raw && /^[a-z0-9][a-z0-9-]{0,63}$/.test(raw) ? raw : undefined
}

function probeSeam(env: NodeJS.ProcessEnv): string | undefined {
  const seam = flagEnv(QWEN_PROBE_SEAM_ENV, env)?.trim()
  return seam ? seam.replace(/\/+$/, '') : undefined
}

export function qwenEndpointBase(endpoint: QwenEndpoint, env: NodeJS.ProcessEnv = hostEnv()): string {
  const seam = probeSeam(env)
  return seam ? `${seam}/${endpoint.id}` : endpoint.baseUrl
}

export function qwenProbeEndpoints(env: NodeJS.ProcessEnv = hostEnv()): QwenEndpoint[] {
  const workspace = qwenWorkspaceId(env)
  const dedicated = workspace
    ? WORKSPACE_REGIONS.map(row => ({ id: row.id, label: row.label, plan: 'pay-as-you-go' as const, baseUrl: `https://${workspace}.${row.region}.maas.aliyuncs.com/compatible-mode/v1` }))
    : []
  return [...dedicated, ...QWEN_SHARED_ENDPOINTS]
}

const QWEN_CODING_PLAN_KEY_PREFIX = 'sk-sp-'

function qwenKeyIsCodingPlan(key: string): boolean {
  return key.trim().toLowerCase().startsWith(QWEN_CODING_PLAN_KEY_PREFIX)
}

export function qwenProbeLane(key: string, env: NodeJS.ProcessEnv = hostEnv()): QwenEndpoint[] {
  const coding = qwenKeyIsCodingPlan(key)
  return qwenProbeEndpoints(env).filter(endpoint => (endpoint.id === 'qwencloud-token-plan' || endpoint.plan === 'coding-plan') === coding)
}

function qwenEndpointForBase(baseUrl: string, env: NodeJS.ProcessEnv = hostEnv()): QwenEndpoint | undefined {
  const wanted = baseUrl.replace(/\/+$/, '')
  const listed = qwenProbeEndpoints(env).find(endpoint => qwenEndpointBase(endpoint, env) === wanted)
  if (listed) return listed
  const workspace = /^https:\/\/([a-z0-9][a-z0-9-]{0,63})\.([a-z0-9-]+)\.maas\.aliyuncs\.com\/compatible-mode\/v1$/.exec(wanted)
  const region = workspace ? WORKSPACE_REGIONS.find(row => row.region === workspace[2]) : undefined
  return region ? { id: region.id, label: region.label, plan: 'pay-as-you-go', baseUrl: wanted } : undefined
}

export function qwenListAnswersEveryCaller(baseUrl: string, env: NodeJS.ProcessEnv = hostEnv()): boolean {
  return qwenEndpointForBase(baseUrl, env)?.plan === 'coding-plan'
}

export function qwenEndpointLabelOf(baseUrl: string, env: NodeJS.ProcessEnv = hostEnv()): string {
  return qwenEndpointForBase(baseUrl, env)?.label ?? baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

export type QwenConsole = 'QwenCloud' | 'Model Studio'
export const QWEN_CONSOLES = 'QwenCloud or Model Studio'

function qwenEndpointConsole(endpoint: QwenEndpoint): QwenConsole {
  return endpoint.id === 'qwencloud' || endpoint.id === 'qwencloud-token-plan' ? 'QwenCloud' : 'Model Studio'
}

export function qwenConsoleOfBase(baseUrl: string | undefined, env: NodeJS.ProcessEnv = hostEnv()): QwenConsole | undefined {
  const endpoint = baseUrl === undefined ? undefined : qwenEndpointForBase(baseUrl, env)
  return endpoint === undefined ? undefined : qwenEndpointConsole(endpoint)
}

export function qwenConsoleWords(origin: QwenConsole | undefined): string {
  return origin ?? QWEN_CONSOLES
}

export function qwenConsolePage(origin: QwenConsole | undefined): string {
  if (origin === 'QwenCloud') return 'qwencloud.com'
  if (origin === 'Model Studio') return 'modelstudio.console.alibabacloud.com (Usage & Billing)'
  return 'qwencloud.com or modelstudio.console.alibabacloud.com (Usage & Billing)'
}

export function qwenEndpointWhere(baseUrl: string, env: NodeJS.ProcessEnv = hostEnv()): string {
  const endpoint = qwenEndpointForBase(baseUrl, env)
  if (endpoint === undefined) return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return qwenEndpointConsole(endpoint) === 'QwenCloud' ? endpoint.label : `Model Studio ${endpoint.label}`
}

export function qwenBaseOverrideSkipped(env: NodeJS.ProcessEnv = hostEnv()): string | undefined {
  const raw = env[QWEN_BASE_OVERRIDE_ENV]?.trim()
  if (!raw || qwenBaseOverride(env) !== undefined) return undefined
  try {
    new URL(raw)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return 'an http(s) URL without credentials, query or fragment is needed'
}

export function qwenBaseOverride(env: NodeJS.ProcessEnv = hostEnv()): string | undefined {
  const raw = env[QWEN_BASE_OVERRIDE_ENV]?.trim()
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (!(url.protocol === 'https:' || url.protocol === 'http:') || url.username || url.password || url.search || url.hash) return undefined
  } catch (error) {
    passedOver(error)
    return undefined
  }
  return raw.replace(/\/+$/, '')
}

export function qwenEnvKey(env: NodeJS.ProcessEnv = hostEnv()): { key: string; name: typeof QWEN_ENV_KEY } | undefined {
  const key = env[QWEN_ENV_KEY]?.trim()
  return key ? { key, name: QWEN_ENV_KEY } : undefined
}

function resolveQwenApiKey(env: NodeJS.ProcessEnv = hostEnv()): { key: string; source: 'env' | 'stored' } | undefined {
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

export function qwenBoundBase(env: NodeJS.ProcessEnv = hostEnv()): string | undefined {
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

function qwenApiBase(env: NodeJS.ProcessEnv = hostEnv()): string {
  return qwenBoundBase(env) ?? qwenEndpointBase(QWEN_SHARED_ENDPOINTS[0]!, env)
}

export function qwenChatCompletionsUrl(env: NodeJS.ProcessEnv = hostEnv()): string {
  return `${qwenApiBase(env)}/chat/completions`
}

export function qwenPricingRegion(env: NodeJS.ProcessEnv = hostEnv()): 'singapore' | 'beijing' | 'hongkong' | 'frankfurt' | 'virginia' | 'tokyo' | undefined {
  const base = qwenBoundBase(env)
  const endpoint = base === undefined ? undefined : qwenEndpointForBase(base, env)
  if (endpoint?.plan !== 'pay-as-you-go') return undefined
  const region = endpoint.id.replace(/^workspace-/, '')
  switch (region) {
    case 'singapore':
    case 'beijing':
    case 'hongkong':
    case 'frankfurt':
    case 'virginia':
    case 'tokyo':
      return region
    default:
      return undefined
  }
}

export function qwenBoundEndpointLabel(env: NodeJS.ProcessEnv = hostEnv()): string | undefined {
  const base = qwenBoundBase(env)
  return base === undefined ? undefined : qwenEndpointLabelOf(base, env)
}

export function qwenBoundConsole(env: NodeJS.ProcessEnv = hostEnv()): QwenConsole | undefined {
  return qwenConsoleOfBase(qwenBoundBase(env), env)
}

export function qwenBoundPlanLabel(env: NodeJS.ProcessEnv = hostEnv()): { kind: 'Coding Plan' | 'QwenCloud Token Plan'; endpoint: string } | undefined {
  const base = qwenBoundBase(env)
  if (base === undefined) return undefined
  const endpoint = qwenEndpointForBase(base, env)
  if (endpoint?.plan === 'coding-plan') return { kind: 'Coding Plan', endpoint: endpoint.label }
  if (endpoint?.id === 'qwencloud-token-plan') return { kind: 'QwenCloud Token Plan', endpoint: endpoint.label }
  return undefined
}

export type QwenCredentialSource = 'env' | 'stored'

interface QwenAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveQwenAccount(env: NodeJS.ProcessEnv = hostEnv()): QwenAccountRef | undefined {
  const key = resolveQwenApiKey(env)
  if (!key) return undefined
  const plan = qwenBoundPlanLabel(env)
  return { kind: 'api-key', label: key.source === 'env' ? `${QWEN_ENV_KEY} (env${plan ? `, ${plan.kind}` : ''})` : plan?.kind === 'QwenCloud Token Plan' ? 'QwenCloud Token Plan key (stored, auth-scoped)' : plan ? `Model Studio ${plan.kind} key (stored, auth-scoped)` : `${qwenConsoleWords(qwenBoundConsole(env))} API key (stored, auth-scoped)`, keySource: key.source }
}

export function resolveQwenCredentialSnapshot(env: NodeJS.ProcessEnv = hostEnv()): { key: string; source: QwenCredentialSource } | undefined {
  return resolveQwenApiKey(env)
}

interface QwenDispatchCredential {
  apiKey: string
  source: QwenCredentialSource
  requestUrl: string
}

export async function resolveQwenCredential(io?: { env?: NodeJS.ProcessEnv }): Promise<QwenDispatchCredential | undefined> {
  const env = io?.env ?? hostEnv()
  const key = resolveQwenApiKey(env)
  return key ? { apiKey: key.key, source: key.source, requestUrl: qwenChatCompletionsUrl(env) } : undefined
}

function qwenEndpointListWords(env: NodeJS.ProcessEnv = hostEnv(), key?: string): string {
  return (key === undefined ? qwenProbeEndpoints(env) : qwenProbeLane(key, env)).map(endpoint => endpoint.label).join(' · ')
}

export function qwenUnboundKeyRefusal(env: NodeJS.ProcessEnv = hostEnv(), key?: string): string {
  const lane = key === undefined ? '' : qwenKeyIsCodingPlan(key) ? ` (a key beginning ${QWEN_CODING_PLAN_KEY_PREFIX} is a Token Plan or Coding Plan key, read on the QwenCloud Token Plan and the Coding Plan endpoints)` : ` (a Coding Plan key begins ${QWEN_CODING_PLAN_KEY_PREFIX}; this one does not, so the Coding Plan endpoints were not asked)`
  return `this key belongs to no ${QWEN_CONSOLES} region or plan Mercury knows — it was minted for none of: ${qwenEndpointListWords(env, key)}${lane}; ${QWEN_BASE_OVERRIDE_ENV} names the endpoint it was minted for (a workspace-dedicated domain needs ${QWEN_WORKSPACE_ENV} or the full URL)`
}
