export type WaitClamp = { value: number; clause: string | null }

export type ClampBound = 'maximum' | 'minimum'

export function clampClause(parameter: string, value: number, bound: ClampBound, unit: string): string {
  return `${parameter} clamped to ${value} ${unit} (the ${bound})`
}

export function clampWait(parameter: string, requested: number, floor: number, ceiling: number, unit: string): WaitClamp {
  if (requested > ceiling) {
    return { value: ceiling, clause: clampClause(parameter, ceiling, 'maximum', unit) }
  }
  if (requested < floor) {
    return { value: floor, clause: clampClause(parameter, floor, 'minimum', unit) }
  }
  return { value: requested, clause: null }
}
