import type { SecureStorage, SecureStorageData } from './types.js'

/**
 * Composes a primary and a secondary credential store into one. The
 * composed reads never return null (asymmetry with the underlying stores,
 * which can).
 */
export function createFallbackStorage(primary: SecureStorage, secondary: SecureStorage): SecureStorage {
  return {
    name: `${primary.name}-with-${secondary.name}-fallback`,

    read(): SecureStorageData {
      const primaryData = primary.read()
      if (primaryData !== null && primaryData !== undefined) return primaryData
      return secondary.read() ?? {}
    },

    async readAsync(): Promise<SecureStorageData> {
      const primaryData = await primary.readAsync()
      if (primaryData !== null && primaryData !== undefined) return primaryData
      return (await secondary.readAsync()) ?? {}
    },

    update(data: SecureStorageData): { success: boolean; warning?: string } {
      // Captured BEFORE writing; both branches compare it against null
      // STRICTLY — an undefined primary read does not count as "held
      // nothing".
      const previouslyHeld = primary.read()
      const primaryResult = primary.update(data)
      if (primaryResult.success) {
        if (previouslyHeld === null) {
          // First migration into the primary: delete the secondary. This
          // preserves credentials when a config home is shared between a
          // host and containers.
          secondary.delete()
        }
        return primaryResult
      }
      const secondaryResult = secondary.update(data)
      if (secondaryResult.success) {
        if (previouslyHeld !== null) {
          // Reads prefer the primary whenever it answers, so a stale
          // primary entry would shadow the freshly written secondary — an
          // old refresh token served in preference to the new one bounces
          // the user back to login on every attempt. Best-effort.
          primary.delete()
        }
        return {
          success: true,
          ...(secondaryResult.warning !== undefined ? { warning: secondaryResult.warning } : {}),
        }
      }
      return { success: false }
    },

    delete(): boolean {
      const primaryDeleted = primary.delete()
      const secondaryDeleted = secondary.delete()
      return primaryDeleted || secondaryDeleted
    },
  }
}
