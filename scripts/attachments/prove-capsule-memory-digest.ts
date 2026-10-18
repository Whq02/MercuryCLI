import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'capsule-memory-'))
process.env.MERCURY_CONFIG_DIR = scratch
delete process.env.MERCURY_HOME
const assembler = await import('../../src/services/projectIntel/capsule.ts')
const row = { refId: 'mneme:1', status: 'current', summary: 'The harbour rule', why: 'task match', grade: '[fact · cited 0 · unverified]', library: 'library-a', witness: 'version-a' }
const second = { refId: 'mneme:2', status: 'current', summary: 'The quay rule', why: 'task match', grade: '[fact · cited 0 · unverified]', library: 'library-a', witness: 'version-q' }
let refs: any[] = [row]
let file = 'one.ts'
mock.module('../../src/services/projectIntel/capsule.ts', () => ({ ...assembler, assembleContextCapsule: () => ({ schema: 1, workspace: scratch, generation: {}, task: 'harbour', goal: null, items: [{ ref: `mercury://file/${file}`, path: file, role: 'recent change', reason: 'read', tier: 4 }], memoryRefs: refs, caps: { omitted: { count: 0, reasons: [] } }, digest: file + JSON.stringify(refs) }) }))
mock.module('../../src/services/projectIntel/snapshot.ts', () => ({ getProjectSnapshotAsync: async () => null }))
const { getContextCapsuleAttachment, foldAttachmentsIntoCapsule, _resetContextCapsuleForTesting } = await import('../../src/utils/attachments/contextCapsule.ts')
const { _resetMemorySurfacedForTesting } = await import('../../src/utils/attachments/memorySurfaced.ts')
const context = { readFileState: new Map(), options: {}, getAppState: () => ({}) }
const prompt = 'Check the harbour rules'
const message = (attachment: any) => ({ type: 'attachment', attachment, uuid: `receipt-${Math.random()}` }) as never
const get = async (messages: any[] = [], ctx = context) => (await getContextCapsuleAttachment(prompt, messages, ctx as never))[0] as any
const freshSession = (): void => {
  _resetMemorySurfacedForTesting()
  _resetContextCapsuleForTesting()
}
try {
  const first = await get()
  assert.ok(first?.markdown.includes('The harbour rule'))
  assert.deepEqual(first.memoryIds, ['seq:1'], 'the capsule records the memory it surfaced, by record id')
  assert.equal(first.memoryEmitted, true)
  const aborted = await get()
  assert.ok(aborted?.markdown.includes('one.ts') && !aborted.markdown.includes('The harbour rule'), 'a record surfaced at collection counts for the session, even when the window never kept the block')
  file = 'two.ts'
  const secondCapsule = await get([message(first)])
  assert.ok(secondCapsule?.markdown.includes('two.ts'))
  assert.ok(!secondCapsule.markdown.includes('The harbour rule'), 'a file-only change repeats zero memory bytes')
  assert.equal(secondCapsule.memoryEmitted, false)
  assert.equal(secondCapsule.memoryIds, undefined)
  const folded = foldAttachmentsIntoCapsule([{ type: 'edited_text_file', filename: join(scratch, 'two.ts'), snippet: 'new text' }], [message(first), message(secondCapsule)], null, context as never)[0] as any
  file = 'three.ts'
  const third = await get([message(first), message(secondCapsule), message(folded)])
  assert.ok(!third.markdown.includes('The harbour rule'), 'section-only capsules preserve visibility without reprinting')
  refs = [{ ...row, grade: '[fact · cited 1 · unverified]' }]
  file = 'four.ts'
  const counted = await get([message(first), message(secondCapsule)])
  assert.ok(!counted.markdown.includes('The harbour rule'), 'citation counts do not change emission identity')
  refs = [{ ...row, witness: 'version-b' }]
  const changed = await get([message(first), message(counted)])
  assert.equal(changed, undefined, 'a corrected record is the same record: it rode once and is a Recall away, so nothing new attaches')
  const afterLoss = await get([message(secondCapsule)])
  assert.ok(afterLoss?.markdown.includes('four.ts') && !afterLoss.markdown.includes('The harbour rule'), 'a block that left the window does not come back')
  const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'fold' } as never
  refs = [row]
  file = 'five.ts'
  assert.ok(!(await get([boundary, message(first)]))?.markdown.includes('The harbour rule'), 'a retained block after a fold is not reprinted')
  const lost = await get([message(first), boundary])
  assert.ok(lost?.markdown.includes('five.ts') && !lost.markdown.includes('The harbour rule') && !lost.memoryIds, 'a fold that lost the block does not bring the record back: the session remembers it rode')
  refs = [row, second]
  file = 'six.ts'
  const arrival = await get([message(first), boundary])
  assert.ok(arrival?.markdown.includes('The quay rule') && !arrival.markdown.includes('The harbour rule'), 'a record matching for the first time rides once, alone')
  assert.deepEqual(arrival.memoryIds, ['seq:2'])
  assert.ok(!(await get([message(arrival)]))?.markdown.includes('The quay rule'), 'and never a second time')
  const child = await get([], { ...context, agentId: 'child' } as never)
  assert.ok(child?.markdown.includes('The harbour rule') && child.markdown.includes('The quay rule'), 'a crewmate thread keeps its own count')
  refs = []
  file = 'seven.ts'
  const removed = await get([message(arrival)])
  assert.ok(removed?.markdown.includes('seven.ts') && !/Memory/.test(removed.markdown), 'no matching record: the capsule carries no memory line at all, and never announces a stale selection')
  freshSession()
  refs = [row]
  const resumed = await get([message(first)])
  assert.ok(resumed === undefined || !resumed.markdown.includes('The harbour rule'), 'a resumed process whose window still shows the block does not repeat it')
  const resumedBare = await get()
  assert.ok(resumedBare?.markdown.includes('The harbour rule'), 'a resumed process with nothing in view starts a fresh count')
  console.log(`PASS capsule memory once per session; unchanged-repeat bytes 0; first ${Buffer.byteLength(first.markdown)}; arrival ${Buffer.byteLength(arrival.markdown)}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
