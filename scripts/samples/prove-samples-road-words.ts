#!/usr/bin/env bun
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

const { samplesRoadAttachment, samplesRoadText } = await import('../../src/engine/attachment-shapes/samplesRoad.js')
const { getAttachments, createAttachmentMessage } = await import('../../src/engine/attachments/turnAttachments.js')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.js')
const { createUserMessage } = await import('../../src/engine/messages/messages.js')
const { normalizeAttachmentForAPI } = await import('../../src/engine/messages/attachmentText.js')
const { buildEvalPrompt } = await import('../../src/tools/eval/prompt.js')
const { EvalTool } = await import('../../src/tools/eval/EvalTool.js')
const { NULL_RENDERING_ATTACHMENT_TYPES } = await import('../../src/screen/messages/nullRenderingAttachments.js')

const ASK = 'open it for me in a nice to read html or smth pls md is annoying to read from like make a sample using mercurys samples feature i guess'
const textOf = (messages: ReturnType<typeof normalizeAttachmentForAPI>): string => messages.map(message => typeof message.message.content === 'string' ? message.message.content : message.message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('\n')

console.log('[1] the operator\'s word "sample" or "samples" raises the samples road, once, as a hidden reminder')
{
  process.env.MERCURY_SAMPLES = '1'
  const on = samplesRoadAttachment(ASK)
  check('one samples_road attachment for the study-session ask, on', on.length === 1 && on[0]!.type === 'samples_road' && on[0]!.on === true, 'samplesRoadAttachment in src/engine/attachment-shapes/samplesRoad.ts must return one samples_road attachment with on true when MERCURY_SAMPLES=1 · ' + JSON.stringify(on))
  check('"Sample it" (capitalised, singular) raises it too', samplesRoadAttachment('Sample it for me').length === 1, 'the word match in samplesRoadAttachment (src/engine/attachment-shapes/samplesRoad.ts) must be case-insensitive and accept the singular')
  check('"sampling" and "examples" do not', samplesRoadAttachment('the sampling rate of the audio').length === 0 && samplesRoadAttachment('give me a few examples').length === 0, 'the word match in samplesRoadAttachment (src/engine/attachment-shapes/samplesRoad.ts) must match whole words sample or samples only, not sampling or examples')
  check('the attachment is hidden from the transcript view like an agent mention', (NULL_RENDERING_ATTACHMENT_TYPES as readonly string[]).includes('samples_road'), 'add samples_road to NULL_RENDERING_ATTACHMENT_TYPES in src/screen/messages/nullRenderingAttachments.ts')
  const words = textOf(normalizeAttachmentForAPI(on[0]!))
  check('its words say Samples is on, name sample({ name, title?, doc, ask? }), the local URL, /samples and the Eval manual after the first cell, and say the road is not a hand-written file', words.includes('Samples is on in this session') && words.includes('`sample({ name, title?, doc, ask? })`') && words.includes('/samples') && words.includes("the nine parts arrive with the Eval tool's manual after the first cell") && words.includes('not a hand-written file') && words.includes('<system-reminder>'), 'the on text from samplesRoadText in src/engine/attachment-shapes/samplesRoad.ts lost one of the required phrases · ' + words)
  check('the words name the asks that mean this road, a sample, page, mockup or report, and leave a named file or a data sample alone', words.includes('asking to see a sample, page, mockup or report') && words.includes('unless they name a file to write or mean a data or code sample'), 'the on text from samplesRoadText in src/engine/attachment-shapes/samplesRoad.ts lost the asks clause · ' + words)
  const once = samplesRoadAttachment(ASK, [createUserMessage({ content: ASK }), createAttachmentMessage(on[0]!)])
  check('announced once: a later message with the word raises nothing while the reminder for this state is in the history', once.length === 0, 'samplesRoadAttachment in src/engine/attachment-shapes/samplesRoad.ts must skip when the history already holds the reminder for the same state · ' + JSON.stringify(once))
  const flipped = samplesRoadAttachment(ASK, [createAttachmentMessage({ type: 'samples_road', on: false })])
  check('a changed state is announced again', flipped.length === 1 && flipped[0]!.type === 'samples_road' && flipped[0]!.on === true, 'samplesRoadAttachment in src/engine/attachment-shapes/samplesRoad.ts must raise the reminder again when the state in history differs · ' + JSON.stringify(flipped))
  const compacted = samplesRoadAttachment(ASK, [createAttachmentMessage(on[0]!), { type: 'system', subtype: 'compact_boundary', content: '', isMeta: true, timestamp: '', uuid: 'b', level: 'info' } as never])
  check('after a compaction the reminder is raised again', compacted.length === 1, 'samplesRoadAttachment in src/engine/attachment-shapes/samplesRoad.ts must ignore reminders before a compact_boundary row · ' + JSON.stringify(compacted))
}

console.log('[2] with Samples off, the same word says so and how it turns on, before any page is built by hand')
{
  delete process.env.MERCURY_SAMPLES
  const off = samplesRoadAttachment(ASK)
  check('one samples_road attachment, off', off.length === 1 && off[0]!.type === 'samples_road' && off[0]!.on === false, 'samplesRoadAttachment in src/engine/attachment-shapes/samplesRoad.ts must return a samples_road attachment with on false when MERCURY_SAMPLES is unset · ' + JSON.stringify(off))
  const words = textOf(normalizeAttachmentForAPI(off[0]!))
  check('its words say off, that sample() refuses, the Boot Menu row and MERCURY_SAMPLES=1, and to say so before building a page by hand when one of these pages was asked for', words.includes('is off in this session') && words.includes('`sample()` refuses') && words.includes("Boot Menu's Samples row") && words.includes('MERCURY_SAMPLES=1') && words.includes('if the operator asked for one of these pages, say so before building any page by hand'), 'the off text from samplesRoadText in src/engine/attachment-shapes/samplesRoad.ts lost one of the required phrases · ' + words)
  check('the two texts differ only in state: both name /samples and an Eval cell', samplesRoadText(true) !== samplesRoadText(false) && [true, false].every(on => samplesRoadText(on).includes('/samples') && samplesRoadText(on).includes('Eval cell')), 'samplesRoadText in src/engine/attachment-shapes/samplesRoad.ts must return different text for on and off, both naming /samples and an Eval cell')
}

console.log('[3] the Eval tool\'s roster words name the samples road when Samples is on, and keep silent when it is off')
{
  process.env.MERCURY_SAMPLES = '1'
  const onPrompt = await buildEvalPrompt([])
  const onWire = EvalTool.wireDescription!(onPrompt)
  check('on: the full prompt carries the sample() helper and the roster description names sample(), /samples and the asks', onPrompt.includes('`sample({name') && onWire.includes('`sample()` in a cell publishes a versioned page') && onWire.includes('/samples') && onWire.includes('asks to see a sample, page, mockup or report'), 'check the sample() line in src/tools/eval/prompt.ts and the Samples clause in src/tools/eval/EvalTool.ts wireDescription · ' + onWire)
  check('on: the clause rides after the helpers sentence and before the languages', onWire.includes('their signatures arrive on first use.') && onWire.includes('With Samples on') && onWire.indexOf('their signatures arrive on first use.') < onWire.indexOf('With Samples on') && onWire.indexOf('With Samples on') < onWire.indexOf('- `'), 'the Samples clause in wireDescription (src/tools/eval/EvalTool.ts) must sit after the helpers sentence and before the language list · ' + onWire)
  delete process.env.MERCURY_SAMPLES
  const offPrompt = await buildEvalPrompt([])
  const offWire = EvalTool.wireDescription!(offPrompt)
  check('off: neither the full prompt nor the roster description mentions sample()', !offPrompt.includes('sample({') && !offWire.includes('sample(') && !offWire.includes('Samples'), 'with MERCURY_SAMPLES unset, src/tools/eval/prompt.ts and the wireDescription in src/tools/eval/EvalTool.ts must leave out every sample() mention · ' + offWire)
  check('the clause costs nothing when off: the off description is the on description without it', onWire.replace(/ With Samples on in this session[^\n]*\./, '') === offWire, 'the Samples clause in wireDescription (src/tools/eval/EvalTool.ts) must be the only difference between on and off · ' + JSON.stringify({ onWire, offWire }))
}

console.log('[5] through the real orchestrator: the operator\'s own prompt raises it; a bash-mode line and a skill expansion do not')
{
  process.env.MERCURY_SAMPLES = '1'
  let state = getDefaultAppState()
  const context = {
    options: { commands: [], tools: [EvalTool], engineModel: 'claude-fable-5-1', mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => state, setAppState: (fn: (s: typeof state) => typeof state) => { state = fn(state) }, abortController: new AbortController(),
    messages: [] as never[], readFileState: createFileStateCacheWithSizeLimit(100), loadedNestedMemoryPaths: new Set<string>(), nestedMemoryAttachmentTriggers: new Set<string>(),
  } as never
  const kinds = (rows: Awaited<ReturnType<typeof getAttachments>>): string[] => rows.flatMap(row => row.type === 'samples_road' ? [`samples_road:${row.on}`] : [])
  const prompt = await getAttachments(ASK, context, [], [], undefined, { localSubmission: false, operatorPrompt: true })
  check('a prompt-mode submission with the word carries one samples_road, on', kinds(prompt).join(',') === 'samples_road:true', 'getAttachments in src/engine/attachments/turnAttachments.ts must run samplesRoadAttachment for an operatorPrompt submission · ' + JSON.stringify(prompt.map(row => row.type)))
  const bash = await getAttachments('ls samples/', context, [], [], undefined, { localSubmission: true })
  check('a bash-mode line with the word carries none', kinds(bash).length === 0, 'getAttachments in src/engine/attachments/turnAttachments.ts must not raise samples_road for a localSubmission bash-mode line · ' + JSON.stringify(bash.map(row => row.type)))
  const expansion = await getAttachments('check samples against source pages', context, [])
  check('a skill or prompt-command expansion (no operatorPrompt mark) carries none', kinds(expansion).length === 0, 'getAttachments in src/engine/attachments/turnAttachments.ts must raise samples_road only when options.operatorPrompt is set · ' + JSON.stringify(expansion.map(row => row.type)))
  const again = await getAttachments(ASK, context, [], [createUserMessage({ content: ASK }), ...prompt.filter(row => row.type === 'samples_road').map(createAttachmentMessage)], undefined, { localSubmission: false, operatorPrompt: true })
  check('the next prompt with the word, with the reminder in the history, carries none', kinds(again).length === 0, 'getAttachments in src/engine/attachments/turnAttachments.ts must pass the history to samplesRoadAttachment so the reminder is announced once · ' + JSON.stringify(again.map(row => row.type)))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
