#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'write-edit-parse-check-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS
delete process.env.MERCURY_EDIT_STALE_RECOVERY
delete process.env.NODE_ENV

const { _resetSeenLinesForTesting } = await import('../../src/services/changeTransaction/seenLines.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const parseCheckModule = (await import('../../src/tools/FileWriteTool/parseCheck.ts').catch(() => null)) as null | {
  checkIntroducedParseError: (
    filePath: string,
    beforeContent: string | null,
    afterContent: string,
    hasLspServer?: boolean,
  ) => string | undefined
}

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(
    `  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 500 ? `${detail.slice(0, 500)}…` : detail}` : ''}`,
  )
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const fixtures = mkdtempSync(join(tmpdir(), 'write-edit-parse-check-fixtures-'))
type Entry = { content: string; timestamp: number; offset?: number; limit?: number; isPartialView?: boolean }
type Ctx = { readFileState: Map<string, Entry> }
function makeContext(): Ctx {
  return {
    readFileState: new Map<string, Entry>(),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as never as Ctx
}
const PARENT = { uuid: '00000000-0000-0000-0000-000000000087', message: { id: 'msg_fixture' } }
type Verdict = { ok: true; text: string; isError: boolean; data: Record<string, unknown> } | { ok: false; message: string }
async function run(tool: unknown, input: Record<string, unknown>, ctx: Ctx, id: string): Promise<Verdict> {
  const t = tool as { validateInput?: Function; call: Function; mapToolResultToToolResultBlockParam: Function }
  if (t.validateInput) {
    const verdict = await t.validateInput(input, ctx)
    if (verdict.result === false) return { ok: false, message: String(verdict.message) }
  }
  try {
    const out = await t.call(input, ctx, null, PARENT)
    const block = t.mapToolResultToToolResultBlockParam(out.data, id)
    return { ok: true, text: typeof block.content === 'string' ? block.content : '', isError: block.is_error === true, data: out.data }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

section('P1. JSON/YAML/TOML writes and edits surface introduced parse errors when no LSP covers the file')
{
  _resetSeenLinesForTesting()
  const ctx = makeContext()

  const jsonPath = join(fixtures, 'broken.json')
  const wJson = await run(FileWriteTool, { file_path: jsonPath, content: '{\n  "name": "app",\n}\n' }, ctx, 'tu_wjson')
  check(
    'P1a creating an invalid JSON file surfaces a JSON parse error in the Write result',
    wJson.ok && /JSON parse error/i.test(wJson.text),
    wJson.ok ? wJson.text : wJson.message,
  )

  const yamlPath = join(fixtures, 'config.yaml')
  const wYamlGood = await run(FileWriteTool, { file_path: yamlPath, content: 'name: app\nitems:\n  - one\n' }, ctx, 'tu_wyaml1')
  check(
    'P1b creating a valid YAML file carries no parse error',
    wYamlGood.ok && !/parse error/i.test(wYamlGood.text),
    wYamlGood.ok ? wYamlGood.text : wYamlGood.message,
  )
  const eYamlBad = await run(
    FileEditTool,
    { file_path: yamlPath, old_string: '  - one', new_string: '  - [unclosed' },
    ctx,
    'tu_eyaml',
  )
  check(
    'P1c editing a valid YAML file into invalid syntax surfaces a YAML parse error in the Edit result',
    eYamlBad.ok && /YAML parse error/i.test(eYamlBad.text),
    eYamlBad.ok ? eYamlBad.text : eYamlBad.message,
  )

  const tomlPath = join(fixtures, 'settings.toml')
  const wTomlGood = await run(FileWriteTool, { file_path: tomlPath, content: 'port = 8080\nhost = "localhost"\n' }, ctx, 'tu_wtoml1')
  check(
    'P1d creating a valid TOML file carries no parse error',
    wTomlGood.ok && !/parse error/i.test(wTomlGood.text),
    wTomlGood.ok ? wTomlGood.text : wTomlGood.message,
  )
  const eTomlBad = await run(
    FileEditTool,
    { file_path: tomlPath, old_string: 'port = 8080', new_string: 'port = ' },
    ctx,
    'tu_etoml',
  )
  check(
    'P1e editing a valid TOML file into invalid syntax surfaces a TOML parse error with line/column in the Edit result',
    eTomlBad.ok && /TOML parse error \(line \d+, column \d+\):/i.test(eTomlBad.text),
    eTomlBad.ok ? eTomlBad.text : eTomlBad.message,
  )
}

section('P2. Pre-existing identical parse errors and LSP-covered files stay silent')
{
  _resetSeenLinesForTesting()
  const ctx = makeContext()
  const preBrokenPath = join(fixtures, 'already-broken.json')
  writeFileSync(preBrokenPath, '{\n  "a": 1,\n  "b": 2,\n}\n')
  await run(FileReadTool, { file_path: preBrokenPath }, ctx, 'tu_rpre')
  const eSameErr = await run(
    FileEditTool,
    { file_path: preBrokenPath, old_string: '"a": 1', new_string: '"a": 10' },
    ctx,
    'tu_esame',
  )
  check(
    'P2a editing a file whose pre-existing parse error message is unchanged does not report it as introduced',
    eSameErr.ok && !/parse error/i.test(eSameErr.text),
    eSameErr.ok ? eSameErr.text : eSameErr.message,
  )

  check(
    'P2b when an LSP server covers the file (hasLspServer=true), the in-process check yields to LSP and returns undefined',
    parseCheckModule !== null &&
      parseCheckModule.checkIntroducedParseError('/tmp/x.json', '{"a":1}', '{"a":}', true) === undefined,
    parseCheckModule === null ? 'parseCheck.ts missing' : 'returned non-undefined when hasLspServer=true',
  )

  const shiftedTomlPath = join(fixtures, 'shifted-error.toml')
  const tomlLines = Array.from({ length: 19 }, (_, i) => `key_${i + 1} = ${i + 1}`)
  tomlLines.push('broken_line = ')
  writeFileSync(shiftedTomlPath, `${tomlLines.join('\n')}\n`)
  await run(FileReadTool, { file_path: shiftedTomlPath }, ctx, 'tu_rshift')
  const eShifted = await run(
    FileEditTool,
    {
      file_path: shiftedTomlPath,
      old_string: 'key_3 = 3',
      new_string: 'key_3 = 30\nkey_3_extra = 31',
    },
    ctx,
    'tu_eshift',
  )
  check(
    'P2c editing at line 3 above a pre-existing TOML syntax error at line 20 (shifting its line number) stays silent',
    eShifted.ok && !/parse error/i.test(eShifted.text),
    eShifted.ok ? eShifted.text : eShifted.message,
  )
}

section('P3. Plain-path control: Write and Edit treat paths carrying !, ::, or : as ordinary filesystem paths')
{
  _resetSeenLinesForTesting()
  const ctx = makeContext()
  for (const [idx, suffix] of ['archive.zip!entry.txt', 'archive.zip::entry.txt', 'db.sqlite:users'].entries()) {
    const plainTarget = join(fixtures, suffix)
    const w = await run(FileWriteTool, { file_path: plainTarget, content: `alpha-${idx}\n` }, ctx, `tu_wplain_${idx}`)
    const e = await run(
      FileEditTool,
      { file_path: plainTarget, old_string: `alpha-${idx}`, new_string: `beta-${idx}` },
      ctx,
      `tu_eplain_${idx}`,
    )
    check(
      `P3_${idx + 1} Write and Edit on ${suffix} operate on the literal filesystem path`,
      w.ok && e.ok && existsSync(plainTarget) && readFileSync(plainTarget, 'utf8') === `beta-${idx}\n`,
      !w.ok ? w.message : !e.ok ? e.message : readFileSync(plainTarget, 'utf8'),
    )
  }
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
