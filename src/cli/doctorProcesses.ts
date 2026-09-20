import { PROCESS_SWEEP_WORDS, processSweepCounts, processSweepLine, type ProcessSweepCensus } from '../daemon/processSweep.js'
import { endStaleProcesses, processSweepOutcomeLine, readMercuryProcesses } from '../daemon/processSweepRun.js'

export interface DoctorProcessesReport {
  row: string
  readAt: number
  complete: boolean
  error?: string
  counts: Record<'running' | 'stale' | 'cannot-end' | 'not-ours', number>
  summary: string
  lines: string[]
  entries: ProcessSweepCensus['entries']
  endings: ProcessSweepCensus['endings']
  result?: string
}

export function doctorProcessesReport(census: ProcessSweepCensus, ended: boolean): DoctorProcessesReport {
  const counts = processSweepCounts(census.entries)
  const listed = census.entries.filter(entry => entry.classification === 'stale' || entry.classification === 'cannot-end')
  return {
    row: PROCESS_SWEEP_WORDS.row,
    readAt: census.readAt,
    complete: census.complete,
    ...(census.error === undefined ? {} : { error: census.error }),
    counts,
    summary: PROCESS_SWEEP_WORDS.counts(counts),
    lines: listed.map(entry => processSweepLine(entry, census.readAt)),
    entries: census.entries,
    endings: census.endings,
    ...(ended ? { result: processSweepOutcomeLine(census) } : {}),
  }
}

export async function runDoctorProcessesCli(options: { endStale: boolean }): Promise<number> {
  const listing = await readMercuryProcesses()
  if (!options.endStale) {
    process.stdout.write(`${JSON.stringify(doctorProcessesReport(listing, false), null, 2)}\n`)
    return listing.complete ? 0 : 1
  }
  const reviewed = listing.entries.filter(entry => entry.classification === 'stale')
  const after = await endStaleProcesses(reviewed)
  const report = doctorProcessesReport(after, true)
  process.stdout.write(`${JSON.stringify({ ...report, reviewed: reviewed.map(entry => processSweepLine(entry, listing.readAt)) }, null, 2)}\n`)
  return after.endings.every(ending => ending.outcome === 'ended') && after.complete ? 0 : 2
}
