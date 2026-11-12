import { plainTextStorage } from './plainTextStorage.js'
import { createSealedFileStorage } from './sealedFileStorage.js'
import { createKeyCustody } from './sealedRecord.js'
import type { SecureStorage, SystemProtector } from './types.js'

const sealedStorages = new WeakMap<SystemProtector, SecureStorage>()

export function fileStorageFor(protector: SystemProtector | null): SecureStorage {
  if (protector === null) return plainTextStorage
  let storage = sealedStorages.get(protector)
  if (storage === undefined) {
    storage = createSealedFileStorage(plainTextStorage, createKeyCustody(protector))
    sealedStorages.set(protector, storage)
  }
  return storage
}
