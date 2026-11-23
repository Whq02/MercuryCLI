
export const CREW_STOP_WINDOW_MS = 2000

export type CrewStopArm = { id: string; at: number }

export function crewStopArmed(prior: CrewStopArm | null, id: string, now: number): boolean {
  return prior !== null && prior.id === id && now - prior.at < CREW_STOP_WINDOW_MS
}

export function pressCrewStop(prior: CrewStopArm | null, id: string, now: number): { fire: true } | { fire: false; arm: CrewStopArm } {
  if (crewStopArmed(prior, id, now)) return { fire: true }
  return { fire: false, arm: { id, at: now } }
}

export function crewStopHint(name: string): string {
  return `x again within ${Math.round(CREW_STOP_WINDOW_MS / 1000)} s stops ${name}`
}

export const CREW_RESUME_HINT = 'r resumes it'
