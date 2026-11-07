#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'samples-road-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SAMPLES
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 400) : ''}`)
  if (!cond) failures++
}

const { samplesRoadAttachment, samplesRoadText } = await import('../../src/utils/attachments/samplesRoad.js')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.js')
const { buildEvalPrompt } = await import('../../src/tools/EvalTool/prompt.js')
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.js')
const { NULL_RENDERING_ATTACHMENT_TYPES } = await import('../../src/components/messages/nullRenderingAttachments.js')

const ASK = 'open it for me in a nice to read html or smth pls md is annoying to read from like make a sample using mercurys samples feature i guess'
const textOf = (messages: ReturnType<typeof normalizeAttachmentForAPI>): string => messages.map(message => typeof message.message.content === 'string' ? message.message.content : message.message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('\n')

console.log('[1] the operator\'s word "sample" or "samples" raises the samples road, once, as a hidden reminder')
{
  process.env.MERCURY_SAMPLES = '1'
  const on = samplesRoadAttachment(ASK)
  check('one samples_road attachment for the study-session ask, on', on.length === 1 && on[0]!.type === 'samples_road' && on[0]!.on === true, JSON.stringify(on))
  check('"Sample it" (capitalised, singular) raises it too', samplesRoadAttachment('Sample it for me').length === 1)
  check('"sampling" and "examples" do not', samplesRoadAttachment('the sampling rate of the audio').length === 0 && samplesRoadAttachment('give me a few examples').length === 0)
  check('the attachment is hidden from the transcript view like an agent mention', (NULL_RENDERING_ATTACHMENT_TYPES as readonly string[]).includes('samples_road'))
  const words = textOf(normalizeAttachmentForAPI(on[0]!))
  check('its words say Samples is on, name sample({ name, title?, doc, ask? }), the local URL, /samples and the Eval manual, and say the road is not a hand-written file', words.includes('Samples is on in this session') && words.includes('`sample({ name, title?, doc, ask? })`') && words.includes('/samples') && words.includes("Eval tool's manual") && words.includes('not a hand-written file') && words.includes('<system-reminder>'), words)
  check('the words name the asks that mean this road: a sample, page, mockup or report', words.includes('asking to see a sample, page, mockup or report'), words)
}

console.log('[2] with Samples off, the same word says so and how it turns on, before any page is built by hand')
{
  delete process.env.MERCURY_SAMPLES
  const off = samplesRoadAttachment(ASK)
  check('one samples_road attachment, off', off.length === 1 && off[0]!.type === 'samples_road' && off[0]!.on === false, JSON.stringify(off))
  const words = textOf(normalizeAttachmentForAPI(off[0]!))
  check('its words say off, that sample() refuses, the Boot Menu row and MERCURY_SAMPLES=1, and to say so before building a page by hand', words.includes('is off in this session') && words.includes('`sample()` refuses') && words.includes("Boot Menu's Samples row") && words.includes('MERCURY_SAMPLES=1') && words.includes('say so before building any page by hand'), words)
  check('the two texts differ only in state: both name /samples and an Eval cell', samplesRoadText(true) !== samplesRoadText(false) && [true, false].every(on => samplesRoadText(on).includes('/samples') && samplesRoadText(on).includes('Eval cell')))
}

console.log('[3] the Eval tool\'s roster words name the samples road when Samples is on, and keep silent when it is off')
{
  process.env.MERCURY_SAMPLES = '1'
  const onPrompt = await buildEvalPrompt([])
  const onWire = EvalTool.wireDescription!(onPrompt)
  check('on: the full prompt carries the sample() helper and the roster description names sample(), /samples and the asks', onPrompt.includes('`sample({name') && onWire.includes('`sample()` in a cell publishes a versioned page') && onWire.includes('/samples') && onWire.includes('asks to see a sample, page, mockup or report'), onWire)
  check('on: the clause rides after the helpers sentence and before the languages', onWire.indexOf('their signatures arrive on first use.') < onWire.indexOf('With Samples on') && onWire.indexOf('With Samples on') < onWire.indexOf('- `'), onWire)
  delete process.env.MERCURY_SAMPLES
  const offPrompt = await buildEvalPrompt([])
  const offWire = EvalTool.wireDescription!(offPrompt)
  check('off: neither the full prompt nor the roster description mentions sample()', !offPrompt.includes('sample({') && !offWire.includes('sample(') && !offWire.includes('Samples'), offWire)
  check('the clause costs nothing when off: the off description is the on description without it', onWire.replace(/ With Samples on in this session[^\n]*\./, '') === offWire, JSON.stringify({ onWire, offWire }))
}

console.log('[4] the docs say the word reaches the road')
{
  const doc = readFileSync(join(ROOT, 'docs', 'SAMPLES.md'), 'utf8')
  check('docs/SAMPLES.md says a message saying "sample" or "samples" reminds the model of the road and its state', doc.includes('A message of yours that says\n"sample" or "samples" reminds the model of this road and whether it is on in\nthe session'), doc.slice(0, 1200))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
