
import type { Notification } from '../../context/notifications.js'
import { getGlobalConfig } from '../../utils/config.js'
import { useStartupNotification } from './useStartupNotification.js'

const RECENT_WINDOW_MS = 3000

type MigrationEntry = {
  read(config: ReturnType<typeof getGlobalConfig>): {
    timestamp: number | undefined
    variant?: 'legacy-remap'
  }
  build(variant: 'legacy-remap' | undefined): Notification
}

const MIGRATION_TABLE: MigrationEntry[] = [
  {
    read: config => ({ timestamp: config.sonnet45To46MigrationTimestamp }),
    build: () => ({
      key: 'sonnet-46-update',
      text: 'Model updated to Sonnet 4.6.',
      color: 'suggestion',
      priority: 'high',
      timeoutMs: 3000,
    }),
  },
  {
    read: config =>
      config.legacyOpusMigrationTimestamp !== undefined
        ? {
            timestamp: config.legacyOpusMigrationTimestamp,
            variant: 'legacy-remap',
          }
        : { timestamp: config.opusProMigrationTimestamp },
    build: variant =>
      variant === 'legacy-remap'
        ? {
            key: 'opus-pro-update',
            text: 'Pinned legacy Opus model remapped to Opus 4.6 — pin a supported model with /model to change it.',
            color: 'suggestion',
            priority: 'high',
            timeoutMs: 8000,
          }
        : {
            key: 'opus-pro-update',
            text: 'Model updated to Opus 4.6.',
            color: 'suggestion',
            priority: 'high',
            timeoutMs: 3000,
          },
  },
]

export function useModelMigrationNotifications(): void {
  useStartupNotification(() => {
    const config = getGlobalConfig()
    const now = Date.now()
    const notifications: Notification[] = []
    for (const entry of MIGRATION_TABLE) {
      const { timestamp, variant } = entry.read(config)
      if (timestamp === undefined) continue
      if (now - timestamp > RECENT_WINDOW_MS) continue
      notifications.push(entry.build(variant))
    }
    return notifications.length > 0 ? notifications : null
  })
}
