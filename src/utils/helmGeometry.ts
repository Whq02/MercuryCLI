
export const HELM_HOME_MIN_COLS = 100

export const HELM_RAIL_W = 24

export const HELM_CENTER_FLOOR = 78

export const HELM_RAIL_SLIM = 20

export const HELM_RAIL_WIDE = 30

export type RailPlan = {
  lanes: boolean
  telemetry: boolean
  railW: number
  lanesW: number
  telemetryW: number
  centerCols: number
}

export const HELM_BOTH_RAILS_MIN = 150

export const HELM_BOTH_RAILS_RELEASE = 144

let bothRailsEngaged = false

export function resetRailTier(): void {
  bothRailsEngaged = false
}

export function railPlan(columns: number): RailPlan {
  bothRailsEngaged = bothRailsEngaged
    ? columns >= HELM_BOTH_RAILS_RELEASE
    : columns >= HELM_BOTH_RAILS_MIN
  return railPlanAt(columns, bothRailsEngaged)
}

export function railPlanAt(columns: number, bothEngaged: boolean): RailPlan {
  const both = columns - 2 * HELM_RAIL_W - 2
  if (bothEngaged && both >= HELM_CENTER_FLOOR) {
    const centerPin = HELM_BOTH_RAILS_MIN - 2 - 2 * HELM_RAIL_W
    const railTotal = Math.max(
      2 * HELM_RAIL_W,
      Math.min(2 * HELM_RAIL_WIDE, columns - 2 - centerPin),
    )
    const lanesW = Math.ceil(railTotal / 2)
    const telemetryW = railTotal - lanesW
    return {
      lanes: true,
      telemetry: true,
      railW: lanesW,
      lanesW,
      telemetryW,
      centerCols: columns - 2 - railTotal,
    }
  }
  const railW = Math.max(
    HELM_RAIL_SLIM,
    Math.min(HELM_RAIL_W, columns - 2 - HELM_CENTER_FLOOR),
  )
  return {
    lanes: true,
    telemetry: false,
    railW,
    lanesW: railW,
    telemetryW: railW,
    centerCols: Math.max(20, columns - 2 - railW),
  }
}

export function helmCenterCols(columns: number): number {
  return railPlan(columns).centerCols
}
