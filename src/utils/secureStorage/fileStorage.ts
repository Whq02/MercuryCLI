import { plainTextStorage } from './plainTextStorage.js'
import { createSealedFileStorage } from './sealedFileStorage.js'
import { createKeyCustody, type KeyCustody } from './sealedRecord.js'
import type { SecureStorage, SystemProtector } from './types.js'

type SealedFileStore = { custody: KeyCustody; sealing: SecureStorage; unsealing: SecureStorage }

const sealedStores = new WeakMap<SystemProtector, SealedFileStore>()

export function sealedFileStoreFor(protector: SystemProtector): SealedFileStore {
  let store = sealedStores.get(protector)
  if (store === undefined) {
    const custody = createKeyCustody(protector)
    store = {
      custody,
      sealing: createSealedFileStorage(plainTextStorage, custody, true),
      unsealing: createSealedFileStorage(plainTextStorage, custody, false),
    }
    sealedStores.set(protector, store)
  }
  return store
}

export function fileStorageFor(protector: SystemProtector | null, seals: boolean = true): SecureStorage {
  if (protector === null) return plainTextStorage
  const store = sealedFileStoreFor(protector)
  return seals ? store.sealing : store.unsealing
}
