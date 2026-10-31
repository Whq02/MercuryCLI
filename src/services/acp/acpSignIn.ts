import { randomUUID } from 'node:crypto'
import { RequestError, methods } from '@agentclientprotocol/sdk'
import type { AgentContext, AuthMethod } from '@agentclientprotocol/sdk'
import { installOAuthTokens } from '../../cli/handlers/auth.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { OAuthService } from '../oauth/index.js'
import { refreshLocalDiscovery } from '../providers/local/localDiscovery.js'
import { anyProviderCredentialed } from '../providers/providerUsage.js'
import { providerDisplayName } from '../providers/routeLaw.js'
import { runHuggingfaceDeviceLogin } from '../providers/huggingface/huggingfaceLogin.js'
import { runMetaDeviceLogin } from '../providers/meta/metaLogin.js'
import { runKimiDeviceLogin } from '../providers/moonshot/moonshotLogin.js'
import { runNousDeviceLogin } from '../providers/nous/nousLogin.js'
import { runOrcarouterDeviceLogin } from '../providers/orcarouter/orcarouterLogin.js'
import { runXaiDeviceLogin } from '../providers/xai/xaiLogin.js'

export const ACP_LOGIN_FLAG = '--login'
const ACP_TERMINAL_METHOD_ID = 'terminal'
const ACP_CLAUDE_METHOD_ID = 'claude'

export const ACP_DEVICE_FAMILIES = ['moonshot', 'huggingface', 'xai', 'meta', 'nous', 'orcarouter'] as const
type AcpDeviceFamily = (typeof ACP_DEVICE_FAMILIES)[number]

export interface AcpClientAuthFacts {
  terminalAuth: boolean
  urlElicitation: boolean
}

interface DeviceCodeStart {
  verificationUri: string
  userCode: string
  verificationUriComplete?: string
}

export interface AcpSignInRoads {
  claude: (io: { showUrl: (url: string) => boolean; signal: AbortSignal }) => Promise<void>
  device: (family: AcpDeviceFamily, io: { onCode: (start: DeviceCodeStart) => void; cancelled: () => boolean }) => Promise<{ ok: boolean; receipt: string }>
}

export function acpClientAuthFacts(clientCapabilities: unknown): AcpClientAuthFacts {
  const caps = (clientCapabilities ?? {}) as { auth?: { terminal?: unknown } | null; _meta?: Record<string, unknown> | null; elicitation?: { url?: unknown } | null }
  const terminalAuth = caps.auth?.terminal === true || caps._meta?.['terminal-auth'] === true
  const urlElicitation = caps.elicitation?.url !== undefined && caps.elicitation?.url !== null
  return { terminalAuth, urlElicitation }
}

function claudeMethodName(): string {
  return getInitialSettings().credentials?.signInRoute === 'console' ? 'Anthropic Console' : 'Claude subscription'
}

export function acpAuthMethods(facts: AcpClientAuthFacts): AuthMethod[] {
  const out: AuthMethod[] = []
  if (facts.terminalAuth) {
    out.push({
      id: ACP_TERMINAL_METHOD_ID,
      name: 'Sign in from a terminal',
      description: 'Mercury opens its sign-in screen in a terminal: pick a provider and finish there.',
      type: 'terminal',
      args: [ACP_LOGIN_FLAG],
    })
  }
  out.push({ id: ACP_CLAUDE_METHOD_ID, name: claudeMethodName(), description: 'Opens the sign-in page in your browser.' })
  if (facts.urlElicitation) {
    for (const family of ACP_DEVICE_FAMILIES) {
      out.push({ id: family, name: `${providerDisplayName(family)} device code`, description: 'Shows a sign-in link and a code to enter there.' })
    }
  }
  return out
}

function acpAuthMethodIds(facts: AcpClientAuthFacts): string[] {
  return acpAuthMethods(facts).map(method => method.id)
}

export async function acpSignInRequired(): Promise<boolean> {
  if (anyProviderCredentialed()) return false
  const local = await refreshLocalDiscovery().catch(() => null)
  return !(local !== null && local.servers.some(server => server.models.length > 0))
}

export function acpAuthRequiredError(facts: AcpClientAuthFacts): RequestError {
  const ids = acpAuthMethodIds(facts)
  return RequestError.authRequired({ authMethods: ids }, `sign in first (${ids.join(', ')})`)
}

async function claudeRoad(io: { showUrl: (url: string) => boolean; signal: AbortSignal }): Promise<void> {
  const credentials = getInitialSettings().credentials
  const forced = credentials?.signInRoute
  const service = new OAuthService()
  let shown = false
  let fail: (reason: Error) => void = () => {}
  const gate = new Promise<never>((_, reject) => {
    fail = reject
  })
  const onAbort = (): void => {
    service.cleanup()
    fail(new Error('sign-in cancelled'))
  }
  io.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const tokens = await Promise.race([
      service.startOAuthFlow(
        autoUrl => {
          shown = io.showUrl(autoUrl)
        },
        {
          loginWithClaudeAi: forced ? forced === 'claudeai' : true,
          ...(credentials?.organisation ? { orgUUID: credentials.organisation } : {}),
          onBrowserOpen: opened => {
            if (!opened && !shown) {
              service.cleanup()
              fail(new Error('the browser did not open — sign in from a terminal'))
            }
          },
        },
      ),
      gate,
    ])
    await installOAuthTokens(tokens)
  } finally {
    io.signal.removeEventListener('abort', onAbort)
    service.cleanup()
  }
}

type DeviceRun = (io: { cancelled: () => boolean; onEvent: (event: { phase: string; start?: DeviceCodeStart; polls?: number }) => void }) => Promise<{ ok: boolean; receipt: string }>

const DEVICE_RUNS: Record<AcpDeviceFamily, DeviceRun> = {
  moonshot: io => runKimiDeviceLogin({ region: 'global', ...io }),
  huggingface: io => runHuggingfaceDeviceLogin(io),
  xai: io => runXaiDeviceLogin(io),
  meta: io => runMetaDeviceLogin(io),
  nous: io => runNousDeviceLogin(io),
  orcarouter: io => runOrcarouterDeviceLogin(io),
}

function deviceRoad(family: AcpDeviceFamily, io: { onCode: (start: DeviceCodeStart) => void; cancelled: () => boolean }): Promise<{ ok: boolean; receipt: string }> {
  return DEVICE_RUNS[family]({
    cancelled: io.cancelled,
    onEvent: event => {
      if (event.phase === 'waiting' && event.polls === 0 && event.start !== undefined) io.onCode(event.start)
    },
  })
}

const ACP_SIGN_IN_ROADS: AcpSignInRoads = { claude: claudeRoad, device: deviceRoad }

function isDeviceFamily(id: string): id is AcpDeviceFamily {
  return (ACP_DEVICE_FAMILIES as readonly string[]).includes(id)
}

function urlElicitation(client: AgentContext, requestId: string | number | null, elicitationId: string, url: string, message: string): Promise<boolean> {
  return client
    .request(methods.client.elicitation.create, { mode: 'url', url, elicitationId, requestId, message } as never)
    .then(result => (result as { action?: unknown } | null)?.action === 'accept')
    .catch(() => false)
}

export async function acpAuthenticate(
  ctx: { params: { methodId: string }; requestId: string | number | null; signal: AbortSignal; client: AgentContext },
  facts: AcpClientAuthFacts,
  roads: AcpSignInRoads = ACP_SIGN_IN_ROADS,
): Promise<void> {
  const methodId = ctx.params.methodId
  const ids = acpAuthMethodIds(facts)
  if (methodId === ACP_TERMINAL_METHOD_ID && facts.terminalAuth) {
    throw RequestError.invalidParams({ methodId }, `the terminal method is not called through authenticate — start \`mercury acp ${ACP_LOGIN_FLAG}\` in a terminal`)
  }
  if (!ids.includes(methodId)) {
    throw RequestError.invalidParams({ methodId }, `unknown sign-in method '${methodId}' — methods: ${ids.join(', ')}`)
  }
  if (methodId === ACP_CLAUDE_METHOD_ID) {
    const elicitationId = randomUUID()
    let shown = false
    try {
      await roads.claude({
        signal: ctx.signal,
        showUrl: url => {
          if (!facts.urlElicitation) return false
          shown = true
          void urlElicitation(ctx.client, ctx.requestId, elicitationId, url, 'Finish signing in on the page that opens.')
          return true
        },
      })
    } catch (error) {
      throw new RequestError(-32000, error instanceof Error ? error.message : String(error))
    } finally {
      if (shown) void ctx.client.notify(methods.client.elicitation.complete, { elicitationId })
    }
    return
  }
  if (isDeviceFamily(methodId)) {
    const elicitationId = randomUUID()
    let shown = false
    let cancelled = false
    const outcome = await roads.device(methodId, {
      cancelled: () => cancelled || ctx.signal.aborted,
      onCode: start => {
        if (shown) return
        shown = true
        void urlElicitation(ctx.client, ctx.requestId, elicitationId, start.verificationUriComplete ?? start.verificationUri, `Enter code ${start.userCode} at ${start.verificationUri}`).then(accepted => {
          if (!accepted) cancelled = true
        })
      },
    })
    if (shown) void ctx.client.notify(methods.client.elicitation.complete, { elicitationId })
    if (!outcome.ok) throw new RequestError(-32000, outcome.receipt)
  }
}
