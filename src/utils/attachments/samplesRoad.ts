import { samplesEnabled } from '../../services/samples/contracts.js'
import type { Message } from '../../types/message.js'
import type { Attachment } from './types.js'

const SAMPLE_WORDS = /\bsamples?\b/i

export function samplesRoadAttachment(input: string, messages: readonly Message[] = []): Attachment[] {
  if (!SAMPLE_WORDS.test(input)) return []
  const on = samplesEnabled()
  const boundary = messages.findLastIndex(message => message.type === 'system' && message.subtype === 'compact_boundary')
  const announced = messages.slice(boundary < 0 ? 0 : boundary).some(message => message.type === 'attachment' && message.attachment.type === 'samples_road' && message.attachment.on === on)
  return announced ? [] : [{ type: 'samples_road', on }]
}

export function samplesRoadText(on: boolean): string {
  return on
    ? 'Samples is on in this session: a sample is a versioned page published from an Eval cell with `sample({ name, title?, doc, ask? })` — typed parts, never HTML; Mercury draws the page, serves it at a local URL and lists it under /samples (the nine parts arrive with the Eval tool\'s manual after the first cell). The operator asking to see a sample, page, mockup or report means this road, not a hand-written file — unless they name a file to write or mean a data or code sample.'
    : 'Samples — Mercury\'s versioned pages published from an Eval cell with `sample()` and listed under /samples — is off in this session, so `sample()` refuses. The Boot Menu\'s Samples row or MERCURY_SAMPLES=1 turns it on for new sessions; if the operator asked for one of these pages, say so before building any page by hand.'
}
