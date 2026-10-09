export type CrewStartRecordV1 = {
  name: string
  cwd: string
  worktree: string | null
  model: string
}

const crewStarts = new Map<string, CrewStartRecordV1>()

export function recordCrewStart(id: string, record: CrewStartRecordV1): void {
  crewStarts.set(id, record)
}

export function crewStartOf(id: string): CrewStartRecordV1 | null {
  return crewStarts.get(id) ?? null
}
