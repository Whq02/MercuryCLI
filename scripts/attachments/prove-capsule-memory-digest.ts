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
let refs: any[] = [row]
let file = 'one.ts'
mock.module('../../src/services/projectIntel/capsule.ts', () => ({ ...assembler, assembleContextCapsule: () => ({ schema: 1, workspace: scratch, generation: {}, task: 'harbour', goal: null, items: [{ ref: `mercury://file/${file}`, path: file, role: 'recent change', reason: 'read', tier: 4 }], memoryRefs: refs, caps: { omitted: { count: 0, reasons: [] } }, digest: file + JSON.stringify(refs) }) }))
mock.module('../../src/services/projectIntel/snapshot.ts', () => ({ getProjectSnapshotAsync: async () => null }))
const { getContextCapsuleAttachment, foldAttachmentsIntoCapsule } = await import('../../src/utils/attachments/contextCapsule.ts')
const context = { readFileState: new Map(), options: {}, getAppState: () => ({}) }
const prompt = 'Check the harbour rules'
const message = (attachment: any) => ({ type: 'attachment', attachment, uuid: `receipt-${Math.random()}` }) as never
const get = async (messages: any[] = [], ctx = context) => (await getContextCapsuleAttachment(prompt, messages, ctx as never))[0] as any
try {
  const first = await get()
  assert.ok(first?.markdown.includes('The harbour rule'))
  const aborted = await get()
  assert.ok(aborted?.markdown.includes('The harbour rule'))
  file = 'two.ts'
  const second = await get([message(first)])
  assert.ok(second?.markdown.includes('two.ts'))
  assert.ok(!second.markdown.includes('The harbour rule'), 'a file-only change repeats zero memory bytes')
  const folded = foldAttachmentsIntoCapsule([{ type: 'edited_text_file', filename: join(scratch, 'two.ts'), snippet: 'new text' }], [message(first), message(second)], null, context as never)[0] as any
  file = 'three.ts'
  const third = await get([message(first), message(second), message(folded)])
  assert.ok(!third.markdown.includes('The harbour rule'), 'section-only capsules preserve visibility without reprinting')
  refs = [{ ...row, grade: '[fact · cited 1 · unverified]' }]
  file = 'four.ts'
  const counted = await get([message(first), message(second)])
  assert.ok(!counted.markdown.includes('The harbour rule'), 'citation counts do not change emission identity')
  refs = [{ ...row, witness: 'version-b' }]
  const changed = await get([message(first), message(counted)])
  assert.ok(changed.markdown.includes('The harbour rule'), 'a full-content correction beyond a preview emits once')
  const afterLoss = await get([message(second)])
  assert.ok(afterLoss.markdown.includes('The harbour rule'), 'a carried cursor cannot stand in for a dropped body')
  const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'fold' } as never
  assert.ok((await get([boundary, message(first)]))?.markdown.includes('The harbour rule'), 'changed content after a retained block emits')
  refs = [row]
  file = 'five.ts'
  assert.ok(!(await get([boundary, message(first)]))?.markdown.includes('The harbour rule'), 'a retained unchanged block after a fold remains visible')
  assert.ok((await get([message(first), boundary]))?.markdown.includes('The harbour rule'), 'a lost block after a fold emits')
  const child = await get([], { ...context, agentId: 'child' } as never)
  assert.ok(child?.markdown.includes('The harbour rule'), 'a child has its own cursor')
  refs = []
  const removed = await get([message(first)])
  assert.match(removed?.markdown ?? '', /Memory.*no .*refs/i)
  console.log(`PASS capsule memory digest; unchanged-repeat bytes 0; first ${Buffer.byteLength(first.markdown)}; changed ${Buffer.byteLength(changed.markdown)}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
