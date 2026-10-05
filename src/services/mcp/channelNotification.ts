import { type ChannelEntry, getAllowedChannels } from '../../bootstrap/state.js'
import { CHANNEL_TAG } from '../../constants/xml.js'
import { getClaudeAIOAuthTokens, getSubscriptionType } from '../../utils/auth.js'
import { approvedChannelFor } from '../../extensions/load/channels.js'
import { parseServerRuntimeName } from '../../extensions/manifest.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'
import { escapeXmlAttr } from '../../utils/xml.js'
import { isChannelsEnabled } from './channelAllowlist.js'


export const CHANNEL_MESSAGE_METHOD = 'notifications/claude/channel'

export const CHANNEL_CAPABILITY_KEY = 'claude/channel'


const SAFE_META_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

export function wrapChannelMessage(
  serverName: string,
  content: string,
  meta?: Record<string, unknown>,
): string {
  const attributes = [`source="${escapeXmlAttr(serverName)}"`]
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (!SAFE_META_KEY.test(key)) continue
    attributes.push(`${key}="${escapeXmlAttr(String(value))}"`)
  }
  return `<${CHANNEL_TAG} ${attributes.join(' ')}>\n${content}\n</${CHANNEL_TAG}>`
}


type ChannelGateResult =
  | { register: true; entry: ChannelEntry }
  | {
      register: false
      kind: 'capability' | 'disabled' | 'auth' | 'policy' | 'session' | 'approval'
      reason: string
    }

function capabilityDeclared(capabilities: unknown, key: string): boolean {
  const experimental = (capabilities as { experimental?: Record<string, unknown> } | undefined)?.experimental
  return Boolean(experimental?.[key])
}

function findChannelEntry(serverName: string, channels: ChannelEntry[]): ChannelEntry | undefined {
  for (const entry of channels) {
    if (entry.kind === 'server') {
      if (entry.name === serverName) return entry
    } else {
      const parsed = parseServerRuntimeName(serverName)
      if (parsed && parsed.name === entry.name) return entry
    }
  }
  return undefined
}

export function gateChannelServer(
  serverName: string,
  capabilities: unknown,
  extensionSource: string | undefined,
): ChannelGateResult {
  if (!capabilityDeclared(capabilities, CHANNEL_CAPABILITY_KEY)) {
    return { register: false, kind: 'capability', reason: `${serverName} did not declare the ${CHANNEL_CAPABILITY_KEY} capability` }
  }
  if (!isChannelsEnabled()) {
    return { register: false, kind: 'disabled', reason: 'channels are disabled (MERCURY_CHANNELS)' }
  }
  if (!getClaudeAIOAuthTokens()?.accessToken) {
    return { register: false, kind: 'auth', reason: 'channels require a claude.ai login — run /logins' }
  }
  const sub = getSubscriptionType()
  const managed = sub === 'team' || sub === 'enterprise'
  let policySettings: ReturnType<typeof getSettingsForSource> = null
  if (managed) {
    policySettings = getSettingsForSource('policySettings')
    if (policySettings?.channels?.enabled !== true) {
      return {
        register: false,
        kind: 'policy',
        reason: 'your organization has not enabled channels (managed setting channels.enabled)',
      }
    }
  }
  const parsed = parseServerRuntimeName(serverName)
  if (parsed) {
    const approved = approvedChannelFor(serverName)
    if (!approved) {
      return {
        register: false,
        kind: 'approval',
        reason: `${serverName} is not declared under channels by an approved extension${extensionSource ? ` (${extensionSource})` : ''}`,
      }
    }
    return { register: true, entry: { kind: 'extension', name: parsed.name, label: approved.label } }
  }
  const entry = findChannelEntry(serverName, getAllowedChannels())
  if (entry === undefined) {
    return {
      register: false,
      kind: 'session',
      reason: `${serverName} is not in this session's --channels selection`,
    }
  }
  if (!entry.dev) {
    return {
      register: false,
      kind: 'approval',
      reason: `${serverName} is a server-kind selection; only an approved extension's declared channels register (use --dangerously-load-development-channels for development)`,
    }
  }
  return { register: true, entry }
}
