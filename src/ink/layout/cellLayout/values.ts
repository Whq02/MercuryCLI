import type { LayoutEdge } from '../node.js'

export type DimValue =
  | { unit: 'auto' }
  | { unit: 'point'; value: number }
  | { unit: 'percent'; value: number }

export const AUTO: DimValue = { unit: 'auto' }

export function resolve(v: DimValue | undefined, basis: number | undefined): number | undefined {
  if (!v || v.unit === 'auto') return undefined
  if (v.unit === 'point') return v.value
  return basis === undefined || Number.isNaN(basis) ? undefined : (v.value * basis) / 100
}

export function pointOrAuto(value: number): DimValue {
  return Number.isFinite(value) ? { unit: 'point', value } : AUTO
}

export type EdgeStore = Partial<Record<LayoutEdge, number>>

export function edgeValue(store: EdgeStore, edge: 'left' | 'right' | 'top' | 'bottom'): number {
  if (store[edge] !== undefined) return store[edge]!
  if (edge === 'left' && store.start !== undefined) return store.start
  if (edge === 'right' && store.end !== undefined) return store.end
  const axis = edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical'
  if (store[axis] !== undefined) return store[axis]!
  return store.all ?? 0
}

export type InsetStore = Partial<Record<LayoutEdge, DimValue>>

export function insetValue(
  store: InsetStore,
  edge: 'left' | 'right' | 'top' | 'bottom',
  basis: number | undefined,
): number | undefined {
  const pick =
    store[edge] ??
    (edge === 'left' ? store.start : edge === 'right' ? store.end : undefined) ??
    store[edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical'] ??
    store.all
  return resolve(pick, basis)
}
