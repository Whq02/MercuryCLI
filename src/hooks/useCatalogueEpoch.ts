import { useSyncExternalStore } from 'react'
import {
  catalogueEpoch,
  subscribeCatalogueEpoch,
} from '../services/providers/catalogueEpoch.js'

/** Re-renders the caller whenever a live model catalogue settles, so rows
 *  derived from the catalogue caches land in place. The value is the epoch
 *  itself (a settle count); callers may ignore it — subscribing is the
 *  point. */
export function useCatalogueEpoch(): number {
  return useSyncExternalStore(subscribeCatalogueEpoch, catalogueEpoch, catalogueEpoch)
}
