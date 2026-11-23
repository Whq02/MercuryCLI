import {
  type DependencyList,
  type EffectCallback,
  useEffect,
  useLayoutEffect,
} from 'react'

type Undo = () => void
type UndoableEffect = () => Undo | undefined
type LivedEffect = (signal: AbortSignal) => void | Undo

function lived(effect: LivedEffect): EffectCallback {
  return () => {
    const life = new AbortController()
    const undo = effect(life.signal)
    return () => {
      life.abort()
      if (typeof undo === 'function') undo()
    }
  }
}

export function useMount(effect: EffectCallback): void {
  useEffect(effect, [])
}

export function useTimer(start: LivedEffect, deps?: DependencyList): void {
  useEffect(lived(start), deps)
}

export function useLoad(load: LivedEffect, deps?: DependencyList): void {
  useEffect(lived(load), deps)
}

export function useSubscription(
  subscribe: UndoableEffect,
  deps?: DependencyList,
): void {
  useEffect(subscribe, deps)
}

export function useClaim(claim: UndoableEffect, deps?: DependencyList): void {
  useEffect(claim, deps)
}

export function useDerivedState(
  derive: EffectCallback,
  deps?: DependencyList,
): void {
  useEffect(derive, deps)
}

export function usePublish(
  publish: EffectCallback,
  deps?: DependencyList,
): void {
  useEffect(publish, deps)
}

export function useMeasure(
  measure: EffectCallback,
  deps?: DependencyList,
): void {
  useLayoutEffect(measure, deps)
}

export function useLayoutTimer(
  start: EffectCallback,
  deps?: DependencyList,
): void {
  useLayoutEffect(start, deps)
}

export function useLayoutSubscription(
  subscribe: UndoableEffect,
  deps?: DependencyList,
): void {
  useLayoutEffect(subscribe, deps)
}

export function useLayoutClaim(
  claim: UndoableEffect,
  deps?: DependencyList,
): void {
  useLayoutEffect(claim, deps)
}

export function useLayoutPublish(
  publish: EffectCallback,
  deps?: DependencyList,
): void {
  useLayoutEffect(publish, deps)
}
