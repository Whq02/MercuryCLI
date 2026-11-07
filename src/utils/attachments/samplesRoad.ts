import { samplesEnabled } from '../../services/samples/contracts.js'
import type { Attachment } from './types.js'

const SAMPLE_WORDS = /\bsamples?\b/i

export function samplesRoadAttachment(input: string): Attachment[] {
  if (!SAMPLE_WORDS.test(input)) return []
  return [{ type: 'samples_road', on: samplesEnabled() }]
}

export function samplesRoadText(on: boolean): string {
  return on
    ? 'Samples is on in this session: a sample is a versioned page published from an Eval cell with `sample({ name, title?, doc, ask? })` — typed parts, never HTML; Mercury draws the page, serves it at a local URL and lists it under /samples (the Eval tool\'s manual carries the nine parts). The operator asking to see a sample, page, mockup or report means this road, not a hand-written file.'
    : 'Samples — Mercury\'s versioned pages published from an Eval cell with `sample()` and listed under /samples — is off in this session, so `sample()` refuses. The Boot Menu\'s Samples row or MERCURY_SAMPLES=1 turns it on for new sessions; say so before building any page by hand.'
}
