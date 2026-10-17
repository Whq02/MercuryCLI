#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'near-miss-home-'))
process.env.MERCURY_BARE = '1'
delete process.env.NODE_ENV

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { FileReadTool } = await import(`${SRC}/tools/FileReadTool/FileReadTool.ts`)
const { summarizeToolResult } = await import(`${SRC}/utils/toolResultSummary.ts`)
const { getEmptyToolPermissionContext } = await import(`${SRC}/Tool.ts`)
const { createFileStateCacheWithSizeLimit } = await import(`${SRC}/utils/fileStateCache.ts`)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function makeContext() {
  return {
    readFileState: createFileStateCacheWithSizeLimit(100),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as never
}

let serial = 0
async function runRead(path: string, ctx = makeContext()): Promise<{ ok: true; text: string; data: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    serial++
    const res = await (FileReadTool as { call: Function }).call(
      { file_path: path },
      ctx,
      null,
      { uuid: `00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`, message: { id: `msg_nm_${serial}` } },
    )
    const block = (FileReadTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(res.data, `toolu_${serial}`)
    return { ok: true, text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content), data: res.data }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const root = mkdtempSync(join(tmpdir(), 'near-miss-fixtures-'))

try {
  console.log('§1 curly apostrophe vs straight apostrophe')
  {
    const dir = join(root, 'curly')
    mkdirSync(dir)
    const realName = 'John\u2019s Notes.txt'
    writeFileSync(join(dir, realName), 'curly apostrophe body\n')
    const r = await runRead(join(dir, "John's Notes.txt"))
    check('1a. straight-apostrophe request opens the curly-apostrophe sibling', r.ok, r.ok ? '' : r.error)
    if (r.ok) {
      const file = r.data.file as { filePath: string; content: string }
      check('1b. result file.filePath names the real file on disk', file.filePath === join(dir, realName), file.filePath)
      check('1c. serialized text names the real file and contains the body', r.text.includes(realName) && r.text.includes('curly apostrophe body'), r.text)
      const card = summarizeToolResult('Read', r.data)
      check('1d. inline card summary names the resolved file', card === `Read 1 line (${realName})`, String(card))
    }
  }

  console.log('§2 typographic spaces (U+00A0 and U+202F) on non-screenshot filenames')
  {
    const dir = join(root, 'spaces')
    mkdirSync(dir)
    const nbspName = 'Q3\u00A0Report\u202FFinal.md'
    writeFileSync(join(dir, nbspName), '# Q3 Report\n')
    const r = await runRead(join(dir, 'Q3 Report Final.md'))
    check('2a. ASCII-space request opens the U+00A0/U+202F sibling', r.ok, r.ok ? '' : r.error)
    if (r.ok) {
      const file = r.data.file as { filePath: string }
      check('2b. result file.filePath names the real file on disk', file.filePath === join(dir, nbspName), file.filePath)
      check('2c. serialized text names the real file and contains the body', r.text.includes(nbspName) && r.text.includes('# Q3 Report'), r.text)
      const card = summarizeToolResult('Read', r.data)
      check('2d. inline card summary names the resolved file', card === `Read 1 line (${nbspName})`, String(card))
    }
  }

  console.log('§3 Unicode NFC vs NFD canonical equivalence')
  {
    const dir = join(root, 'unicode')
    mkdirSync(dir)
    const nfdName = 'cafe\u0301-notes.txt'
    const nfcName = 'caf\u00e9-notes.txt'
    writeFileSync(join(dir, nfdName), 'accented file\n')
    const r = await runRead(join(dir, nfcName))
    check('3a. NFC request opens the NFD sibling (or vice versa on APFS)', r.ok, r.ok ? '' : r.error)
    if (r.ok) {
      check('3b. body returned', r.text.includes('accented file'), r.text)
    }
  }

  console.log('§4 macOS screenshot narrow no-break space continues to open')
  {
    const dir = join(root, 'shot')
    mkdirSync(dir)
    const shotName = 'Screenshot 2026-10-17 at 10.00.00\u202FAM.txt'
    writeFileSync(join(dir, shotName), 'shot note\n')
    const r = await runRead(join(dir, 'Screenshot 2026-10-17 at 10.00.00 AM.txt'))
    check('4a. ASCII-space request opens U+202F sibling', r.ok, r.ok ? '' : r.error)
  }

  console.log('§5 ambiguity refusal: two canonical matches in the same directory do not guess')
  {
    const dir = join(root, 'ambig')
    mkdirSync(dir)
    writeFileSync(join(dir, "client's.txt"), 'one\n')
    writeFileSync(join(dir, 'client\u2019s.txt'), 'two\n')
    const r = await runRead(join(dir, 'client\u2018s.txt'))
    check('5a. two canonical siblings refuse with not-found instead of guessing', !r.ok, r.ok ? r.text : r.error)
  }

  console.log('§6 genuine not-found still returns the not-found error with Did you mean suggestion')
  {
    const dir = join(root, 'missing')
    mkdirSync(dir)
    writeFileSync(join(dir, 'config.json'), '{}\n')
    const r = await runRead(join(dir, 'config.yaml'))
    check('6a. missing file fails', !r.ok)
    if (!r.ok) {
      check('6b. not-found message includes Did you mean config.json?', r.error.includes('Did you mean config.json?'), r.error)
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-read-near-miss-filename: all green' : `\nprove-read-near-miss-filename: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
