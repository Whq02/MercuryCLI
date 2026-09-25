export type WaitClamp = { value: number; clause: string | null }

export function clampWait(parameter: string, requested: number, floor: number, ceiling: number, unit: string): WaitClamp {
  if (requested > ceiling) {
    return { value: ceiling, clause: `${parameter} clamped to ${ceiling} ${unit} (the maximum)` }
  }
  if (requested < floor) {
    return { value: floor, clause: `${parameter} clamped to ${floor} ${unit} (the minimum)` }
  }
  return { value: requested, clause: null }
}
