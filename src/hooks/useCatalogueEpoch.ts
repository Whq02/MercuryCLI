import { useSyncExternalStore } from 'react'
import {
  catalogueEpoch,
  subscribeCatalogueEpoch,
} from '../services/providers/catalogueEpoch.js'

export function useCatalogueEpoch(): number {
  return useSyncExternalStore(subscribeCatalogueEpoch, catalogueEpoch, catalogueEpoch)
}
