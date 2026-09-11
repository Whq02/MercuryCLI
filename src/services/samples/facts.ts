import type { SampleRowV1 } from '../engine-connector/types.js'
import { samplesEnabled } from './contracts.js'
import { listSamples, sampleChangeRevision, sampleUrl, writeFallbackPage } from './store.js'

let cached: { sessionId: string; revision: number; rows: SampleRowV1[] } | null = null

export async function sampleRowsOf(sessionId: string): Promise<SampleRowV1[]> {
  if (!samplesEnabled()) return []
  const revision = sampleChangeRevision()
  if (cached !== null && cached.sessionId === sessionId && cached.revision === revision) return cached.rows
  const records = listSamples(sessionId)
  if (records.length > 0) {
    const { ensureSampleListener } = await import('./listener.js')
    const address = await ensureSampleListener()
    if (address === null) {
      for (const record of records) {
        if (sampleUrl(record.id) === null) writeFallbackPage(sessionId, record.id)
      }
    }
  }
  const rows = records.map((record): SampleRowV1 => {
    const url = sampleUrl(record.id)
    return {
      id: record.id,
      title: record.title,
      version: record.latestVersion,
      state: record.state,
      updatedAt: record.updatedAt,
      glyph: record.glyph,
      ...(url !== null ? { url } : {}),
    }
  })
  cached = { sessionId, revision: sampleChangeRevision(), rows }
  return rows
}
