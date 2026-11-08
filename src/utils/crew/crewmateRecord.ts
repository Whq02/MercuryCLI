import type { AgentMetadata } from '../sessionStorage/paths.js'

type RecordRun = Omit<AgentMetadata, 'model' | 'effort' | 'effortOverride' | 'compactOnResume'>

function withField(record: AgentMetadata, key: 'model' | 'effort' | 'effortOverride', value: string | undefined): AgentMetadata {
  const { [key]: _dropped, ...rest } = record
  return value === undefined ? (rest as AgentMetadata) : ({ ...rest, [key]: value } as AgentMetadata)
}

function withCompactOnResume(record: AgentMetadata, keep: boolean): AgentMetadata {
  const { compactOnResume: _dropped, ...rest } = record
  return keep ? { ...rest, compactOnResume: true } : (rest as AgentMetadata)
}

export function recordAfterResume(
  first: AgentMetadata | null,
  latest: AgentMetadata | null,
  run: { fresh: RecordRun; model: string | undefined; effortOverride: string | undefined },
): AgentMetadata {
  const inWindow = (key: 'model' | 'effortOverride'): boolean => latest !== null && latest[key] !== first?.[key]
  let record: AgentMetadata = { ...(latest ?? {}), ...run.fresh }
  record = withField(record, 'model', inWindow('model') ? latest?.model : run.model)
  record = withField(record, 'effortOverride', inWindow('effortOverride') ? latest?.effortOverride : run.effortOverride)
  return withCompactOnResume(record, latest?.compactOnResume === true && first?.compactOnResume !== true)
}

export function recordAtRunStart(
  latest: AgentMetadata | null,
  given: { model: string | undefined; effortOverride: string | undefined },
  run: { fresh: RecordRun; model: string; effortOverride: string | undefined; effort: string | undefined },
): AgentMetadata {
  const modelInWindow = latest?.model !== undefined && given.model !== undefined && latest.model !== given.model
  const effortInWindow = latest?.effortOverride !== undefined && latest.effortOverride !== given.effortOverride
  let record: AgentMetadata = { ...(latest ?? {}), ...run.fresh }
  record = withField(record, 'model', modelInWindow ? latest?.model : run.model)
  record = withField(record, 'effortOverride', effortInWindow ? latest?.effortOverride : run.effortOverride)
  record = withField(record, 'effort', run.effort)
  return withCompactOnResume(record, latest?.compactOnResume === true)
}
