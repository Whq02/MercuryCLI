import assert from 'node:assert/strict'
import { spyOn } from 'bun:test'
import { join } from 'node:path'

const root = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const files = await import(join(root, 'utils/attachments/fileAttachments.ts'))
const helpers = await import(join(root, 'utils/file.ts'))
const shared = await import(join(root, 'utils/attachments/shared.ts'))
const pdf = await import(join(root, 'utils/pdf.ts'))
const fsops = await import(join(root, 'utils/fsOperations.ts'))
const read = await import(join(root, 'tools/FileReadTool/FileReadTool.ts'))
const { PDF_AT_MENTION_INLINE_THRESHOLD: threshold } = await import(join(root, 'constants/apiLimits.ts'))
const { MAX_LINES_TO_READ } = await import(join(root, 'tools/FileReadTool/prompt.ts'))
const context = { readFileState: new Map(), getAppState: () => ({ toolPermissionContext: {} }) }
const path = join(process.env.MERCURY_CONFIG_DIR!, 'tracked.txt')
let denied = false
let stamp = 10
let count: number | null = threshold
let size = 102400 * (threshold + 1)
let ioFailure: string | null = null
const spies = [
  spyOn(shared, 'isFileReadDenied').mockImplementation(() => denied),
  spyOn(helpers, 'isFileWithinReadSizeLimit').mockReturnValue(true),
  spyOn(helpers, 'getFileModificationTimeAsync').mockImplementation(async () => { if (ioFailure) throw Object.assign(new Error(ioFailure), { code: ioFailure }); return stamp }),
  spyOn(pdf, 'getPDFPageCount').mockImplementation(async () => count),
  spyOn(fsops.getFsImplementation(), 'stat').mockImplementation(async () => ({ size }) as never),
  spyOn(read.FileReadTool, 'validateInput').mockResolvedValue({ result: true } as never),
]
const result = { type: 'text', file: { filePath: path, content: 'new\n', numLines: 2, totalLines: 2, startLine: 1 } }
const calls: any[] = []
let overflow = false
spies.push(spyOn(read.FileReadTool, 'call').mockImplementation(async input => {
  calls.push(input)
  if (overflow && input.limit !== MAX_LINES_TO_READ) throw new read.MaxFileReadTokenExceededError(2, 1, 'fixture overflow')
  return { data: result } as never
}))
try {
  assert.equal(await files.tryGetPDFReference(path), null)
  assert.equal(await files.tryGetPDFReference(path + '.pdf'), null)
  count = threshold + 1
  assert.equal((await files.tryGetPDFReference(path + '.PDF'))?.pageCount, threshold + 1)
  count = null
  assert.equal((await files.tryGetPDFReference(path + '.pdf'))?.pageCount, threshold + 1)
  denied = true
  assert.equal(await files.generateFileAttachment(path, context as never, 'at-mention'), null)
  assert.equal(calls.length, 0)
  denied = false
  context.readFileState.set(path, { content: 'held\n', timestamp: 10 })
  assert.equal((await files.generateFileAttachment(path, context as never, 'at-mention', { offset: 4 }))?.type, 'already_read_file')
  assert.equal(calls.length, 0)
  stamp = 9
  assert.equal((await files.generateFileAttachment(path, context as never, 'at-mention'))?.type, 'file')
  assert.equal(calls.length, 1)
  context.readFileState.clear()
  overflow = true
  assert.equal((await files.generateFileAttachment(path, context as never, 'compact'))?.type, 'compact_file_reference')
  const clipped = await files.generateFileAttachment(path, context as never, 'at-mention', { offset: 3 })
  assert.equal(clipped?.type, 'file')
  assert.equal((clipped as any).truncated, true)
  assert.deepEqual(calls.at(-1), { file_path: path, offset: 3, limit: MAX_LINES_TO_READ })
  overflow = false
  context.readFileState.set(path, { content: 'old\n', timestamp: 1, offset: 2, limit: 3, isPartialView: true })
  const before = calls.length
  assert.deepEqual(await files.getChangedFiles(context as never), [])
  assert.equal(calls.length, before)
  assert(context.readFileState.has(path))
  context.readFileState.set(path, { content: 'old\n', timestamp: 1, offset: 2 })
  const windowed = await files.getChangedFiles(context as never)
  assert.equal(calls.length, before + 1)
  assert.deepEqual(calls.at(-1), { file_path: path, offset: 2 })
  assert.equal(windowed.length, 1)
  assert.equal(windowed[0].type, 'edited_text_file')
  assert.match(windowed[0].snippet, /^\s*2\tnew$/)
  assert(!context.readFileState.has(path))
  context.readFileState.set(path, { content: 'old\n', timestamp: 1 })
  ioFailure = 'EACCES'
  assert.deepEqual(await files.getChangedFiles(context as never), [])
  assert(context.readFileState.has(path))
  ioFailure = 'ENOENT'
  assert.deepEqual(await files.getChangedFiles(context as never), [])
  assert(!context.readFileState.has(path))
  console.log('PASS PDF threshold/fallback, denied and cached reads, exact mtime, overflow policy, the windowed refresh and ENOENT-only eviction')
} finally { for (const spy of spies) spy.mockRestore() }
