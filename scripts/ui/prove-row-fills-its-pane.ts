#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'row-pane-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const pin of ['MERCURY_CRITTER_IDLE', 'MERCURY_CRITTER_GAZE', 'MERCURY_CRITTER_SLEEP', 'MERCURY_LIVE_CLOCK', 'MERCURY_LIVE_GLYPHS']) {
  process.env[pin] = '0'
}
process.env.FORCE_COLOR = '3'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { renderToAnsiString } = await import('../../src/utils/staticRender.tsx')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.tsx')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { KeybindingProvider } = await import('../../src/keybindings/KeybindingContext.tsx')
const { loadKeybindingsSync } = await import('../../src/keybindings/loadUserBindings.ts')
const { MessageRow, hasContentAfterIndex } = await import('../../src/components/MessageRow.tsx')
const { deriveTranscriptRows } = await import('../../src/components/concourse/workerTranscriptFold.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { EMPTY_STRING_SET } = await import('../../src/utils/messages.ts')
const { stringWidth } = await import('../../src/ink/stringWidth.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const h = React.createElement as (...a: unknown[]) => React.ReactElement

const TERMINAL_COLUMNS = 120
const PANE_COLUMNS = 60
const uuidAt = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const stampAt = (n: number): string => `2026-06-19T12:00:${String(n).padStart(2, '0')}.000Z`
const FILE = '/tmp/pane-fixture/sums.ts'
const hunk = {
  oldStart: 1,
  oldLines: 4,
  newStart: 1,
  newLines: 4,
  lines: [
    ' export function sum(a: number, b: number): number {',
    '-  return a + b + 0',
    '+  return a + b',
    ' }',
    ' export const total = sum(2, 2)',
  ],
}
const messages = [
  { type: 'user', uuid: uuidAt(1), timestamp: stampAt(1), message: { role: 'user', content: 'drop the dead add' } },
  {
    type: 'assistant',
    uuid: uuidAt(2),
    timestamp: stampAt(2),
    requestId: undefined,
    message: {
      id: 'msg_pane_1',
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [{ type: 'tool_use', id: 'toolu_pane_1', name: FileEditTool.name, input: { file_path: FILE, old_string: 'a + b + 0', new_string: 'a + b' } }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  },
  {
    type: 'user',
    uuid: uuidAt(3),
    timestamp: stampAt(3),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_pane_1', content: 'ok' }] },
    toolUseResult: {
      filePath: FILE,
      oldString: 'a + b + 0',
      newString: 'a + b',
      originalFile: 'export function sum(a: number, b: number): number {\n  return a + b + 0\n}\nexport const total = sum(2, 2)\n',
      structuredPatch: [hunk],
      userModified: false,
      replaceAll: false,
    },
  },
]
const tools = [FileEditTool] as never

function MinimalKeybindingProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const pendingChordRef = React.useRef(null)
  const handlerRegistryRef = React.useRef(new Map())
  return h(
    KeybindingProvider as never,
    {
      bindings: loadKeybindingsSync(),
      pendingChordRef,
      pendingChord: null,
      setPendingChord: () => {},
      activeContexts: new Set(),
      registerActiveContext: () => {},
      unregisterActiveContext: () => {},
      handlerRegistryRef,
    },
    children,
  )
}

function PaneRows({ columns }: { columns: number }): React.ReactElement {
  const derived = deriveTranscriptRows(messages as never, tools)
  return h(
    React.Fragment,
    null,
    ...derived.collapsed.map((m, i) =>
      h(MessageRow as never, {
        key: m.uuid,
        message: m,
        isUserContinuation: false,
        hasContentAfter:
          m.type === 'collapsed_read_search' && hasContentAfterIndex(derived.collapsed as never, i, tools, EMPTY_STRING_SET as Set<string>),
        tools,
        commands: [],
        verbose: false,
        inProgressToolUseIDs: derived.inProgress,
        streamingToolUseIDs: EMPTY_STRING_SET,
        screen: 'prompt',
        canAnimate: false,
        lastThinkingBlockId: null,
        latestBashOutputUUID: null,
        columns,
        isLoading: false,
        lookups: derived.lookups,
      }),
    ),
  )
}

async function paint(reprovide: boolean): Promise<string> {
  const rows = h(PaneRows, { columns: PANE_COLUMNS })
  const inner = reprovide ? h(TerminalSizeContext.Provider, { value: { columns: PANE_COLUMNS, rows: 40 } }, rows) : rows
  const tree = h(AppStateProvider as never, null, h(MinimalKeybindingProvider, null, inner))
  return renderToAnsiString(tree, TERMINAL_COLUMNS)
}

type Cell = { ch: string; styled: boolean }
function cellsOf(line: string): Cell[] {
  const cells: Cell[] = []
  const on = new Set<string>()
  let i = 0
  while (i < line.length) {
    if (line[i] !== '\x1b') {
      cells.push({ ch: line[i]!, styled: on.size > 0 })
      i++
      continue
    }
    const csi = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(line.slice(i))
    if (csi) {
      if (csi[2] === 'm') {
        const params = csi[1] === '' ? [0] : csi[1]!.split(';').map(p => (p === '' ? 0 : Number(p)))
        for (let k = 0; k < params.length; k++) {
          const p = params[k]!
          if (p === 0) on.clear()
          else if (p === 1 || p === 2) on.add('weight')
          else if (p === 3) on.add('italic')
          else if (p === 4) on.add('underline')
          else if (p === 7) on.add('inverse')
          else if (p === 9) on.add('strike')
          else if (p === 22) on.delete('weight')
          else if (p === 23) on.delete('italic')
          else if (p === 24) on.delete('underline')
          else if (p === 27) on.delete('inverse')
          else if (p === 29) on.delete('strike')
          else if (p === 39) on.delete('fg')
          else if (p === 49) on.delete('bg')
          else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) on.add('fg')
          else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) on.add('bg')
          else if (p === 38 || p === 48) {
            on.add(p === 38 ? 'fg' : 'bg')
            k += params[k + 1] === 2 ? 4 : params[k + 1] === 5 ? 2 : 0
          }
        }
      }
      i += csi[0].length
      continue
    }
    const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(line.slice(i))
    if (osc) {
      i += osc[0].length
      continue
    }
    i++
  }
  return cells
}
function escapes(frame: string, limit: number): Array<{ row: number; col: number; ch: string; styled: boolean }> {
  const out: Array<{ row: number; col: number; ch: string; styled: boolean }> = []
  frame.split('\n').forEach((line, row) => {
    let col = 0
    for (const cell of cellsOf(line)) {
      if (col >= limit && (cell.styled || cell.ch !== ' ')) out.push({ row, col, ch: cell.ch, styled: cell.styled })
      col += Math.max(1, stringWidth(cell.ch))
    }
  })
  return out
}
const plain = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')

function diffRowsOf(lines: string[]): Set<number> {
  const rows = new Set<number>()
  lines.forEach((line, i) => {
    if (/^│\s+\d+\s[-+ ]/.test(line)) rows.add(i)
    else if (i > 0 && rows.has(i - 1) && /^│\s{6,}\S/.test(line) && !/└/.test(line)) rows.add(i)
  })
  return rows
}

section('§1 the law: a diff row under a 60-column pane on a 120-column render stays inside the pane')
{
  const frame = await paint(true)
  const text = plain(frame)
  const lines = text.split('\n')
  check('the row painted the edit (the diff body is on screen)', text.includes('return a + b') && text.includes('sums.ts'), text.slice(0, 400))
  const diffRows = diffRowsOf(lines)
  const numbered = lines.filter(l => /^│\s+\d+\s[-+ ]/.test(l)).length
  check('the diff painted every hunk line', numbered >= hunk.lines.length, `${numbered} numbered row(s) in:\n${lines.map((l, i) => `      ${String(i).padStart(2)}${diffRows.has(i) ? '*' : ' '} ${l}`).join('\n')}`)
  const out = escapes(frame, PANE_COLUMNS)
  const onDiff = out.filter(o => diffRows.has(o.row))
  const rowText = (r: number): string => JSON.stringify(lines[r] ?? '')
  check('no styled byte and no glyph past column 60 on any diff row (the band and the rules fill the pane, never the terminal)', onDiff.length === 0, `${onDiff.length} escaped cell(s): ${JSON.stringify(onDiff.slice(0, 6))} — ${[...new Set(onDiff.map(o => o.row))].map(r => `row ${r}: ${rowText(r)}`).join(' | ')}`)
  const widest = [...diffRows].reduce((w, r) => Math.max(w, stringWidth((lines[r] ?? '').replace(/\s+$/, ''))), 0)
  check('the widest diff row fits the pane', widest <= PANE_COLUMNS, `widest diff row ${widest} > ${PANE_COLUMNS}`)
  const elsewhere = [...new Set(out.filter(o => !diffRows.has(o.row)).map(o => o.row))]
  for (const r of elsewhere) console.log(`  [NOTE] a non-diff row leaves the pane — row ${r}: ${rowText(r)}`)
}

section('§1b the rules: the consent card\'s diff under the same pane frames itself inside it')
{
  const { FileEditToolDiff } = await import('../../src/components/FileEditToolDiff.tsx')
  const card = h(FileEditToolDiff as never, { file_path: FILE, edits: [{ old_string: 'a + b + 0', new_string: 'a + b' }] })
  const tree = h(
    AppStateProvider as never,
    null,
    h(MinimalKeybindingProvider, null, h(TerminalSizeContext.Provider, { value: { columns: PANE_COLUMNS, rows: 40 } }, card)),
  )
  const frame = await renderToAnsiString(tree, TERMINAL_COLUMNS)
  const lines = plain(frame).split('\n')
  const rules = lines.filter(l => l.includes('╌'))
  check('the card painted its rules', rules.length >= 2, `${rules.length} rule row(s): ${JSON.stringify(lines.slice(0, 6))}`)
  const widest = rules.reduce((w, l) => Math.max(w, stringWidth(l.replace(/\s+$/, ''))), 0)
  check('the rules span the pane, never the terminal', widest <= PANE_COLUMNS && widest >= PANE_COLUMNS - 4, `widest rule ${widest} (pane ${PANE_COLUMNS})`)
  const out = escapes(frame, PANE_COLUMNS)
  check('no styled byte and no glyph past column 60 on the card', out.length === 0, `${out.length} escaped cell(s): ${JSON.stringify(out.slice(0, 6))}`)
}

section('§2 the control — the trap, documented: a narrowed columns prop under a wide context escapes')
{
  const frame = await paint(false)
  const out = escapes(frame, PANE_COLUMNS)
  check('CONTROL: with the context left at the terminal width the band paints past the pane (why a pane must re-provide the context)', out.length > 0, 'the band stayed inside the pane without a re-provision — the trap has moved; re-read the owners')
}

section('§3 the census: every transcript-row host, and every narrower host re-provides the size context')
{
  const hits = execSync(`grep -rlE '<(MessageRow|Messages)\\b' src/components src/screens src/utils src/tools src/commands 2>/dev/null || true`, {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort()
  const FULL_WIDTH = ['src/components/Messages.tsx', 'src/screens/REPL.tsx', 'src/utils/exportRenderer.tsx']
  const NARROWER: Array<{ file: string; measure: RegExp }> = [
    { file: 'src/components/concourse/SessionMirror.tsx', measure: /columns:\s*paneWidth,\s*rows:\s*paneRows/ },
    { file: 'src/components/SessionPreview.tsx', measure: /columns:\s*Math\.max\(\d+,\s*columns\s*-\s*4\)/ },
  ]
  const inventory = [...FULL_WIDTH, ...NARROWER.map(n => n.file)].sort()
  check('the row-host census matches the inventory', JSON.stringify(hits) === JSON.stringify(inventory), `found: ${hits.join(', ') || '(none)'}`)
  for (const host of NARROWER) {
    const src = readFileSync(join(ROOT, host.file), 'utf8')
    check(`${host.file} re-provides the size context from its own measure`, /TerminalSizeContext\.Provider\s+value=\{/.test(src) && host.measure.test(src), 'no narrowed TerminalSizeContext.Provider around its rows, or a measure that is not the pane\'s own')
  }
}

console.log(failures === 0 ? '\nprove-row-fills-its-pane: ALL LAWS HOLD' : `\nprove-row-fills-its-pane: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
