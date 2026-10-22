import { parseOwnerKey, type OwnerKey } from '../run/ownerKey.js'
import { SAMPLE_HTML_CAP_BYTES, samplesEnabled, type SampleHtmlSource, type SampleItem } from './contracts.js'
import { normalizeSampleDoc, renderSampleDoc } from './renderDoc.js'
import { createOrAppendSample, sampleUrl, writeFallbackPage } from './store.js'

interface SampleSpec {
  name: string
  title?: string
  html: string
  ask?: string
  source: SampleHtmlSource
}

export const SAMPLE_DOC_REFUSAL = 'sample() takes doc: { parts: [...] } — raw html is retired'

export async function handleSampleCall(owner: OwnerKey, payload: unknown): Promise<SampleItem> {
  if (!samplesEnabled()) throw new Error('samples are off in this session (MERCURY_SAMPLES=0)')
  const spec = specOf(payload)
  const { sessionId } = parseOwnerKey(owner)
  return keepSample(sessionId, spec)
}

export async function keepSample(sessionId: string, spec: SampleSpec): Promise<SampleItem> {
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

export function specOf(payload: unknown): SampleSpec {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('sample() takes one object: { name, title?, doc, ask? }')
  }
  const spec = payload as Record<string, unknown>
  if (typeof spec.name !== 'string' || spec.name.trim() === '') {
    throw new Error('sample() needs a name (the same name publishes the next version)')
  }
  if (spec.title !== undefined && typeof spec.title !== 'string') throw new Error('sample(): title must be a string')
  if (spec.ask !== undefined && typeof spec.ask !== 'string') throw new Error('sample(): ask must be a string')
  const docInput = docInputOf(spec)
  if (docInput === undefined) {
    if (spec.html !== undefined) throw new Error(SAMPLE_DOC_REFUSAL)
    throw new Error('sample() needs doc: { parts: [...] } — the blocks Mercury draws')
  }
  const cap = `sample() keeps at most ${SAMPLE_HTML_CAP_BYTES / (1024 * 1024)} MB per version`
  if (Buffer.byteLength(JSON.stringify(docInput) ?? '', 'utf8') > SAMPLE_HTML_CAP_BYTES) throw new Error(cap)
  const doc = normalizeSampleDoc(docInput)
  const givenTitle = typeof spec.title === 'string' ? spec.title.replace(/\s+/g, ' ').trim() : ''
  const title = givenTitle !== '' ? givenTitle : doc.title
  const html = renderSampleDoc(doc, { title: title ?? spec.name })
  if (Buffer.byteLength(html, 'utf8') > SAMPLE_HTML_CAP_BYTES) throw new Error(cap)
  const ask = typeof spec.ask === 'string' ? spec.ask.replace(/\s+/g, ' ').trim().slice(0, 400) : ''
  return {
    name: spec.name.slice(0, 120),
    ...(title !== undefined ? { title } : {}),
    html,
    ...(ask !== '' ? { ask } : {}),
    source: 'doc',
  }
}

function docInputOf(spec: Record<string, unknown>): unknown {
  if (spec.doc !== undefined && spec.doc !== null) return spec.doc
  if (!Array.isArray(spec.parts)) return undefined
  return {
    parts: spec.parts,
    ...(spec.subtitle !== undefined ? { subtitle: spec.subtitle } : {}),
    ...(spec.meta !== undefined ? { meta: spec.meta } : {}),
    ...(spec.verdict !== undefined ? { verdict: spec.verdict } : {}),
    ...(spec.eyebrow !== undefined ? { eyebrow: spec.eyebrow } : {}),
  }
}
