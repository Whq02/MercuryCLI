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
const { MessageRow } = await import('../../src/screen/messages/MessageRow.js')
const { CrewmateTool } = await import('../../src/tools/crewmate/CrewmateTool.js')
const { ReadTool } = await import('../../src/tools/read/ReadTool.js')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.js')
const { createSystemMessage } = await import('../../src/engine/message-shapes/systemMessages.js')
const { createAttachmentMessage } = await import('../../src/engine/attachment-shapes/attachmentMessage.js')
const { normalizeMessages } = await import('../../src/engine/message-shapes/normalize.js')
const { buildMessageLookups } = await import('../../src/engine/messages/lookups.js')
const { MessageMetaProvider, NameplateContinuationContext } = await import('../../src/screen/messages/TranscriptNameplate.js')
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
const PLATE_RE = /^(?:  |✕ )\d\d:\d\d:\d\d \[Mercury\] /
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
section('§1 one row per family in every state: two-cell left lead keeps one column; single space between nameplate, tool name and target')
const nameColumns = new Set<number>()
for (const [family, name] of representative) {
  for (const state of STATES) {
    const { ansi, text } = await renderRows(toolRowNode(name, state))
    const rowIndex = text.findIndex(row => row.includes(name))
    const row = text[rowIndex] ?? ''
    const tag = `${family}/${name} ${state}`
    check(`${tag}: the row paints with the two-cell left lead and nameplate`, rowIndex >= 0 && PLATE_RE.test(row), JSON.stringify(row))
    const body = row.replace(PLATE_RE, '')
    check(`${tag}: no state dot or ring on the row`, !STATE_GLYPHS.some(glyph => row.includes(glyph)), JSON.stringify(row))
    check(`${tag}: single space separates nameplate, tool name and target`, body === `${name} the target`, JSON.stringify(body))
    nameColumns.add(row.indexOf(name))
    const cells = cellsOf(ansi[rowIndex] ?? '').filter(cell => cell.ch !== '\x1b')
    if (state === 'denied' || state === 'error') {
      check(`${tag}: column one of the row is ${GLYPH.fail} followed by one space`, row.startsWith(`${GLYPH.fail} `), JSON.stringify(row))
      const lead = cells[0]
      check(`${tag}: the lead wears the failure tone`, lead !== undefined && lead.fg === tokens.failure, `${JSON.stringify(lead)} want ${tokens.failure}`)
    } else {
      check(`${tag}: the two-cell blank lead precedes the nameplate`, row.startsWith('  '), JSON.stringify(row))
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
  check('the group row has one space after the nameplate before its sentence', groupRow.startsWith('  ') && bodyOf(groupRow).startsWith('Searched for'), JSON.stringify(groupRow))
  check('the read row has one space after the nameplate and after Read', readRow.startsWith('  ') && bodyOf(readRow) === 'Read the target', JSON.stringify(readRow))
  check('the edit row has one space after the nameplate and after Edit', editRow.startsWith('  ') && bodyOf(editRow) === 'Edit the target', JSON.stringify(editRow))
  check('the running agent row has one space after the nameplate and after Crewmate', agentRow.startsWith('  ') && bodyOf(agentRow) === 'Crewmate the target', JSON.stringify(agentRow))
  const columns = new Set([groupRow, readRow, editRow, agentRow].map(row => (PLATE_RE.exec(row)?.[0] ?? '').length))
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
    return { row, body: row.replace(PLATE_RE, ''), lead: cellsOf(ansi[index] ?? '')[0] }
  }
  const running = await renderGroup('running')
  check('a running group has a two-cell blank lead before the nameplate and one space before the sentence', running.row.startsWith('  ') && running.body.startsWith('Reading '), JSON.stringify(running))
  const done = await renderGroup('done')
  check('a settled group has a two-cell blank lead before the nameplate and one space before the sentence', done.row.startsWith('  ') && done.body.startsWith('Read '), JSON.stringify(done))
  const errored = await renderGroup('error')
  check('a group with an errored member leads with ✕ in column one in the failure tone', errored.row.startsWith(`${GLYPH.fail} `) && errored.body.startsWith('Read ') && errored.lead?.fg === tokens.failure, JSON.stringify(errored))
  const denied = await renderGroup('denied')
  check('a group with a denied member leads with ✕ in column one in the failure tone', denied.row.startsWith(`${GLYPH.fail} `) && denied.body.startsWith('Read ') && denied.lead?.fg === tokens.failure, JSON.stringify(denied))
  check('no group row carries a state dot or ring', [running, done, errored, denied].every(r => !STATE_GLYPHS.some(glyph => r.row.includes(glyph))))
}

section('§4 grouped_tool_use (crewmate launch) through MessageRow: col-0 lead, col-2 timestamp, one space, col-21 header')
{
  const renderGroupedLaunch = async (mode: 'done' | 'denied') => {
    const ids = ['toolu_grp_1', 'toolu_grp_2', 'toolu_grp_3']
    const rawUses = ids.map((id, i) => ({
      ...createAssistantMessage({
        content: [{ type: 'tool_use', id, name: 'Crewmate', input: { name: `seat-${i + 1}`, description: `seat-${i + 1}`, prompt: 'go', run_in_background: true } }],
      }),
      timestamp: STAMP,
    }))
    const rawResults = ids.map((id, i) => ({
      ...createUserMessage({
        content: [{
          type: 'tool_result',
          tool_use_id: id,
          content: mode === 'denied' && i === 0 ? 'The operator declined this tool call; it was not run and nothing was changed.' : 'launched',
          ...(mode === 'denied' && i === 0 ? { is_error: true } : {}),
        }],
      }),
      ...(mode === 'done' ? { toolUseResult: { status: 'async_launched', agentId: `a${i + 1}` } } : {}),
      timestamp: STAMP,
    }))
    const all = [...rawUses, ...rawResults]
    const normalized = normalizeMessages(all)
    const lookups = buildMessageLookups(normalized, all)
    const assistantRows = normalized.filter(m => m.type === 'assistant')
    const userRows = normalized.filter(m => m.type === 'user')
    const groupedMessage = {
      type: 'grouped_tool_use' as const,
      toolName: 'Crewmate',
      messageId: `msg-grouped-${mode}`,
      messages: assistantRows,
      results: userRows,
      displayMessage: assistantRows[0]!,
      uuid: `grouped-${mode}`,
      timestamp: STAMP,
    }
    const node = React.createElement(
      MessageMetaProvider,
      { message: { type: 'grouped_tool_use', timestamp: STAMP }, children: null },
      React.createElement(MessageRow, {
        message: groupedMessage,
        tools: [CrewmateTool],
        lookups,
        screen: 'prompt',
        columns: 120,
        verbose: false,
        isUserContinuation: true,
        hasContentAfter: false,
        inProgressToolUseIDs: new Set<string>(),
        streamingToolUseIDs: new Set<string>(),
        canAnimate: false,
        isLoading: false,
        lastThinkingBlockId: null,
        latestBashOutputUUID: null,
      }),
    )
    const { ansi, text } = await renderRows(node)
    const index = text.findIndex(row => row.includes('3 background crewmates launched'))
    const row = text[index] ?? ''
    return { row, body: row.replace(PLATE_RE, ''), lead: cellsOf(ansi[index] ?? '')[0] }
  }
  const done = await renderGroupedLaunch('done')
  const denied = await renderGroupedLaunch('denied')
  const wantCol = [...nameColumns][0]
  check('grouped launch (done) paints two-cell blank lead, col-2 nameplate and one space before the header', PLATE_RE.test(done.row) && done.row.startsWith('  ') && done.body === '3 background crewmates launched', JSON.stringify(done))
  check('grouped launch (denied) paints ✕ in column one in the failure tone, col-2 nameplate and one space before the header', PLATE_RE.test(denied.row) && denied.row.startsWith(`${GLYPH.fail} `) && denied.body === '3 background crewmates launched' && denied.lead?.fg === tokens.failure, JSON.stringify(denied))
  check('grouped launch headers align to the same tool-name column as every single tool row', done.row.indexOf('3 background') === wantCol && denied.row.indexOf('3 background') === wantCol, JSON.stringify({ doneCol: done.row.indexOf('3 background'), deniedCol: denied.row.indexOf('3 background'), wantCol }))
}

section('§5 call-tied hook attachments and informational system rows keep the 2-cell MessageRow pad')
{
  const id = 'toolu_hook_1'
  const callRow = { ...createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/scratch/a.ts' } }] }), timestamp: STAMP }
  const blockAtt = { ...createAttachmentMessage({ type: 'hook', outcome: 'block', event: 'tool.before', name: 'guard', words: 'no edits here', callId: id }), timestamp: STAMP }
  const resRow = { ...createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content: 'hook guard blocked this call', is_error: true }] }), timestamp: STAMP }
  const sysRow = { ...createSystemMessage('an informational row tied to the call', 'warning', id), timestamp: STAMP }
  const noticeAtt = { ...createAttachmentMessage({ type: 'hook', outcome: 'notice', event: 'tool.after', name: 'guard', words: 'a notice with a call id', callId: id }), timestamp: STAMP }
  const all = [callRow, blockAtt, resRow, sysRow, noticeAtt]
  const normalized = normalizeMessages(all)
  const lookups = buildMessageLookups(normalized, all)
  const renderOne = async (m: (typeof normalized)[number]): Promise<string> => {
    const node = React.createElement(
      MessageMetaProvider,
      { message: { type: m.type, timestamp: STAMP }, children: null },
      React.createElement(MessageRow, {
        message: m,
        tools: [ReadTool],
        lookups,
        screen: 'prompt',
        columns: 120,
        verbose: false,
        isUserContinuation: true,
        hasContentAfter: false,
        inProgressToolUseIDs: new Set<string>(),
        streamingToolUseIDs: new Set<string>(),
        canAnimate: false,
        isLoading: false,
        lastThinkingBlockId: null,
        latestBashOutputUUID: null,
      }),
    )
    const { text } = await renderRows(node)
    return text.find(row => row.trim() !== '') ?? ''
  }
  const blockLine = await renderOne(normalized.find(m => m.type === 'attachment' && m.attachment.type === 'hook' && m.attachment.outcome === 'block')!)
  const resultLine = await renderOne(normalized.find(m => m.type === 'user')!)
  const systemLine = await renderOne(normalized.find(m => m.type === 'system')!)
  const noticeLine = await renderOne(normalized.find(m => m.type === 'attachment' && m.attachment.type === 'hook' && m.attachment.outcome === 'notice')!)
  check('call-tied hook block connector aligns at column 4 with tool_result', blockLine.indexOf('└') === 4 && resultLine.indexOf('└') === 4, JSON.stringify({ blockLine, resultLine }))
  check('call-tied hook notice connector aligns at column 4 with tool_result', noticeLine.indexOf('└') === 4, JSON.stringify({ noticeLine }))
  check('call-tied informational system row keeps its 2-cell left pad', systemLine.startsWith('  ') && !systemLine.startsWith('   '), JSON.stringify({ systemLine }))
}

section('§6 expanded collapsed_read_search group keeps column-2 timestamp and member alignment through MessageRow')
{
  const okId = 'toolu_exp_ok'
  const errId = 'toolu_exp_err'
  const okUse = { ...createAssistantMessage({ content: [{ type: 'tool_use', id: okId, name: 'Read', input: { file_path: '/scratch/a.ts' } }] }), timestamp: STAMP }
  const errUse = { ...createAssistantMessage({ content: [{ type: 'tool_use', id: errId, name: 'Read', input: { file_path: '/scratch/missing.ts' } }] }), timestamp: STAMP }
  const okRes = { ...createUserMessage({ content: [{ type: 'tool_result', tool_use_id: okId, content: 'ok' }] }), timestamp: STAMP }
  const errRes = { ...createUserMessage({ content: [{ type: 'tool_result', tool_use_id: errId, content: 'ENOENT', is_error: true }] }), timestamp: STAMP }
  const all = [okUse, errUse, okRes, errRes]
  const normalized = normalizeMessages(all)
  const lookups = buildMessageLookups(normalized, all)
  const members = normalized.filter(m => m.type === 'assistant')
  const groupMsg = {
    type: 'collapsed_read_search' as const,
    searchCount: 0,
    readCount: 2,
    listCount: 0,
    memorySearchCount: 0,
    memoryReadCount: 0,
    memoryWriteCount: 0,
    readFilePaths: ['/scratch/a.ts', '/scratch/missing.ts'],
    searchArgs: [],
    latestDisplayHint: undefined,
    messages: members,
    displayMessage: members[0],
    uuid: 'group-exp-1',
    timestamp: STAMP,
  }
  const paintGroup = async (verbose: boolean, screen: 'prompt' | 'transcript', continuation = false) => {
    const row = React.createElement(MessageRow, {
      message: groupMsg,
      tools: [ReadTool],
      lookups,
      screen,
      columns: 120,
      verbose,
      isUserContinuation: true,
      hasContentAfter: false,
      inProgressToolUseIDs: new Set<string>(),
      streamingToolUseIDs: new Set<string>(),
      canAnimate: false,
      isLoading: false,
      lastThinkingBlockId: null,
      latestBashOutputUUID: null,
    })
    const node = continuation
      ? React.createElement(NameplateContinuationContext.Provider, { value: true }, row)
      : row
    const { text } = await renderRows(node)
    return text.filter(line => line.trim() !== '')
  }
  const collapsed = await paintGroup(false, 'prompt')
  const expanded = await paintGroup(true, 'prompt')
  const expandedTranscript = await paintGroup(true, 'transcript', true)
  const collapsedHead = collapsed[0] ?? ''
  const expandedHead = expanded.find(row => row.includes('Expanded group')) ?? ''
  const okMember = expanded.find(row => row.includes('/scratch/a.ts')) ?? ''
  const errMember = expanded.find(row => row.includes('/scratch/missing.ts')) ?? ''
  const transcriptHead = expandedTranscript.find(row => row.includes('Expanded group')) ?? ''
  const clockCol = (row: string): number => row.search(/\d\d:\d\d:\d\d/)
  check('expanded group header keeps timestamp at column 2 matching collapsed group', clockCol(collapsedHead) === 2 && clockCol(expandedHead) === 2 && PLATE_RE.test(expandedHead), JSON.stringify({ collapsedHead, expandedHead }))
  check('expanded group members keep column-4 name and column-2 ✕ lead', okMember.startsWith('    Read ') && errMember.startsWith(`  ${GLYPH.fail} Read `), JSON.stringify({ okMember, errMember }))
  check('expanded group on transcript screen keeps its 2-cell left pad', transcriptHead.startsWith('  Expanded group ('), JSON.stringify({ transcriptHead }))
}

console.log(failures === 0 ? '\n✅ TOOL ROW LEAD LAW HOLDS (bold name leads pending/done; ✕ leads error/denied; notices keep their dot)' : `\n❌ ${failures} TOOL ROW LEAD CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
