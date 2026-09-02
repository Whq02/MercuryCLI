#!/usr/bin/env bun
// ============================================================================
//  prove-tool-input-tolerance — the transcript's per-tool hooks are TOTAL over
//  whatever the wire delivers.
//
//  The law: a tool's render-path hooks (the search/read classifier, the
//  use summary, the activity description, the user-facing name) receive
//  wire and streaming input that predates schema validation — the
//  block-start placeholder `{}` every transport paints before a single
//  argument byte arrives, a settled call whose arguments fail the schema,
//  `null`, a wrong-typed field. A hook that throws on such input reaches the
//  app-root boundary and ends the process. So:
//
//   1. The classifier matrix: every classifier-bearing built-in answers the
//      not-search/not-read shape for command-less input and keeps its
//      verdicts for real commands.
//   2. The collapse walk (the crash site) survives a streaming-shaped Bash
//      row carrying `{}`, a settled `{}` no-op, and `null`, in both
//      fullscreen and inline modes, and still collapses real runs.
//   3. The seam: safeSearchOrReadClassification turns a throwing classifier
//      into "uncollapsed", a default classifier into undefined, and an
//      absent tool into undefined.
//   4. The class sweep: every built-in's render-path hooks tolerate the
//      placeholder family (no throw).
//   5. Structural pins: the contract narrows from `unknown`; no classifier
//      call site widens raw input with a cast; the transcript list wraps
//      each row in the per-row boundary.
//   6. The per-row boundary mechanism, rendered live: one throwing row
//      degrades to its fallback line, its siblings paint, the app-root
//      boundary never trips, and a message-boundary crash report lands in
//      the (scratch) config home.
// ============================================================================
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'tool-input-tolerance-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}
const THREW = Symbol('threw')
const never = (label: string, fn: () => unknown): unknown => {
  try {
    return fn()
  } catch (error) {
    t(label, false, `THREW ${(error as Error).message}`)
    return THREW
  }
}

// The placeholder family: what a hook can meet before validation.
const PLACEHOLDERS: Array<[string, unknown]> = [
  ['{} (block-start placeholder)', {}],
  ['{ command: undefined }', { command: undefined }],
  ['{ command: 123 }', { command: 123 }],
  ['null', null],
  ['undefined', undefined],
  ['"a string"', 'a string'],
  ['[] (array)', []],
]

const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { PowerShellTool } = await import('../../src/tools/PowerShellTool/PowerShellTool.tsx')
const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { GlobTool } = await import('../../src/tools/GlobTool/GlobTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { safeSearchOrReadClassification, stringInputField, buildTool } = await import('../../src/Tool.ts')
const { z } = await import('zod/v4')

// —— 1. the classifier matrix ————————————————————————————————————————
console.log('── 1. classifier matrix ──')
for (const tool of [BashTool, PowerShellTool, GrepTool, GlobTool, FileReadTool]) {
  for (const [label, input] of PLACEHOLDERS) {
    const out = never(`${tool.name}.isSearchOrReadCommand(${label})`, () => tool.isSearchOrReadCommand!(input))
    if (out === THREW) continue
    const shape = out as { isSearch?: unknown; isRead?: unknown }
    t(`${tool.name}(${label}) answers booleans`, typeof shape.isSearch === 'boolean' && typeof shape.isRead === 'boolean')
  }
}
{
  const notSearch = JSON.stringify({ isSearch: false, isRead: false, isList: false })
  t('Bash: command-less input is not-search/not-read/not-list', JSON.stringify(BashTool.isSearchOrReadCommand!({})) === notSearch)
  t('Bash: a real search still classifies', BashTool.isSearchOrReadCommand!({ command: 'grep -rn foo src' }).isSearch === true)
  t('Bash: a real read still classifies', BashTool.isSearchOrReadCommand!({ command: 'cat README.md' }).isRead === true)
  t('Bash: a listing still classifies', BashTool.isSearchOrReadCommand!({ command: 'ls -la' }).isList === true)
  t('Bash: a mutating command is none of them', JSON.stringify(BashTool.isSearchOrReadCommand!({ command: 'rm -rf build' })) === notSearch)
  t('PowerShell: command-less input is not-search/not-read', JSON.stringify(PowerShellTool.isSearchOrReadCommand!({ command: 9 })) === JSON.stringify({ isSearch: false, isRead: false }))
  t('PowerShell: a real search still classifies', PowerShellTool.isSearchOrReadCommand!({ command: 'Select-String -Path a.txt -Pattern x' }).isSearch === true)
  t(
    'stringInputField narrows only string fields',
    stringInputField({ command: 'ls' }, 'command') === 'ls' &&
      stringInputField({ command: 3 }, 'command') === undefined &&
      stringInputField(null, 'command') === undefined &&
      stringInputField('ls', 'command') === undefined,
  )
}

// —— 2. the collapse walk at the crash site ————————————————————————
console.log('── 2. collapse walk ──')
{
  const { collapseReadSearchGroups, getToolSearchOrReadInfo } = await import('../../src/utils/collapseReadSearch.ts')
  const tools = [BashTool, GrepTool, FileReadTool] as never
  let n = 0
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  const use = (id: string, name: string, input: unknown, extra: Record<string, unknown> = {}) => ({
    type: 'assistant', uuid: uuid(), timestamp: new Date().toISOString(), ...extra,
    message: { id: `m${id}`, role: 'assistant', type: 'message', model: 'x', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id, name, input }] },
  })
  const result = (id: string, text: string) => ({
    type: 'user', uuid: uuid(), timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] },
    toolUseResult: { stdout: text, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
  })
  for (const fullscreen of ['1', '0']) {
    process.env.MERCURY_FULLSCREEN = fullscreen
    const mode = fullscreen === '1' ? 'fullscreen' : 'inline'
    for (const [label, input] of PLACEHOLDERS) {
      never(`[${mode}] getToolSearchOrReadInfo('Bash', ${label})`, () => getToolSearchOrReadInfo('Bash', input, tools))
    }
    // The streaming projection: a virtual assistant row whose tool_use carries
    // the block-start placeholder — what the transcript paints before any
    // argument byte arrives.
    const streaming = use('call_stream', 'Bash', {}, { isVirtual: true })
    const walked = never(`[${mode}] the walk survives the streaming placeholder row`, () => collapseReadSearchGroups([streaming as never], tools))
    t(`[${mode}] the placeholder row is still in the output`, Array.isArray(walked) && (walked as unknown[]).length === 1)
    // The settled no-op: a Bash call whose arguments were `{}` on the wire,
    // with its validation-error result.
    const noop = [use('call_noop', 'Bash', {}), result('call_noop', 'InputValidationError: command is required')]
    never(`[${mode}] the walk survives a settled {} no-op call and its result`, () => collapseReadSearchGroups(noop as never, tools))
    never(`[${mode}] the walk survives a null input`, () => collapseReadSearchGroups([use('call_null', 'Bash', null)] as never, tools))
    // Real runs still collapse around a placeholder row.
    const run = [
      use('g1', 'Grep', { pattern: 'foo', path: 'src' }), result('g1', 'src/a.ts:1:foo'),
      use('r1', 'Read', { file_path: '/tmp/a.ts' }), result('r1', 'contents'),
      use('s1', 'Bash', {}), result('s1', 'InputValidationError'),
      use('g2', 'Grep', { pattern: 'bar' }), result('g2', 'src/b.ts:2:bar'),
    ]
    const out = never(`[${mode}] a real search/read run around a placeholder still walks`, () => collapseReadSearchGroups(run as never, tools)) as Array<{ type: string }>
    if (Array.isArray(out)) {
      t(`[${mode}] the run still produces a collapsed row`, out.some(m => m.type === 'collapsed_read_search'), out.map(m => m.type).join(','))
    }
  }
  delete process.env.MERCURY_FULLSCREEN
}

// —— 3. the seam ————————————————————————————————————————————————————
console.log('── 3. the seam ──')
{
  const skeleton = {
    inputSchema: z.object({}),
    maxResultSizeChars: 1,
    async description() { return 'x' },
    async prompt() { return 'x' },
    async call() { return { data: null } as never },
    mapToolResultToToolResultBlockParam: () => ({ type: 'tool_result', tool_use_id: 'x', content: '' }) as never,
  }
  const throwing = buildTool({
    ...skeleton,
    name: 'ThrowingClassifier',
    isSearchOrReadCommand: () => { throw new TypeError("Cannot read properties of undefined (reading 'trim')") },
  } as never)
  const plain = buildTool({ ...skeleton, name: 'NoClassifier' } as never)
  const thrown = never('a throwing classifier never escapes the seam', () => safeSearchOrReadClassification(throwing as never, {}))
  t('a throwing classifier reads as "uncollapsed" (undefined)', thrown === undefined)
  t('a tool without a classifier reads as undefined', safeSearchOrReadClassification(plain as never, { command: 'ls' }) === undefined)
  t('an absent tool reads as undefined', safeSearchOrReadClassification(undefined, { command: 'ls' }) === undefined)
  t('a real classifier still answers through the seam', safeSearchOrReadClassification(GrepTool as never, {})?.isSearch === true)
  const { collapseReadSearchGroups } = await import('../../src/utils/collapseReadSearch.ts')
  const row = {
    type: 'assistant', uuid: '00000000-0000-4000-8000-00000000ffff', timestamp: new Date().toISOString(),
    message: { id: 'mx', role: 'assistant', type: 'message', model: 'x', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'tx', name: 'ThrowingClassifier', input: {} }] },
  }
  const out = never("the collapse walk renders a throwing classifier's row uncollapsed", () => collapseReadSearchGroups([row as never], [throwing] as never)) as Array<{ type: string }>
  t('…as the assistant row itself', Array.isArray(out) && out.length === 1 && out[0]!.type === 'assistant')
}

// —— 4. the class sweep over every built-in ———————————————————————————
console.log('── 4. class sweep ──')
{
  try {
    const cfg = await import('../../src/utils/config.ts')
    ;(cfg as { enableConfigs?: () => void }).enableConfigs?.()
  } catch {
    // the registry reads no config on this tree
  }
  const { getAllBaseTools } = await import('../../src/tools.ts')
  const tools = getAllBaseTools()
  t('the registry resolved a real catalogue', tools.length > 20, `${tools.length} tools`)
  const HOOKS = ['isSearchOrReadCommand', 'getToolUseSummary', 'getActivityDescription', 'userFacingName'] as const
  const throws: string[] = []
  for (const tool of tools) {
    for (const hook of HOOKS) {
      const fn = (tool as unknown as Record<string, unknown>)[hook]
      if (typeof fn !== 'function') continue
      for (const [label, input] of PLACEHOLDERS) {
        try {
          ;(fn as (input: unknown) => unknown).call(tool, input)
        } catch (error) {
          throws.push(`${tool.name}.${hook}(${label}): ${(error as Error).message}`)
        }
      }
    }
  }
  t('no built-in render-path hook throws on the placeholder family', throws.length === 0, throws.slice(0, 8).join(' | '))
}

// —— 5. structural pins —————————————————————————————————————————————
console.log('── 5. structural pins ──')
{
  const toolTs = readFileSync('src/Tool.ts', 'utf8')
  t('the classifier contract narrows from unknown', /isSearchOrReadCommand\?: \(input: unknown\) => SearchOrReadClassification/.test(toolTs))
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, out)
      else if (/\.tsx?$/.test(entry.name)) out.push(path)
    }
    return out
  }
  const widened: string[] = []
  const direct: string[] = []
  for (const file of walk('src')) {
    const text = readFileSync(file, 'utf8')
    if (/isSearchOrReadCommand\?*\.?\(.*as never\)/.test(text)) widened.push(file)
    const owner = file === join('src', 'Tool.ts') || file.startsWith(join('src', 'tools')) || file.startsWith(join('src', 'services', 'mcp'))
    if (!owner && /\.isSearchOrReadCommand\?*\(/.test(text)) direct.push(file)
  }
  t('no classifier call site widens raw input with a cast', widened.length === 0, widened.join(', '))
  t('every classifier consumer goes through the seam', direct.length === 0, direct.join(', '))
  const messages = readFileSync('src/components/Messages.tsx', 'utf8')
  t('the transcript list wraps each row in the per-row boundary', /<SentryErrorBoundary>\s*<MessageRow/.test(messages) && /\/>\s*<\/SentryErrorBoundary>/.test(messages))
}

// —— 6. the per-row boundary mechanism, live ————————————————————————
console.log('── 6. per-row boundary ──')
{
  const React = await import('react')
  const { default: Ink } = await import('../../src/ink/ink.js')
  const { Box, Text } = await import('../../src/ink.js')
  const { SentryErrorBoundary } = await import('../../src/components/SentryErrorBoundary.js')
  class FakeStdout extends EventEmitter {
    isTTY = true
    // Wide enough that the fallback line (glyph + sentence + the crash
    // directory path) never wraps and splits a needle across rows.
    columns = 260
    rows = 12
    bytes = ''
    write(s: string): boolean {
      this.bytes += s
      return true
    }
  }
  class FakeStdin extends EventEmitter {
    isTTY = true
    isRaw = false
    readableLength = 0
    setEncoding(): FakeStdin { return this }
    setRawMode(v: boolean): FakeStdin { this.isRaw = v; return this }
    ref(): FakeStdin { return this }
    unref(): FakeStdin { return this }
    read(): null { return null }
  }
  const stdout = new FakeStdout()
  const ink = new Ink({ stdout: stdout as never, stdin: new FakeStdin() as never, stderr: new FakeStdout() as never, exitOnCtrlC: false, patchConsole: false })
  const Thrower = (): never => {
    throw new TypeError("Cannot read properties of undefined (reading 'trim')")
  }
  const h = React.createElement
  ink.render(
    h(Box, { flexDirection: 'column' },
      h(Text, null, 'row-before-the-broken-one'),
      h(SentryErrorBoundary, null, h(Thrower, null)),
      h(Text, null, 'row-after-the-broken-one')),
  )
  await new Promise(resolve => setTimeout(resolve, 200))
  // Strip CSI / OSC / charset sequences so the needles match painted text.
  const escapes = /\u001b(?:\[[0-9;?<>=]*[a-zA-Z@`]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[()][0-9A-B])/g
  // Cells reach the stream behind absolute cursor moves, so the painted text
  // is compared with every whitespace removed.
  const painted = stdout.bytes.replace(escapes, '').replace(/\s+/g, '')
  t('the row before the broken one paints', painted.includes('row-before-the-broken-one'))
  t('the row after the broken one paints', painted.includes('row-after-the-broken-one'))
  t('the broken row degrades to its fallback line', painted.includes('couldnotberendered'), painted.slice(-400))
  t('the app-root boundary never trips', !painted.includes('hadtoclose') && !painted.includes('RestartMercury'))
  const crashes = join(process.env.MERCURY_CONFIG_DIR!, 'crashes')
  const reports = existsSync(crashes) ? readdirSync(crashes) : []
  t('a message-boundary crash report was retained under the config home', reports.some(f => f.includes('message-boundary')), reports.join(','))
  t('…and no app-root report', !reports.some(f => f.includes('app-root')), reports.join(','))
  ink.unmount()
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL GREEN' : '\nRED')
process.exit(failures)
