import {
  type DependencyList,
  type EffectCallback,
  useEffect,
  useLayoutEffect,
} from 'react'

type Undo = () => void
type UndoableEffect = () => Undo | undefined

export function useMount(effect: EffectCallback): void {
  useEffect(effect, [])
}

export function useTimer(start: EffectCallback, deps?: DependencyList): void {
  useEffect(start, deps)
}

export function useLoad(load: EffectCallback, deps?: DependencyList): void {
  useEffect(load, deps)
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

export function useLayoutDerivedState(
  derive: EffectCallback,
  deps?: DependencyList,
): void {
  useLayoutEffect(derive, deps)
}

export function useLayoutPublish(
  publish: EffectCallback,
  deps?: DependencyList,
): void {
  useLayoutEffect(publish, deps)
}
