#!/usr/bin/env bun
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTally } from '../daemon/dupline-world.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'read-size-refusal-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.NODE_ENV

const { FileReadTool } = await import(`${SRC}/tools/FileReadTool/FileReadTool.ts`)
const { FileTooLargeError } = await import(`${SRC}/utils/readFileInRange.ts`)
const { getEmptyToolPermissionContext } = await import(`${SRC}/Tool.ts`)
const { createFileStateCacheWithSizeLimit } = await import(`${SRC}/utils/fileStateCache.ts`)
const { enableConfigs } = await import(`${SRC}/utils/config/globalConfig.ts`)
const { formatFileSize } = await import(`${SRC}/utils/format.ts`)
enableConfigs()

const tally = makeTally('prove-read-size-refusal-count')
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — read size-refusal prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

function makeContext(): unknown {
  return {
    readFileState: createFileStateCacheWithSizeLimit(100),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  }
}

let serial = 0
type Refusal = { error: unknown; message: string; ms: number }
async function attempt(input: Record<string, unknown>, own: boolean): Promise<Refusal> {
  serial++
  const parent = own ? { uuid: `00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`, message: { id: `msg_size_${serial}` } } : undefined
  const started = Date.now()
  try {
    const result = await (FileReadTool as { call: Function }).call(input, makeContext(), null, parent)
    const block = (FileReadTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(result.data, `toolu_${serial}`)
    return { error: undefined, message: typeof block.content === 'string' ? block.content : JSON.stringify(block.content), ms: Date.now() - started }
  } catch (err) {
    return { error: err, message: err instanceof Error ? err.message : String(err), ms: Date.now() - started }
  }
}

const fixtures = mkdtempSync(join(tmpdir(), 'read-size-refusal-fixture-'))
const manyLines = join(fixtures, 'many.txt')
const M = 4000
writeFileSync(manyLines, Array.from({ length: M }, (_, i) => `row ${String(i + 1).padStart(5, '0')} ${'x'.repeat(70)}`).join('\n') + '\n')
const fewLines = join(fixtures, 'few.txt')
writeFileSync(fewLines, Array.from({ length: 50 }, (_, i) => `row ${i + 1} ${'y'.repeat(6200)}`).join('\n') + '\n')
const log = join(fixtures, 'g_40mb.log')
{
  const parts: string[] = []
  for (let i = 0; i < 471271; i++) parts.push(`2026-10-05T08:00:00Z INFO worker=17 request served in 12ms path=/api/v1/items id=${String(i).padStart(7, '0')}\n`)
  writeFileSync(log, parts.join(''))
}
const sizeOf = (path: string): string => formatFileSize(statSync(path).size)
const oldWords = (bytes: string): string => `File content (${bytes}) exceeds the maximum allowed size (256KB). Use offset and limit to read portions of the file, or search for content instead of reading the whole file.`

tally.section('D — the 256 KB refusal of a Read the model called names the line count and two ready slices')
{
  const manyBytes = statSync(manyLines).size
  tally.check('fixtures are over the guard: many.txt and few.txt above 256 KB, the log 41,943,119 bytes', manyBytes > 256 * 1024 && statSync(fewLines).size > 256 * 1024 && statSync(log).size === 41943119, `${manyBytes} ${statSync(fewLines).size} ${statSync(log).size}`)
  const many = await attempt({ file_path: manyLines }, true)
  tally.check(`1. a ${M}-line file over the guard (fast path): the refusal names the count and the first and last hundred`, many.message === `File content (${sizeOf(manyLines)}, ${M} lines) exceeds the maximum allowed size (256KB) for a Read without a limit. Pass offset and limit to read a slice — Read(offset: 1, limit: 100) reads the first 100 lines, Read(offset: ${M - 99}, limit: 100) the last 100 — or search for content instead of reading the whole file.`, many.message)
  const load = loadavg()[0] ?? 0
  const big = await attempt({ file_path: log }, true)
  tally.check('2. the 40 MB log (streaming path): the refusal names 471271 lines and the last-hundred slice at 471172', big.message.includes('(40MB, 471271 lines)') && big.message.includes('Read(offset: 471172, limit: 100) the last 100'), big.message)
  const budgetMs = 5000 * Math.max(1, load / 8)
  tally.check(`2b. the count costs one pass: the refusal returns within ${Math.round(budgetMs)} ms (load ${load.toFixed(2)}; measured ${big.ms} ms)`, big.ms <= budgetMs, `${big.ms} ms`)
  const offsetOnly = await attempt({ file_path: log, offset: 471266 }, true)
  tally.check('3. an offset without a limit is still refused (the guard keys on limit) with the counted words', offsetOnly.message === big.message, offsetOnly.message)
  tally.check('4. the thrown error is a FileTooLargeError', big.error instanceof FileTooLargeError && many.error instanceof FileTooLargeError && offsetOnly.error instanceof FileTooLargeError)
  const few = await attempt({ file_path: fewLines }, true)
  tally.check('5. a 50-line file over the guard: one Read that reads all of it, each line cut at 2000 characters', few.message === `File content (${sizeOf(fewLines)}, 50 lines) exceeds the maximum allowed size (256KB) for a Read without a limit. Pass offset and limit to read a slice — Read(offset: 1, limit: 50) reads all of it, each line cut at 2000 characters — or search for content instead of reading the whole file.`, few.message)
  const harness = await attempt({ file_path: manyLines }, false)
  tally.check('6. a harness read (no parent message) keeps the .28 words exactly', harness.message === oldWords(sizeOf(manyLines)) && harness.error instanceof FileTooLargeError, harness.message)
  const withLimit = await attempt({ file_path: log, offset: 471266, limit: 20 }, true)
  tally.check('7. the named slice reads: offset 471266, limit 20 returns the six last lines with the end-of-file mark and no line 471272', withLimit.error === undefined && withLimit.message.includes('471271\t2026-10-05T08:00:00Z INFO worker=17 request served in 12ms path=/api/v1/items id=0471270\n[lines 471266-471271 of 471271 — the end of the file]\n(anchor: ra:') && !withLimit.message.includes('471272\t'), withLimit.message.slice(0, 400))
}

rmSync(fixtures, { recursive: true, force: true })
tally.finish()
