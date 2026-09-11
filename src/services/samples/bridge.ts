import { parseOwnerKey, type OwnerKey } from '../run/ownerKey.js'
import type { WorkshopSampleItem } from '../workshop/contracts.js'
import { SAMPLE_HTML_CAP_BYTES, samplesEnabled } from './contracts.js'
import { createOrAppendSample, sampleUrl, writeFallbackPage } from './store.js'

interface SampleSpec {
  name: string
  title?: string
  html: string
  ask?: string
}

export async function handleSampleCall(owner: OwnerKey, payload: unknown): Promise<WorkshopSampleItem> {
  if (!samplesEnabled()) throw new Error('samples are off in this session (MERCURY_SAMPLES=0)')
  const spec = specOf(payload)
  const { sessionId } = parseOwnerKey(owner)
  const { record, version } = createOrAppendSample({
    sessionId,
    name: spec.name,
    ...(spec.title !== undefined ? { title: spec.title } : {}),
    html: spec.html,
  })
  const { ensureSampleListener } = await import('./listener.js')
  const address = await ensureSampleListener()
  if (address === null) writeFallbackPage(sessionId, record.id)
  const url = sampleUrl(record.id)
  if (url === null) throw new Error(`the sample ${record.id} was kept but has no address to open`)
  return {
    id: record.id,
    title: record.title,
    version,
    url,
    ...(spec.ask !== undefined ? { ask: spec.ask } : {}),
  }
}

function specOf(payload: unknown): SampleSpec {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('mercury.sample takes one object: { name, title?, html, ask? }')
  }
  const spec = payload as Record<string, unknown>
  if (typeof spec.name !== 'string' || spec.name.trim() === '') {
    throw new Error('mercury.sample needs a name (the same name publishes the next version)')
  }
  if (typeof spec.html !== 'string' || spec.html.trim() === '') {
    throw new Error('mercury.sample needs the page as html')
  }
  if (Buffer.byteLength(spec.html, 'utf8') > SAMPLE_HTML_CAP_BYTES) {
    throw new Error(`mercury.sample keeps at most ${SAMPLE_HTML_CAP_BYTES / (1024 * 1024)} MB of html per version`)
  }
  if (spec.title !== undefined && typeof spec.title !== 'string') throw new Error('mercury.sample: title must be a string')
  if (spec.ask !== undefined && typeof spec.ask !== 'string') throw new Error('mercury.sample: ask must be a string')
  const ask = typeof spec.ask === 'string' ? spec.ask.replace(/\s+/g, ' ').trim().slice(0, 400) : ''
  return {
    name: spec.name.slice(0, 120),
    ...(typeof spec.title === 'string' ? { title: spec.title } : {}),
    html: spec.html,
    ...(ask !== '' ? { ask } : {}),
  }
}
