import { useSyncExternalStore } from 'react'
import {
  catalogueEpoch,
  subscribeCatalogueEpoch,
} from '../../models/roads/catalogueEpoch.js'

export function useCatalogueEpoch(): number {
  return useSyncExternalStore(subscribeCatalogueEpoch, catalogueEpoch, catalogueEpoch)
}
