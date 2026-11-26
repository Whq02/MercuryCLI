#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tool-row-lead-'))
process.env.FORCE_COLOR = '3'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()

const React = (await import('react')).default
const { Box, Text } = await import('../../src/screen/themedRenderer.js')
const { renderToAnsiString } = await import('../../src/screen/renderer/staticRender.tsx')
const { AssistantToolUseMessage } = await import('../../src/screen/messages/AssistantToolUseMessage.js')
const { CollapsedReadSearchContent } = await import('../../src/screen/messages/CollapsedReadSearchContent.js')
const { UserCrewmateNotificationMessage } = await import('../../src/screen/messages/UserCrewmateNotificationMessage.js')
const { MessageMetaProvider } = await import('../../src/screen/messages/TranscriptNameplate.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { useMercuryTokens } = await import('../../src/screen/widgets/useMercuryTokens.js')
const { GLYPH } = await import('../../src/screen/theme/glyphs.js')

type Cell = { ch: string; fg: string; dim: boolean }
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}${cond ? '' : ' [change the row lead in ToolRowLead (src/screen/messages/ToolRowLead.tsx), AssistantToolUseMessage (src/screen/messages/AssistantToolUseMessage.tsx), CollapsedReadSearchContent (src/screen/messages/CollapsedReadSearchContent.tsx), or UserCrewmateNotificationMessage (src/screen/messages/UserCrewmateNotificationMessage.tsx)]'}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

function cellsOf(ansiRow: string): Cell[] {
  const cells: Cell[] = []
  let fg = ''
  let dim = false
  let at = 0
  while (at < ansiRow.length) {
    if (ansiRow[at] === '\x1b' && ansiRow[at + 1] === '[') {
      const end = ansiRow.indexOf('m', at)
      if (end === -1) break
      const codes = ansiRow.slice(at + 2, end).split(';').map(Number)
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]!
        if (code === 0) {
          fg = ''
          dim = false
        } else if (code === 2) dim = true
        else if (code === 22) dim = false
        else if (code === 39) fg = ''
        else if (code === 38 && codes[i + 1] === 2) {
          fg = `#${[codes[i + 2], codes[i + 3], codes[i + 4]].map(v => (v ?? 0).toString(16).padStart(2, '0')).join('')}`
          i += 4
        } else if (code === 38 && codes[i + 1] === 5) {
          fg = `256:${codes[i + 2]}`
          i += 2
        } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = `ansi:${code}`
      }
      at = end + 1
      continue
    }
    const point = ansiRow.codePointAt(at)!
    const ch = String.fromCodePoint(point)
    cells.push({ ch, fg, dim })
    at += ch.length
  }
  return cells
}

const TOOL_ID = 'toolu_lead_01'
const STAMP = '2026-10-06T07:00:00.000Z'
const PLATE_RE = /^\d\d:\d\d:\d\d \[Mercury\] /
const STATE_GLYPHS = [GLYPH.done, GLYPH.inProgress, GLYPH.read, GLYPH.warn, '◓', '◑', '◒', GLYPH.spark]

type RowState = 'queued' | 'running' | 'done' | 'error' | 'denied'
const STATES: RowState[] = ['queued', 'running', 'done', 'error', 'denied']

function lookupsFor(state: RowState, id = TOOL_ID): unknown {
  const settled = state !== 'queued' && state !== 'running'
  return {
    siblingToolUseIDs: new Map(),
    progressMessagesByToolUseID: new Map(),
    inProgressHookCounts: new Map(),
    resolvedHookCounts: new Map(),
    toolResultByToolUseID: new Map(),
    toolUseByToolUseID: new Map(),
    normalizedMessageCount: 1,
    resolvedToolUseIDs: new Set(settled ? [id] : []),
    erroredToolUseIDs: new Set(state === 'error' || state === 'denied' ? [id] : []),
    deniedToolUseIDs: new Set(state === 'denied' ? [id] : []),
  }
}

function stubTool(name: string): unknown {
  return { name, userFacingName: () => name, renderToolUseMessage: () => 'the target' }
}

function toolRowNode(name: string, state: RowState, id = TOOL_ID): React.ReactNode {
  return React.createElement(
    MessageMetaProvider as never,
    { message: { type: 'assistant', timestamp: STAMP } },
    React.createElement(AssistantToolUseMessage as never, {
      param: { type: 'tool_use', id, name, input: {} },
      tools: [stubTool(name)],
      verbose: false,
      inProgressToolUseIDs: new Set(state === 'running' ? [id] : []),
      shouldAnimate: state === 'running',
      shouldShowDot: true,
      lookups: lookupsFor(state, id) as never,
    } as never),
  )
}

async function renderRows(node: React.ReactNode): Promise<{ ansi: string[]; text: string[] }> {
  const frame = await renderToAnsiString(React.createElement(AppStateProvider as never, {}, node) as never, 100)
  const ansi = frame.split('\n')
  return { ansi, text: ansi.map(row => stripAnsi(row).replace(/\s+$/, '')) }
}

const tokens: Record<string, string> = {}
{
  function Probe(): React.ReactNode {
    const t = useMercuryTokens() as unknown as Record<string, string>
    return React.createElement(
      Text as never,
      {},
      ['failure'].map(k => `${k}=${(t[k] ?? '').toLowerCase()}`).join(' '),
    )
  }
  const probe = await renderRows(React.createElement(Probe))
  for (const pair of probe.text.join(' ').split(' ')) {
    const [k, v] = pair.split('=')
    if (k && v) tokens[k] = v
  }
  check('the probe read the live failure token', typeof tokens.failure === 'string' && /^#[0-9a-f]{6}$/.test(tokens.failure), JSON.stringify({ tokens }))
}

const representative: ReadonlyArray<readonly [string, string]> = [
  ['shell', 'Bash'],
  ['read', 'Read'],
  ['search', 'Grep'],
  ['edit', 'Edit'],
  ['write', 'Write'],
  ['diff', 'Git'],
  ['browser', 'Browser'],
  ['agent', 'Crewmate'],
  ['plan', 'Sleep'],
  ['test', 'Test'],
  ['memory', 'Recall'],
  ['system', 'AskUserQuestion'],
  ['external', 'Blender'],
]
section('§1 one row per family in every state: two-cell lead keeps one column; ✕ in failure tone leads error/denied')
const nameColumns = new Set<number>()
for (const [family, name] of representative) {
  for (const state of STATES) {
    const { ansi, text } = await renderRows(toolRowNode(name, state))
    const rowIndex = text.findIndex(row => row.includes(name))
    const row = text[rowIndex] ?? ''
    const tag = `${family}/${name} ${state}`
    check(`${tag}: the row paints under the nameplate`, rowIndex >= 0 && PLATE_RE.test(row), JSON.stringify(row))
    const body = row.replace(PLATE_RE, '')
    check(`${tag}: no state dot or ring on the row`, !STATE_GLYPHS.some(glyph => row.includes(glyph)), JSON.stringify(row))
    nameColumns.add(row.indexOf(name))
    const plateWidth = (PLATE_RE.exec(row)?.[0] ?? '').length
    const cells = cellsOf(ansi[rowIndex] ?? '').filter(cell => cell.ch !== '\x1b')
    if (state === 'denied' || state === 'error') {
      check(`${tag}: the lead in column one of the row body is ${GLYPH.fail}`, body.startsWith(`${GLYPH.fail} ${name}`), JSON.stringify(body))
      const lead = cells[plateWidth]
      check(`${tag}: the lead wears the failure tone`, lead !== undefined && lead.fg === tokens.failure, `${JSON.stringify(lead)} want ${tokens.failure}`)
    } else {
      check(`${tag}: the two-cell blank lead precedes the tool name`, body.startsWith(`  ${name}`), JSON.stringify(body))
    }
  }
}
check('the tool name starts at one column across every family and state', nameColumns.size === 1, [...nameColumns].join(','))
section('§2 a mixed turn: group, read, edit, agent rows align; the notice row keeps its dot')
{
  const groupMessage = {
    type: 'collapsed_read_search',
    searchCount: 1,
    readCount: 2,
    listCount: 0,
    memorySearchCount: 0,
    memoryReadCount: 0,
    memoryWriteCount: 0,
    readFilePaths: ['/scratch/a.ts', '/scratch/b.ts'],
    searchArgs: ['lead'],
    latestDisplayHint: undefined,
    messages: [],
    displayMessage: undefined,
    uuid: 'group-1',
    timestamp: STAMP,
  }
  const group = React.createElement(
    MessageMetaProvider as never,
    { message: { type: 'collapsed_read_search', timestamp: STAMP } },
    React.createElement(CollapsedReadSearchContent as never, {
      message: groupMessage,
      inProgressToolUseIDs: new Set(),
      shouldAnimate: false,
      verbose: false,
      tools: [],
      lookups: lookupsFor('done', 'none') as never,
      isActiveGroup: false,
    } as never),
  )
  const notice = React.createElement(
    MessageMetaProvider as never,
    { message: { type: 'user', timestamp: STAMP } },
    React.createElement(UserCrewmateNotificationMessage as never, {
      param: { type: 'text', text: '<summary>Agent "the errand" completed</summary><status>completed</status>' },
    } as never),
  )
  const turn = React.createElement(
    Box as never,
    { flexDirection: 'column' },
    group,
    toolRowNode('Read', 'done', 'toolu_lead_read'),
    toolRowNode('Edit', 'done', 'toolu_lead_edit'),
    notice,
    toolRowNode('Crewmate', 'running', 'toolu_lead_agent'),
  )
  const { text } = await renderRows(turn)
  const rows = text.filter(row => row.trim() !== '')
  console.log(rows.map(row => `    ${row}`).join('\n'))
  const groupRow = rows.find(row => row.includes('Searched for')) ?? ''
  const readRow = rows.find(row => /\bRead\b/.test(row) && !row.includes('Searched')) ?? ''
  const editRow = rows.find(row => /\bEdit\b/.test(row)) ?? ''
  const agentRow = rows.find(row => /\bCrewmate\b/.test(row) && !row.includes('completed')) ?? ''
  const noticeRow = rows.find(row => row.includes('completed')) ?? ''
  const bodyOf = (row: string): string => row.replace(PLATE_RE, '')
  check('the group row has a two-cell blank lead before its sentence', bodyOf(groupRow).startsWith('  Searched for'), JSON.stringify(groupRow))
  check('the read row has a two-cell blank lead before Read', bodyOf(readRow).startsWith('  Read'), JSON.stringify(readRow))
  check('the edit row has a two-cell blank lead before Edit', bodyOf(editRow).startsWith('  Edit'), JSON.stringify(editRow))
  check('the running agent row has a two-cell blank lead before Crewmate', bodyOf(agentRow).startsWith('  Crewmate'), JSON.stringify(agentRow))
  const columns = new Set([groupRow, readRow, editRow, agentRow].map(row => (PLATE_RE.exec(row)?.[0] ?? '').length + 2))
  const wordColumns = new Set([groupRow.indexOf('Searched'), readRow.indexOf('Read'), editRow.indexOf('Edit'), agentRow.indexOf('Crewmate')])
  check('the words of every tool row start at one column (the alignment law)', columns.size === 1 && wordColumns.size === 1 && [...wordColumns][0] === [...columns][0], `${[...wordColumns].join(',')} want ${[...columns].join(',')}`)
  check('no tool row of the turn carries a state dot or ring', [groupRow, readRow, editRow, agentRow].every(row => !STATE_GLYPHS.some(glyph => row.includes(glyph))), JSON.stringify([groupRow, readRow, editRow, agentRow]))
  check('the notice row keeps its dot', /^\d\d:\d\d:\d\d ● \[Crewmate\] the errand · completed · 1 line ›/.test(noticeRow), JSON.stringify(noticeRow))
}

section('§3 the collapsed group in its states: the lead follows the sentence and the state')
{
  const base = {
    type: 'collapsed_read_search',
    searchCount: 0,
    readCount: 3,
    listCount: 0,
    memorySearchCount: 0,
    memoryReadCount: 0,
    memoryWriteCount: 0,
    readFilePaths: ['/scratch/a.ts'],
    searchArgs: [],
    latestDisplayHint: undefined,
    messages: [],
    displayMessage: undefined,
    uuid: 'group-2',
    timestamp: STAMP,
  }
  const member = (id: string) => ({
    type: 'assistant',
    uuid: `m-${id}`,
    timestamp: STAMP,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/scratch/a.ts' } }] },
  })
  const renderGroup = async (state: RowState) => {
    const id = 'toolu_group_member'
    const message = { ...base, messages: [member(id)], displayMessage: member(id) }
    const node = React.createElement(
      MessageMetaProvider as never,
      { message: { type: 'collapsed_read_search', timestamp: STAMP } },
      React.createElement(CollapsedReadSearchContent as never, {
        message,
        inProgressToolUseIDs: new Set(state === 'running' ? [id] : []),
        shouldAnimate: state === 'running',
        verbose: false,
        tools: [stubTool('Read')],
        lookups: lookupsFor(state, id) as never,
        isActiveGroup: state === 'running',
      } as never),
    )
    const { ansi, text } = await renderRows(node)
    const index = text.findIndex(row => /Read(?:ing)? /.test(row))
    const row = text[index] ?? ''
    const plateWidth = (PLATE_RE.exec(row)?.[0] ?? '').length
    return { row, body: row.replace(PLATE_RE, ''), lead: cellsOf(ansi[index] ?? '')[plateWidth] }
  }
  const running = await renderGroup('running')
  check('a running group has a two-cell blank lead before the present-tense sentence', running.body.startsWith('  Reading '), JSON.stringify(running))
  const done = await renderGroup('done')
  check('a settled group has a two-cell blank lead before the past-tense sentence', done.body.startsWith('  Read '), JSON.stringify(done))
  const errored = await renderGroup('error')
  check('a group with an errored member leads with ✕ in the failure tone', errored.body.startsWith(`${GLYPH.fail} Read `) && errored.lead?.fg === tokens.failure, JSON.stringify(errored))
  const denied = await renderGroup('denied')
  check('a group with a denied member leads with ✕ in the failure tone', denied.body.startsWith(`${GLYPH.fail} Read `) && denied.lead?.fg === tokens.failure, JSON.stringify(denied))
  check('no group row carries a state dot or ring', [running, done, errored, denied].every(r => !STATE_GLYPHS.some(glyph => r.row.includes(glyph))))
}

console.log(failures === 0 ? '\n✅ TOOL ROW LEAD LAW HOLDS (bold name leads pending/done; ✕ leads error/denied; notices keep their dot)' : `\n❌ ${failures} TOOL ROW LEAD CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
