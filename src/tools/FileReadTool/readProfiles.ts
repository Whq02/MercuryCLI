import type { ReadQueryRequest, ReadQueryResult } from './readQuery.js'
import { loadProfile } from './profileParse.js'
import { profileNumber, profileRows, summarizeProfile } from './profileModel.js'
import { readViewPage, readViewWindow } from './readViewPage.js'
import { withReadViewSource } from './readViewSource.js'

export async function readProfiles(request: ReadQueryRequest, automatic = false): Promise<ReadQueryResult | null> {
  const profile = await withReadViewSource(request, request.target.source, file => loadProfile(file, request.target.source, request.context.abortController.signal))
  if (profile === null) {
    if (automatic) return null
    const content = `(target: profile · source: ${request.target.source} · state: unavailable)\nNo recognised profiler report; read the original with Read(file_path: ${JSON.stringify(`${request.target.source}#read?view=raw`)}).`
    return { content, numLines: 2 }
  }
  const summary = summarizeProfile(profile)
  const headings = [
    `format: ${profile.format} · duration: ${profile.duration === null ? 'unknown' : `${profileNumber(profile.duration)} ms`} · samples: ${profile.samples} · weighting: ${profile.weighting}`,
    `weighted samples: ${profileNumber(summary.cpu + summary.idle)} ${profile.unit} · on-CPU estimate: ${profileNumber(summary.cpu)} ${profile.unit} · idle: ${profileNumber(summary.idle)} ${profile.unit}; CPU-share uses the on-CPU estimate.`,
    ...[...profile.quality].map(line => `quality: ${line}`),
    `Raw text: Read(file_path: ${JSON.stringify(`${request.target.source}#read?view=raw`)}).`,
  ]
  const rows = profileRows(profile, summary)
  const window = readViewWindow(request)
  return readViewPage(request, 'profile', headings, rows.slice(window.offset), rows.length, window)
}
