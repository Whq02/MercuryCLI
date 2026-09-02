import { activeFor } from '../active.js'
import { recordDroppedChannelPost } from '../health.js'
import { parseServerRuntimeName } from '../manifest.js'

export type ApprovedChannel = { extensionId: string; extensionName: string; label: string; runtimeName: string }

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

export function admitChannelPost(serverName: string): boolean {
  if (approvedChannelFor(serverName)) return true
  const parsed = parseServerRuntimeName(serverName)
  if (parsed) {
    const owner = activeFor('servers').find(ext => ext.manifest.name === parsed.name)
    if (owner) recordDroppedChannelPost(owner.entry.id, serverName)
  }
  return false
}

export function approvedChannels(): ApprovedChannel[] {
  const out: ApprovedChannel[] = []
  for (const ext of activeFor('channels')) {
    for (const channel of ext.resolution.channels) {
      out.push({ extensionId: ext.entry.id, extensionName: ext.manifest.name, label: channel.label, runtimeName: channel.runtimeName })
    }
  }
  return out
}
