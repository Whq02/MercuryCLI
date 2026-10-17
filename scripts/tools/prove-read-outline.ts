#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'read-outline-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
delete process.env.NODE_ENV

const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(
    `  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 600 ? `${detail.slice(0, 600)}…` : detail}` : ''}`,
  )
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const fixtures = mkdtempSync(join(tmpdir(), 'read-outline-fixtures-'))

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

let seq = 0
async function runRead(
  input: Record<string, unknown>,
  ctx = makeContext(),
): Promise<{ ok: true; text: string; data: Record<string, unknown> } | { ok: false; error: string }> {
  const schema = (FileReadTool as { inputSchema: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } } }).inputSchema
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: `schema rejected: ${JSON.stringify(parsed.error)}` }
  }
  const t = FileReadTool as { validateInput?: Function; call: Function; mapToolResultToToolResultBlockParam: Function }
  if (t.validateInput) {
    const valid = await t.validateInput(parsed.data, ctx)
    if (valid && !valid.result) return { ok: false, error: String(valid.message) }
  }
  seq++
  try {
    const out = await t.call(
      parsed.data,
      ctx,
      null,
      { uuid: `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`, message: { id: `msg_ol_${seq}` } },
    )
    const block = t.mapToolResultToToolResultBlockParam(out.data, `toolu_ol_${seq}`)
    return { ok: true, text: typeof block.content === 'string' ? block.content : '', data: out.data }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const tsSource = [
  'import { EventEmitter } from "node:events"',
  '',
  'export interface TaskConfig {',
  '  retries: number',
  '  timeoutMs: number',
  '}',
  '',
  'export class TaskRunner extends EventEmitter {',
  '  private count = 0',
  '',
  '  async execute(cfg: TaskConfig): Promise<number> {',
  '    this.count += 1',
  '    const delay = cfg.timeoutMs * cfg.retries',
  '    return this.count + delay',
  '  }',
  '}',
  '',
  'export function computeTotal(a: number, b: number): number {',
  '  const sum = a + b',
  '  const scaled = sum * 10',
  '  return scaled',
  '}',
  '',
].join('\n')

const pySource = [
  'import os',
  '',
  'class Processor:',
  '    def __init__(self, prefix: str) -> None:',
  '        self.prefix = prefix',
  '        self.ready = True',
  '',
  '    def run(self, items: list[str]) -> int:',
  '        count = 0',
  '        for item in items:',
  '            count += len(item)',
  '        return count',
  '',
  'def summarize(values: list[int]) -> int:',
  '    total = sum(values)',
  '    return total',
  '',
].join('\n')

const goSource = [
  'package worker',
  '',
  'import "fmt"',
  '',
  'type Pool struct {',
  '\tSize int',
  '\tName string',
  '}',
  '',
  'func (p *Pool) Run(job string) error {',
  '\tmsg := fmt.Sprintf("%s:%d:%s", p.Name, p.Size, job)',
  '\tfmt.Println(msg)',
  '\treturn nil',
  '}',
  '',
  'func Helper(x int, y int) int {',
  '\tz := x + y',
  '\treturn z * 2',
  '}',
  '',
].join('\n')

section('O1. TypeScript, Python and Go outline mode through vendored tree-sitter grammars')
{
  const tsPath = join(fixtures, 'runner.ts')
  writeFileSync(tsPath, tsSource)
  const tsOutline = await runRead({ file_path: tsPath, outline: true })
  check('O1a TypeScript outline: schema accepts outline: true and call succeeds', tsOutline.ok, tsOutline.ok ? '' : tsOutline.error)
  check(
    'O1b TypeScript outline: keeps interface, class, method and function signatures with original line numbers while eliding bodies',
    tsOutline.ok &&
      tsOutline.text.includes('3\texport interface TaskConfig {') &&
      tsOutline.text.includes('8\texport class TaskRunner extends EventEmitter {') &&
      tsOutline.text.includes('11\t  async execute(cfg: TaskConfig): Promise<number> {') &&
      tsOutline.text.includes('18\texport function computeTotal(a: number, b: number): number {') &&
      tsOutline.text.includes('[elided body lines 12-14]') &&
      tsOutline.text.includes('[elided body lines 19-21]') &&
      !tsOutline.text.includes('const delay = cfg.timeoutMs') &&
      !tsOutline.text.includes('const scaled = sum * 10'),
    tsOutline.ok ? tsOutline.text : tsOutline.error,
  )

  const pyPath = join(fixtures, 'processor.py')
  writeFileSync(pyPath, pySource)
  const pyOutline = await runRead({ file_path: pyPath, outline: true })
  check('O1c Python outline: call succeeds', pyOutline.ok, pyOutline.ok ? '' : pyOutline.error)
  check(
    'O1d Python outline: keeps class and def signatures with original line numbers while eliding method and function bodies',
    pyOutline.ok &&
      pyOutline.text.includes('3\tclass Processor:') &&
      pyOutline.text.includes('4\t    def __init__(self, prefix: str) -> None:') &&
      pyOutline.text.includes('8\t    def run(self, items: list[str]) -> int:') &&
      pyOutline.text.includes('14\tdef summarize(values: list[int]) -> int:') &&
      pyOutline.text.includes('[elided body lines 5-6]') &&
      pyOutline.text.includes('[elided body lines 9-12]') &&
      pyOutline.text.includes('[elided body lines 15-16]') &&
      !pyOutline.text.includes('count += len(item)') &&
      !pyOutline.text.includes('total = sum(values)'),
    pyOutline.ok ? pyOutline.text : pyOutline.error,
  )

  const goPath = join(fixtures, 'pool.go')
  writeFileSync(goPath, goSource)
  const goOutline = await runRead({ file_path: goPath, outline: true })
  check('O1e Go outline: call succeeds', goOutline.ok, goOutline.ok ? '' : goOutline.error)
  check(
    'O1f Go outline: keeps struct, method and function signatures with original line numbers while eliding bodies',
    goOutline.ok &&
      goOutline.text.includes('5\ttype Pool struct {') &&
      goOutline.text.includes('10\tfunc (p *Pool) Run(job string) error {') &&
      goOutline.text.includes('16\tfunc Helper(x int, y int) int {') &&
      goOutline.text.includes('[elided body lines 11-13]') &&
      goOutline.text.includes('[elided body lines 17-18]') &&
      !goOutline.text.includes('fmt.Sprintf') &&
      !goOutline.text.includes('z := x + y'),
    goOutline.ok ? goOutline.text : goOutline.error,
  )
}

section('O2. Control: plain Read without outline is byte-identical, and plain Read after outline is not stubbed as file_unchanged')
{
  const tsPath = join(fixtures, 'control.ts')
  writeFileSync(tsPath, tsSource)
  const plain = await runRead({ file_path: tsPath })
  const explicitFalse = await runRead({ file_path: tsPath, outline: false })
  check(
    'O2a plain Read returns all lines verbatim with no elision',
    plain.ok &&
      plain.text.includes('12\t    this.count += 1') &&
      plain.text.includes('20\t  const scaled = sum * 10') &&
      !plain.text.includes('[elided body'),
    plain.ok ? plain.text : plain.error,
  )
  check(
    'O2b Read with outline: false is byte-identical to plain Read with outline omitted',
    plain.ok && explicitFalse.ok && plain.text === explicitFalse.text,
    plain.ok && explicitFalse.ok ? `${plain.text.length} vs ${explicitFalse.text.length}` : 'call failed',
  )

  const sharedCtx = makeContext()
  const firstOutline = await runRead({ file_path: tsPath, outline: true }, sharedCtx)
  const secondPlain = await runRead({ file_path: tsPath }, sharedCtx)
  check(
    'O2c a full plain Read after an outline Read on the same context returns the full file (not file_unchanged)',
    firstOutline.ok &&
      secondPlain.ok &&
      secondPlain.data.type === 'text' &&
      secondPlain.text.includes('12\t    this.count += 1'),
    secondPlain.ok ? secondPlain.text : secondPlain.error,
  )
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
