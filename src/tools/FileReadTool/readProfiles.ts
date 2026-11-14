import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { ReadQueryRequest, ReadQueryResult } from './readQuery.js'
import { streamProfile } from './profileStream.js'
import { frameKey, profileNumber, profileRows, summarizeProfile, type ProfileReading } from './profileModel.js'
import { readViewPage, readViewWindow } from './readViewPage.js'
import { withReadViewSource } from './readViewSource.js'

async function sourceProfile(request: ReadQueryRequest, source: string, additional = false) {
  return withReadViewSource(request, source, async file => {
    const before = await stat(file)
    const profile = await streamProfile(file, source, request.context.abortController.signal)
    const after = await stat(file)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('The profiler report changed while it was read; read it again.')
    const hash = createHash('sha256')
    if (source.startsWith('ssh://')) {
      for await (const chunk of createReadStream(file, { signal: request.context.abortController.signal })) hash.update(chunk)
    } else hash.update(JSON.stringify([source, after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs]))
    return { profile, identity: hash.digest('hex') }
  }, additional)
}

async function comparisonRows(before: ProfileReading, after: ProfileReading, signal: AbortSignal): Promise<{ headings: string[]; rows: string[] }> {
  const a = await summarizeProfile(before, signal), b = await summarizeProfile(after, signal)
  const totals = (p: ProfileReading, s: typeof a) => `duration=${p.duration === null ? 'unknown' : `${profileNumber(p.duration)} ms`} · samples=${p.samples} · on-CPU=${profileNumber(s.cpu)} ${p.unit}`
  const headings = [`before totals: ${totals(before, a)}`, `after totals: ${totals(after, b)}`]
  if (before.format !== after.format || before.unit !== after.unit || (before.unit === 'samples' && before.interval !== after.interval)) return { headings, rows: ['Not comparable: different profiler formats, sampling intervals or measurement units; read each summary separately.'] }
  headings.push('Absolute deltas are after minus before; share deltas are percentage points of each profile\'s own on-CPU estimate, not a speedup measurement.')
  const keys = new Set([...a.hotspots.keys(), ...b.hotspots.keys()])
  const rows = [...keys].map(key => {
    const old = a.hotspots.get(key), now = b.hotspots.get(key), frame = now?.frame ?? old!.frame
    const self = (now?.self ?? 0) - (old?.self ?? 0)
    const inclusive = (now?.inclusive ?? 0) - (old?.inclusive ?? 0)
    const share = (b.cpu ? (now?.self ?? 0) / b.cpu * 100 : 0) - (a.cpu ? (old?.self ?? 0) / a.cpu * 100 : 0)
    return { self, key, text: `self delta=${profileNumber(self)} ${after.unit} · inclusive delta=${profileNumber(inclusive)} ${after.unit} · share delta=${profileNumber(share)} pp · identity=${frameKey(frame)}` }
  }).sort((x, y) => Math.abs(y.self) - Math.abs(x.self) || x.key.localeCompare(y.key)).map(row => row.text)
  return { headings, rows }
}

export async function readProfiles(request: ReadQueryRequest, automatic = false): Promise<ReadQueryResult | null> {
  const loaded = await sourceProfile(request, request.target.source)
  const profile = loaded.profile
  if (profile === null) {
    if (automatic) return null
    const content = `(target: profile · source: ${request.target.source} · state: unavailable)\nNo recognised profiler report; read the original with Read(file_path: ${JSON.stringify(`${request.target.source}#read?view=raw`)}).`
    return { content, numLines: 2 }
  }
  const summary = await summarizeProfile(profile, request.context.abortController.signal)
  const headings = [
    `format: ${profile.format} · duration: ${profile.duration === null ? 'unknown' : `${profileNumber(profile.duration)} ms`} · samples: ${profile.samples} · weighting: ${profile.weighting}`,
    `weighted samples: ${profileNumber(summary.cpu + summary.idle)} ${profile.unit} · on-CPU estimate: ${profileNumber(summary.cpu)} ${profile.unit} · idle: ${profileNumber(summary.idle)} ${profile.unit}; CPU-share uses the on-CPU estimate.`,
    ...[...profile.quality].map(line => `quality: ${line}`),
    `Raw text: Read(file_path: ${JSON.stringify(`${request.target.source}#read?view=raw`)}).`,
  ]
  let rows = profileRows(profile, summary), identity = loaded.identity
  const compare = request.target.parameters.compare
  if (compare !== undefined) {
    const prior = await sourceProfile(request, compare, true)
    identity += prior.identity
    headings.push(`before: ${compare}`, `after: ${request.target.source}`)
    if (!prior.profile) rows = ['Not comparable: the before file is not a recognised profiler report.']
    else {
      const compared = await comparisonRows(prior.profile, profile, request.context.abortController.signal)
      headings.push(...compared.headings, ...[...prior.profile.quality].map(line => `before quality: ${line}`))
      rows = compared.rows
    }
  }
  const token = createHash('sha256').update(identity).digest('hex')
  if (request.target.parameters.source !== undefined && request.target.parameters.source !== token) throw new Error('The profiler report changed since the preceding page; read its first page again.')
  request = { ...request, target: { ...request.target, parameters: { ...request.target.parameters, source: token } } }
  const window = readViewWindow(request)
  return readViewPage(request, 'profile', headings, rows.slice(window.offset), rows.length, window)
}
