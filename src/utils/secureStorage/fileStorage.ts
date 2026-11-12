import { plainTextStorage } from './plainTextStorage.js'
import { createSealedFileStorage } from './sealedFileStorage.js'
import { createKeyCustody, type KeyCustody } from './sealedRecord.js'
import type { SecureStorage, SystemProtector } from './types.js'

type SealedFileStore = { custody: KeyCustody; storage: SecureStorage }

const sealedStores = new WeakMap<SystemProtector, SealedFileStore>()

export function sealedFileStoreFor(protector: SystemProtector): SealedFileStore {
  let store = sealedStores.get(protector)
  if (store === undefined) {
    const custody = createKeyCustody(protector)
    store = { custody, storage: createSealedFileStorage(plainTextStorage, custody) }
    sealedStores.set(protector, store)
  }
  return store
}

export function fileStorageFor(protector: SystemProtector | null): SecureStorage {
  return protector === null ? plainTextStorage : sealedFileStoreFor(protector).storage
}
