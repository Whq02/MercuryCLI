import { z } from 'zod'

import { type ChannelEntry, getAllowedChannels } from '../../bootstrap/state.js'
import { CHANNEL_TAG } from '../../constants/xml.js'
import { getClaudeAIOAuthTokens, getSubscriptionType } from '../../utils/auth.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { approvedChannelFor } from '../../extensions/load/channels.js'
import { parseServerRuntimeName } from '../../extensions/manifest.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'
import { escapeXmlAttr } from '../../utils/xml.js'
import { isChannelsEnabled } from './channelAllowlist.js'

/**
 * The channel protocol schemas, the `<channel>` message wrapper, and the
 * multi-stage gate deciding whether a server's channel handler registers.
 */

// ---------------------------------------------------------------------------
// Protocol (contract data)
// ---------------------------------------------------------------------------

export const CHANNEL_MESSAGE_METHOD = 'notifications/claude/channel'
export const CHANNEL_PERMISSION_METHOD = 'notifications/claude/channel/permission'
export const CHANNEL_PERMISSION_REQUEST_METHOD = 'notifications/claude/channel/permission_request'

export const CHANNEL_CAPABILITY_KEY = 'claude/channel'
export const CHANNEL_PERMISSION_CAPABILITY_KEY = 'claude/channel/permission'

export const ChannelMessageNotificationSchema = lazySchema(() =>
  z.object({
    method: z.literal(CHANNEL_MESSAGE_METHOD),
    params: z.object({
      content: z.string(),
      meta: z.record(z.string(), z.string()).optional(),
    }),
  }),
)

export const ChannelPermissionNotificationSchema = lazySchema(() =>
  z.object({
    method: z.literal(CHANNEL_PERMISSION_METHOD),
    params: z.object({
      request_id: z.string(),
      behavior: z.enum(['allow', 'deny']),
    }),
  }),
)

/** Sent, not validated — a type only. */
export type ChannelPermissionRequestParams = {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

// ---------------------------------------------------------------------------
// Message wrapping
// ---------------------------------------------------------------------------

/** Only identifier-shaped meta keys become attribute names. */
const SAFE_META_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

export function wrapChannelMessage(
  serverName: string,
  content: string,
  meta?: Record<string, unknown>,
): string {
  const attributes = [`source="${escapeXmlAttr(serverName)}"`]
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (!SAFE_META_KEY.test(key)) continue
    // Values are coerced to strings first: the meta reaches this code from an
    // externally written bus file where a non-string line must not stop the
    // whole bus.
    attributes.push(`${key}="${escapeXmlAttr(String(value))}"`)
  }
  return `<${CHANNEL_TAG} ${attributes.join(' ')}>\n${content}\n</${CHANNEL_TAG}>`
}

// ---------------------------------------------------------------------------
// The registration gate
// ---------------------------------------------------------------------------

export type ChannelGateResult =
  | { register: true; entry: ChannelEntry }
  | {
      register: false
      kind: 'capability' | 'disabled' | 'auth' | 'policy' | 'session' | 'approval'
      reason: string
    }

function capabilityDeclared(capabilities: unknown, key: string): boolean {
  const experimental = (capabilities as { experimental?: Record<string, unknown> } | undefined)?.experimental
  // Presence-signal idiom: any truthy value (an empty object included).
  return Boolean(experimental?.[key])
}

/** Server-kind entries match the runtime name exactly; extension entries match `ext:<name>:…`. */
export function findChannelEntry(serverName: string, channels: ChannelEntry[]): ChannelEntry | undefined {
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
  // 1. capability
  if (!capabilityDeclared(capabilities, CHANNEL_CAPABILITY_KEY)) {
    return { register: false, kind: 'capability', reason: `${serverName} did not declare the ${CHANNEL_CAPABILITY_KEY} capability` }
  }
  // 2. disabled — after capability so ordinary servers never reach it,
  // before auth/policy so the kill switch works regardless of session state.
  if (!isChannelsEnabled()) {
    return { register: false, kind: 'disabled', reason: 'channels are disabled (MERCURY_CHANNELS)' }
  }
  // 3. auth
  if (!getClaudeAIOAuthTokens()?.accessToken) {
    return { register: false, kind: 'auth', reason: 'channels require a claude.ai login — run /logins' }
  }
  // 4. policy — keyed off the subscription TIER, never off "policy settings
  // were found", so an empty policy document is still managed.
  const sub = getSubscriptionType()
  const managed = sub === 'team' || sub === 'enterprise'
  let policySettings: ReturnType<typeof getSettingsForSource> = null
  if (managed) {
    policySettings = getSettingsForSource('policySettings')
    if (policySettings?.channelsEnabled !== true) {
      return {
        register: false,
        kind: 'policy',
        reason: 'your organization has not enabled channels (managed setting channelsEnabled)',
      }
    }
  }
  // 5. an extension's server: the approval card is the consent — the
  // extension is on, its channels switch is on, and the manifest lists this
  // server under `channels`. No session flag and no remote list take part.
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
  // 6. the operator's own servers: the session's --channels selection with
  // the development bypass; nothing else admits a server-kind entry.
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
