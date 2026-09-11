#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mercury-samples-message-'))
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
process.env.BROWSER = '/usr/bin/true'
process.env.MERCURY_SAMPLES = '1'
delete process.env.MERCURY_WORKSHOP

const { formatMarksMessage, parseMarksBody, verdictWord } = await import('../../src/services/samples/marks.ts')
const { stateAfterVerdict, samplesEnabled } = await import('../../src/services/samples/contracts.ts')
const { runWorkshopCell } = await import('../../src/services/workshop/runtime.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')
const listener = await import('../../src/services/samples/listener.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — samples message proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const record = { title: 'Landing page' }

section('M1 the message, exactly')
const full = formatMarksMessage(record, {
  version: 2,
  pins: [
    { x: 0.3, y: 0.7, target: 'button#buy "Buy now"', text: 'make it larger' },
    { x: 0.5, y: 0.1, target: 'h1', text: 'shorten the headline' },
  ],
  note: 'Tighten the whole top half.',
  verdict: 'changes-needed',
})
const expectedFull = [
  'Marks on Landing page v2: 2 pins · 1 note · changes needed',
  '- at button#buy "Buy now": make it larger',
  '- at h1: shorten the headline',
  '',
  'Tighten the whole top half.',
].join('\n')
check('M1a two pins, a note, changes needed', full === expectedFull, JSON.stringify(full))

section('M2 the words: pin/pins, note/no note, the verdict')
check('M2a one pin, no note, approved', formatMarksMessage(record, { version: 1, pins: [{ x: 0, y: 0, target: 'the page', text: 'ship it' }], note: '', verdict: 'approve' }) === 'Marks on Landing page v1: 1 pin · no note · approved\n- at the page: ship it')
check('M2b no pins, no note, no verdict', formatMarksMessage(record, { version: 3, pins: [], note: '', verdict: null }) === 'Marks on Landing page v3: 0 pins · no note · no verdict')
check('M2c the verdict words', verdictWord('approve') === 'approved' && verdictWord('changes-needed') === 'changes needed' && verdictWord(null) === 'no verdict')

section('M3 a note with no pins')
check('M3a the note follows the head line directly', formatMarksMessage(record, { version: 1, pins: [], note: 'Looks right.', verdict: 'approve' }) === 'Marks on Landing page v1: 0 pins · 1 note · approved\nLooks right.')

section('M4 the body reader')
const good = parseMarksBody({ version: 2, pins: [{ x: 1.4, y: -0.2, target: 'h1\n  big', text: 'two\nlines  here' }], note: '  a note  ', verdict: 'approve' }, 2)
check(
  'M4a a good body: positions clamp to the page, lines fold, the note trims',
  good !== null && good.version === 2 && good.pins[0]!.x === 1 && good.pins[0]!.y === 0 && good.pins[0]!.target === 'h1 big' && good.pins[0]!.text === 'two lines here' && good.note === 'a note' && good.verdict === 'approve',
  JSON.stringify(good),
)
check('M4b an empty target reads as the page', parseMarksBody({ version: 1, pins: [{ x: 0, y: 0, target: '', text: 'x' }], note: '', verdict: null }, 1)?.pins[0]?.target === 'the page')
check('M4c a missing note and a missing verdict read as none', (() => { const m = parseMarksBody({ version: 1, pins: [] }, 1); return m !== null && m.note === '' && m.verdict === null })())
check('M4d the version must exist', parseMarksBody({ version: 3, pins: [] }, 2) === null && parseMarksBody({ version: 0, pins: [] }, 2) === null && parseMarksBody({ version: 1.5, pins: [] }, 2) === null && parseMarksBody({ version: '1', pins: [] }, 2) === null)
check('M4e pins must be an array of pins', parseMarksBody({ version: 1, pins: 'none' }, 1) === null && parseMarksBody({ version: 1, pins: [{ x: 'a', y: 0, text: 'x' }] }, 1) === null && parseMarksBody({ version: 1, pins: [{ x: 0, y: 0 }] }, 1) === null && parseMarksBody({ version: 1, pins: [null] }, 1) === null)
check('M4f the verdict vocabulary is two words or null', parseMarksBody({ version: 1, pins: [], verdict: 'maybe' }, 1) === null && parseMarksBody({ version: 1, pins: [], verdict: 'changes-needed' }, 1)?.verdict === 'changes-needed')
check('M4g not an object, not marks', parseMarksBody(null, 1) === null && parseMarksBody('x', 1) === null && parseMarksBody([], 1) === null && parseMarksBody(undefined, 1) === null)
check('M4h a note that is not text is refused', parseMarksBody({ version: 1, pins: [], note: 5 }, 1) === null)
check('M4i too many pins are refused', parseMarksBody({ version: 1, pins: Array.from({ length: 201 }, () => ({ x: 0, y: 0, text: 'x' })) }, 1) === null)

section('M5 the verdict moves the state')
check('M5a approve → approved; changes-needed → changes-needed', stateAfterVerdict('open', 'approve') === 'approved' && stateAfterVerdict('open', 'changes-needed') === 'changes-needed')
check('M5b no verdict leaves the state as it is', stateAfterVerdict('open', null) === 'open' && stateAfterVerdict('approved', null) === 'approved' && stateAfterVerdict('changes-needed', null) === 'changes-needed')

section('T the Workshop tool lists the sample it kept and its prompt says when')
{
  const { WorkshopTool } = await import('../../src/tools/WorkshopTool/WorkshopTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const workDir = mkdtempSync(join(tmpdir(), 'mercury-samples-tool-'))
  const appState = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' },
    denialTracking: undefined,
    sessionHooks: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    speculation: { status: 'idle' },
  }
  const ctx = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentId: undefined,
    toolDecisions: new Map(),
    readFileState: new Map(),
    nestedMemoryAttachmentTriggers: new Set(),
    dynamicSkillDirTriggers: new Set(),
    userModified: false,
    updateFileHistoryState: () => {},
    options: { tools: [WorkshopTool], mcpClients: [], isNonInteractiveSession: true },
  }
  const ALLOW = async (_t: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })
  const PARENT = { uuid: 'samples-parent', requestId: 'samples-req', message: { id: 'samples-msg' } }
  const previousCwd = process.cwd()
  process.chdir(workDir)
  let out: { data: { result: string; cells: Array<{ state: string; samples?: Array<{ title: string; version: number; url: string; ask?: string }> }> } }
  try {
    out = (await (WorkshopTool as { call: Function }).call(
      { cells: [{ language: 'js', code: "await mercury.sample({ name: 'Hero card', html: '<h1>hero</h1>', ask: 'show me the hero card' })\n'kept'" }] },
      ctx,
      ALLOW,
      PARENT,
    )) as typeof out
  } finally {
    process.chdir(previousCwd)
  }
  const cell = out.data.cells[0]!
  check('T1 the cell succeeded and its result carries the sample', cell.state === 'succeeded' && cell.samples?.length === 1 && cell.samples[0]!.title === 'Hero card' && cell.samples[0]!.version === 1, JSON.stringify(cell).slice(0, 400))
  const line = out.data.result.match(/^sample: (.+)$/m)?.[1] ?? ''
  check(
    'T2 the result text lists it as "sample: <title> v<N> → <url> · asked: <ask>"',
    /^Hero card v1 → http:\/\/127\.0\.0\.1:\d+\/s\/[a-z0-9]+\?t=[0-9a-f]{32} · asked: show me the hero card$/.test(line),
    line,
  )
  const prompt = await (WorkshopTool as { prompt: () => Promise<string> }).prompt()
  check('T3 the prompt names mercury.sample under the bridge', prompt.includes('await mercury.sample({ name, title?, html, ask? })'))
  check('T4 the prompt says when: only when asked, never unasked, never as a hedge, never to decorate', /ONLY when the operator asked to see something/.test(prompt) && /never unasked, never as a hedge, never to decorate an answer/.test(prompt) && /"show me"/.test(prompt))
  check('T5 the prompt says the same name is the next version and the data stays in the cell', /The same name publishes the next version/.test(prompt) && /keep the page's data in the cell/.test(prompt))
  check('T6 the search hint names samples', String((WorkshopTool as { searchHint?: string }).searchHint).includes('mercury.sample'))
}

section('G the gate')
{
  const { WorkshopTool } = await import('../../src/tools/WorkshopTool/WorkshopTool.ts')
  const workDir = mkdtempSync(join(tmpdir(), 'mercury-samples-gate-'))
  const bridge = { inspect: async () => '', tool: async () => '', agent: async () => '' }
  const ownerOn = makeOwnerKey({ workspace: workDir, sessionId: 'gate-on', lane: 'main' } as never)
  const warm = await runWorkshopCell({ owner: ownerOn, cwd: workDir, cell: { language: 'js', code: 'typeof mercury.sample' }, bridge })
  check('G1 with MERCURY_SAMPLES=1 the cell has mercury.sample', samplesEnabled() && warm.state === 'succeeded' && warm.valuePreview === "'function'", JSON.stringify(warm).slice(0, 200))

  delete process.env.MERCURY_SAMPLES
  check('G2 unset reads as off (the default)', !samplesEnabled())
  const ownerOff = makeOwnerKey({ workspace: workDir, sessionId: 'gate-off', lane: 'main' } as never)
  const off = await runWorkshopCell({ owner: ownerOff, cwd: workDir, cell: { language: 'js', code: 'typeof mercury.sample' }, bridge })
  check('G3 a runtime made while off has no mercury.sample', off.state === 'succeeded' && off.valuePreview === "'undefined'", JSON.stringify(off).slice(0, 200))
  const refused = await runWorkshopCell({ owner: ownerOn, cwd: workDir, cell: { language: 'js', code: "await mercury.sample({ name: 'late', html: '<p>late</p>' })" }, bridge })
  check('G4 a runtime made while on cannot keep a sample once it is off: the host refuses the call', refused.state === 'failed' && /unknown bridge call 'sample'/.test(refused.error ?? '') && refused.samples === undefined, JSON.stringify(refused).slice(0, 300))
  const promptOff = await (WorkshopTool as { prompt: () => Promise<string> }).prompt()
  check('G5 the prompt has no sample line while off', !promptOff.includes('mercury.sample'))
  process.env.MERCURY_SAMPLES = '0'
  check('G6 =0 reads as off too', !samplesEnabled())

  process.env.MERCURY_SAMPLES = '1'
  const ownerBack = makeOwnerKey({ workspace: workDir, sessionId: 'gate-back', lane: 'main' } as never)
  const back = await runWorkshopCell({ owner: ownerBack, cwd: workDir, cell: { language: 'js', code: 'typeof mercury.sample' }, bridge })
  const promptBack = await (WorkshopTool as { prompt: () => Promise<string> }).prompt()
  check('G7 =1 again: a new runtime has the call and the prompt its line (a live read)', samplesEnabled() && back.valuePreview === "'function'" && promptBack.includes('mercury.sample'))
  await disposeOwner(ownerOn)
  await disposeOwner(ownerOff)
  await disposeOwner(ownerBack)
}

section('P the poison — the comparators bite')
check('P1 a different verdict is a different message', formatMarksMessage(record, { version: 2, pins: [], note: '', verdict: 'approve' }) !== formatMarksMessage(record, { version: 2, pins: [], note: '', verdict: 'changes-needed' }))
check('P2 a different title is a different message', formatMarksMessage({ title: 'A' }, { version: 1, pins: [], note: '', verdict: null }) !== formatMarksMessage({ title: 'B' }, { version: 1, pins: [], note: '', verdict: null }))
check('P3 the pinned text is not the text with one word changed', expectedFull !== full.replace('larger', 'smaller'))

await listener.closeSampleListener()

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ samples marks message: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ samples marks message: every law holds')
process.exit(0)
