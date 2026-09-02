// ============================================================================
//  src/extensions/load/channels.ts — the channel approvals. After approval,
//  a server the manifest lists under `channels` may post channel messages
//  into the session; an undeclared server's posts are dropped with a health
//  note. The approval card is the consent — no remote ledger, no per-post
//  ask.
// ============================================================================
import { activeFor } from '../active.js'
import { recordDroppedChannelPost } from '../health.js'
import { parseServerRuntimeName } from '../manifest.js'

export type ApprovedChannel = { extensionId: string; extensionName: string; label: string; runtimeName: string }

/** The channel approval for one `ext:<name>:<server>` runtime name, or null. */
export function approvedChannelFor(serverName: string): ApprovedChannel | null {
  const parsed = parseServerRuntimeName(serverName)
  if (!parsed) return null
  for (const ext of activeFor('channels')) {
    if (ext.manifest.name !== parsed.name) continue
    const channel = ext.resolution.channels.find(c => c.runtimeName === serverName)
    if (channel) return { extensionId: ext.entry.id, extensionName: ext.manifest.name, label: channel.label, runtimeName: serverName }
  }
  return null
}

/** Whether a post from this server lands; a drop is counted for the extension's health. */
export function admitChannelPost(serverName: string): boolean {
  if (approvedChannelFor(serverName)) return true
  const parsed = parseServerRuntimeName(serverName)
  if (parsed) {
    const owner = activeFor('servers').find(ext => ext.manifest.name === parsed.name)
    if (owner) recordDroppedChannelPost(owner.entry.id, serverName)
  }
  return false
}

/** Every approved channel in the session. */
export function approvedChannels(): ApprovedChannel[] {
  const out: ApprovedChannel[] = []
  for (const ext of activeFor('channels')) {
    for (const channel of ext.resolution.channels) {
      out.push({ extensionId: ext.entry.id, extensionName: ext.manifest.name, label: channel.label, runtimeName: channel.runtimeName })
    }
  }
  return out
}
