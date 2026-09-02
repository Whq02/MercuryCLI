
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getCwd } from './cwd.js'
import { withState, type Snapshot } from './cockpit/types.js'

export interface SovereignFlag {
  enabled: boolean
  ts?: string
}

export interface BypassData {
  bypassOn: boolean
  lastChanged?: string
  via: 'mode' | 'flag' | 'mode+flag' | 'none'
}

export type BypassSnapshot = Snapshot<{ data: BypassData }>

export function readSovereignFlag(): SovereignFlag {
  try {
    const path = join(getCwd(), 'harness', 'sovereign.json')
    if (!existsSync(path)) return { enabled: false }
    const raw = readFileSync(path, { encoding: 'utf8' })
    const parsed = JSON.parse(raw) as { enabled?: unknown; ts?: unknown }
    return {
      enabled: parsed.enabled === true,
      ...(typeof parsed.ts === 'string' ? { ts: parsed.ts } : {}),
    }
  } catch {
    return { enabled: false }
  }
}

export function bypassAge(ts: string | undefined): string {
  if (!ts) return ''
  const ms = Date.now() - Date.parse(ts)
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const s = Math.round(ms / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function bypassSnapshot(opts?: { bypassMode?: string }): BypassSnapshot {
  try {
    const liveMode =
      opts?.bypassMode === 'sovereign' || opts?.bypassMode === 'autopilot'
    const flag = readSovereignFlag()
    const enabled = liveMode || flag.enabled
    const via: BypassData['via'] =
      liveMode && flag.enabled ? 'mode+flag' : liveMode ? 'mode' : flag.enabled ? 'flag' : 'none'
    return {
      state: enabled ? 'blocked' : 'off',
      source: 'toolPermissionContext + harness/sovereign.json',
      reason: enabled
        ? 'tool-permission prompts are being auto-allowed'
        : 'permission prompts active (safe default)',
      data: {
        bypassOn: enabled,
        ...(flag.ts ? { lastChanged: flag.ts } : {}),
        via,
      },
    }
  } catch {
    return withState(
      'off',
      { bypassOn: false, via: 'none' as const },
      'bypass state unreadable — assuming prompts active',
      'permissionBypassBridge',
    )
  }
}
