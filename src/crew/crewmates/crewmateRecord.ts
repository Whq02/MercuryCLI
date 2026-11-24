import type { CrewmateMetadata } from '../../sessions/transcripts/paths.js'

type RecordRun = Omit<CrewmateMetadata, 'model' | 'effort' | 'effortOverride' | 'compactOnResume'>

function withField(record: CrewmateMetadata, key: 'model' | 'effort' | 'effortOverride', value: string | undefined): CrewmateMetadata {
  const { [key]: _dropped, ...rest } = record
  return value === undefined ? (rest as CrewmateMetadata) : ({ ...rest, [key]: value } as CrewmateMetadata)
}

function withFoldOnResume(record: CrewmateMetadata, keep: boolean): CrewmateMetadata {
  const { compactOnResume: _dropped, ...rest } = record
  return keep ? { ...rest, compactOnResume: true } : (rest as CrewmateMetadata)
}

export function recordAfterResume(
  first: CrewmateMetadata | null,
  latest: CrewmateMetadata | null,
  run: { fresh: RecordRun; model: string | undefined; effortOverride: string | undefined },
): CrewmateMetadata {
  const inWindow = (key: 'model' | 'effortOverride'): boolean => latest !== null && latest[key] !== first?.[key]
  let record: CrewmateMetadata = { ...(latest ?? {}), ...run.fresh }
  record = withField(record, 'model', inWindow('model') ? latest?.model : run.model)
  record = withField(record, 'effortOverride', inWindow('effortOverride') ? latest?.effortOverride : run.effortOverride)
  return withFoldOnResume(record, latest?.compactOnResume === true && first?.compactOnResume !== true)
}

export function recordAtRunStart(
  latest: CrewmateMetadata | null,
  given: { model: string | undefined; effortOverride: string | undefined },
  run: { fresh: RecordRun; model: string; effortOverride: string | undefined; effort: string | undefined },
): CrewmateMetadata {
  const modelInWindow = latest?.model !== undefined && latest.model !== given.model
  const effortInWindow = latest !== null && latest.effortOverride !== given.effortOverride
  let record: CrewmateMetadata = { ...(latest ?? {}), ...run.fresh }
  record = withField(record, 'model', modelInWindow ? latest?.model : run.model)
  record = withField(record, 'effortOverride', effortInWindow ? latest?.effortOverride : run.effortOverride)
  record = withField(record, 'effort', run.effort)
  return withFoldOnResume(record, latest?.compactOnResume === true)
}
