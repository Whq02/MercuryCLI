import { notBuilt, type Unbuilt } from '../pi/holes.js'

type Signal<Args extends unknown[] = []> = Unbuilt

export function createSignal<Args extends unknown[] = []>(): Signal<Args> {
  return notBuilt('src/utils/signal.ts:7')
}
