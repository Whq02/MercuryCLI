import { execFileNoThrow } from '../utils/execFileNoThrow.js'
import { env } from '../utils/env.js'
import { getGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import { executeNotificationHooks } from '../utils/hooks/events.js'
import { tapTerminalBell } from './pings/bellTap.js'
import type { TerminalNotification } from '../ink/useTerminalNotification.js'


export const NOTIFICATION_CHANNELS = [
  'auto',
  'iterm2',
  'terminal_bell',
  'iterm2_with_bell',
  'kitty',
  'ghostty',
  'notifications_disabled',
] as const

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export type NotificationOptions = {
  message: string
  title?: string
  notificationType: string
}

export interface NotificationResolution {
  configured: string
  effective: 'iterm2' | 'iterm2_with_bell' | 'kitty' | 'ghostty' | 'terminal_bell' | 'disabled' | 'none'
  source: 'explicit-channel' | 'auto-native' | 'auto-floor' | 'disabled'
  evidence: string
}

const KNOWN_CHANNELS: ReadonlySet<string> = new Set(NOTIFICATION_CHANNELS)

export function resolveNotificationMethod(channel: string, terminalId: string): NotificationResolution {
  const configured = channel === '' ? 'auto' : channel
  if (configured !== 'auto') {
    if (configured === 'notifications_disabled') {
      return {
        configured,
        effective: 'disabled',
        source: 'disabled',
        evidence: 'notifications are switched off in settings',
      }
    }
    if (KNOWN_CHANNELS.has(configured)) {
      return {
        configured,
        effective: configured as NotificationResolution['effective'],
        source: 'explicit-channel',
        evidence: `the operator selected the ${configured} channel explicitly`,
      }
    }
    return {
      configured,
      effective: 'none',
      source: 'explicit-channel',
      evidence: `the configured channel "${configured}" is unknown; nothing will be emitted`,
    }
  }
  if (terminalId === 'Apple_Terminal') {
    return {
      configured,
      effective: 'terminal_bell',
      source: 'auto-native',
      evidence: 'Apple Terminal always bells; its own profile decides audible versus visual',
    }
  }
  if (terminalId === 'iTerm.app') {
    return {
      configured,
      effective: 'iterm2',
      source: 'auto-native',
      evidence: 'iTerm2 supports native desktop notifications',
    }
  }
  if (terminalId === 'kitty') {
    return {
      configured,
      effective: 'kitty',
      source: 'auto-native',
      evidence: 'kitty supports native desktop notifications',
    }
  }
  if (terminalId === 'ghostty') {
    return {
      configured,
      effective: 'ghostty',
      source: 'auto-native',
      evidence: 'ghostty supports native desktop notifications',
    }
  }
  return {
    configured,
    effective: 'terminal_bell',
    source: 'auto-floor',
    evidence: `no native desktop method is proven for ${terminalId === '' ? 'unknown' : terminalId}; the documented floor is the terminal bell plus the in-app attention cue`,
  }
}


let appleBellPreference: Promise<boolean> | null = null

async function lookUpAppleTerminalBellPreference(): Promise<boolean> {
  try {
    if (env.terminal !== 'Apple_Terminal') return false
    const profile = await execFileNoThrow('osascript', [
      '-e',
      'tell application "Terminal" to get name of current settings of front window',
    ])
    const profileName = profile.stdout.trim()
    if (profileName === '') return false
    const exported = await execFileNoThrow('defaults', ['export', 'com.apple.Terminal', '-'])
    if (exported.code !== 0) return false
    const plist = await import('plist')
    const parsed = plist.default.parse(exported.stdout) as {
      'Window Settings'?: Record<string, { Bell?: unknown }>
    }
    const settings = parsed['Window Settings']?.[profileName]
    if (settings === undefined) return false
    return settings.Bell === false
  } catch (err) {
    logError(err)
    return false
  }
}

export function cachedAppleTerminalBellPreference(): Promise<boolean> {
  appleBellPreference ??= lookUpAppleTerminalBellPreference()
  return appleBellPreference
}


const DEFAULT_TITLE = 'Mercury'
const KITTY_ID_BOUND = 10_000

export async function sendNotification(
  notif: NotificationOptions,
  terminal: TerminalNotification,
): Promise<string> {
  const configured = getGlobalConfig().preferredNotifChannel ?? 'auto'
  const resolution = resolveNotificationMethod(String(configured), env.terminal ?? '')
  let methodUsed: string
  try {
    switch (resolution.effective) {
      case 'iterm2':
        terminal.notifyITerm2({ message: notif.message, ...(notif.title !== undefined ? { title: notif.title } : {}) })
        methodUsed = 'iterm2'
        break
      case 'iterm2_with_bell':
        terminal.notifyITerm2({ message: notif.message, ...(notif.title !== undefined ? { title: notif.title } : {}) })
        tapTerminalBell(() => terminal.notifyBell())
        methodUsed = 'iterm2_with_bell'
        break
      case 'kitty':
        terminal.notifyKitty({
          message: notif.message,
          title: notif.title ?? DEFAULT_TITLE,
          id: Math.floor(Math.random() * KITTY_ID_BOUND),
        })
        methodUsed = 'kitty'
        break
      case 'ghostty':
        terminal.notifyGhostty({ message: notif.message, title: notif.title ?? DEFAULT_TITLE })
        methodUsed = 'ghostty'
        break
      case 'terminal_bell':
        tapTerminalBell(() => terminal.notifyBell())
        if (resolution.source === 'auto-native' && env.terminal === 'Apple_Terminal') {
          void cachedAppleTerminalBellPreference()
        }
        methodUsed = 'terminal_bell'
        break
      case 'disabled':
        methodUsed = 'disabled'
        break
      default:
        methodUsed = 'none'
        break
    }
  } catch (err) {
    logError(err)
    methodUsed = 'error'
  }
  await executeNotificationHooks({
    message: notif.message,
    ...(notif.title !== undefined ? { title: notif.title } : {}),
    notificationType: notif.notificationType,
  })
  return methodUsed
}
