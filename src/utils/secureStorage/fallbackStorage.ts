import type { SecureStorage, SecureStorageData } from './types.js'

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
      const previouslyHeld = primary.read()
      const primaryResult = primary.update(data)
      if (primaryResult.success) {
        if (previouslyHeld === null) {
          secondary.delete()
        }
        return primaryResult
      }
      const secondaryResult = secondary.update(data)
      if (secondaryResult.success) {
        if (previouslyHeld !== null) {
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
