#!/usr/bin/env bun
import React from 'react'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = pinScratchHome('declined-row-every-tool')

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { Box } = await import('../../src/ink.ts')
const { CANCEL_MESSAGE, DENIAL_WORKAROUND_GUIDANCE, REJECT_MESSAGE, REJECT_MESSAGE_WITH_REASON_PREFIX, SUBAGENT_REJECT_MESSAGE } = await import('../../src/utils/messages/rejectionText.ts')
const { UserToolErrorMessage } = await import('../../src/components/messages/UserToolResultMessage/UserToolErrorMessage.tsx')
const { getAllBaseTools } = await import('../../src/tools.ts')

const h = React.createElement
const tools = getAllBaseTools() as unknown as Array<{ name: string }>
const wrapped = (text: string): string => `<tool_use_error>${text}</tool_use_error>`
const DECLINED = 'The operator declined this tool call; it was not run and nothing was changed.'
const FOR_THE_MODEL = /Do not try to reach|stop and say plainly|wait for the operator|Stop what you are doing/

async function rowOf(tool: unknown, content: string): Promise<string[]> {
  const view: Mounted = await mountOffscreen(
    h(AppStateProvider, null, h(ThemeProvider, null, h(Box, { width: 110, height: 10, flexDirection: 'column' },
      h(UserToolErrorMessage, { progressMessagesForMessage: [], tool, tools, param: { type: 'tool_result', tool_use_id: 'tu_1', content, is_error: true }, verbose: false } as never)))),
    110, 10,
  )
  try {
    await waitFor(() => view.lines().some(line => line.trim() !== ''), 5_000)
    await settle(60)
    return view.lines().map(line => line.trim()).filter(line => line !== '')
  } finally {
    view.unmount()
  }
}
const named = (name: string): unknown => tools.find(tool => tool.name === name)
const remote = { name: 'mcp__notes__search', isMcp: true }

section('a call the operator declined: every tool\'s row says declined, none says error, none prints the guidance written for the model')
{
  const wrong: string[] = []
  const own: string[] = []
  for (const tool of [...tools, remote]) {
    const rows = await rowOf(tool, wrapped(REJECT_MESSAGE))
    const text = rows.join(' ')
    if (/Error|Initializing/.test(text) || FOR_THE_MODEL.test(text) || !/The operator declined this tool call|User declined to answer/.test(text) || rows.length !== 1) wrong.push(`${tool.name}: ${JSON.stringify(rows)}`)
    else if (rows[0] !== `└ ✕ ${DECLINED}`) own.push(`${tool.name}: ${rows[0]}`)
  }
  check(`the ${tools.length} tools of the roster and a server's tool: one row each, the refusal`, wrong.length === 0, wrong.join(' · '))
  check('the three with a line of their own keep it (Edit, Write, the question)', own.length === 3 && own.some(row => row.startsWith('Edit: ')) && own.some(row => row.startsWith('Write: ')) && own.some(row => row === 'AskUserQuestion: User declined to answer'), own.join(' · '))
  for (const name of ['WebFetch', 'Git', 'Skill', 'Computer']) {
    const rows = await rowOf(named(name), wrapped(REJECT_MESSAGE))
    check(`${name}: the row is the refusal's first sentence`, named(name) !== undefined && rows.length === 1 && rows[0] === `└ ✕ ${DECLINED}`, JSON.stringify(rows))
  }
  const remoteRows = await rowOf(remote, wrapped(REJECT_MESSAGE))
  check("a server's tool: the same row", remoteRows.length === 1 && remoteRows[0] === `└ ✕ ${DECLINED}`, JSON.stringify(remoteRows))
}

section('the operator\'s own words ride the row; other refusals read by their first sentence too')
{
  const worded = await rowOf(named('WebFetch'), wrapped(`${REJECT_MESSAGE_WITH_REASON_PREFIX}use the other page`))
  check('a decline with words: the refusal and what the operator said', worded.join(' ') === `└ ✕ ${DECLINED} The operator said: use the other page`, JSON.stringify(worded))
  const crewmate = await rowOf(named('Git'), wrapped(SUBAGENT_REJECT_MESSAGE))
  check("a crewmate's declined call: its refusal, no guidance", crewmate.length === 1 && crewmate[0] === '└ ✕ Permission for this tool call was declined; it was not run and nothing was changed.', JSON.stringify(crewmate))
  const ruled = await rowOf(named('WebFetch'), wrapped(`Permission to use WebFetch has been denied. ${DENIAL_WORKAROUND_GUIDANCE}`))
  check('a call a rule denies: what was denied, no guidance', ruled.length === 1 && ruled[0] === '└ ✕ Permission to use WebFetch has been denied.', JSON.stringify(ruled))
  const stopped = await rowOf(named('Computer'), wrapped(CANCEL_MESSAGE))
  check('a call stopped before it ran: that sentence, no guidance', stopped.length === 1 && stopped[0] === '└ ✕ The operator stopped this action before it ran; nothing was changed.' && CANCEL_MESSAGE.length > stopped[0].length, JSON.stringify(stopped))
  check('the text the model reads still carries its guidance: only the row is shorter', REJECT_MESSAGE.endsWith(DENIAL_WORKAROUND_GUIDANCE) && FOR_THE_MODEL.test(REJECT_MESSAGE))
}

section('a real failure still reads as an error, with its words')
{
  const fetch = await rowOf(named('WebFetch'), wrapped('getaddrinfo ENOTFOUND example.invalid'))
  check('WebFetch: the error row and what failed', fetch.join(' ').includes('Error: getaddrinfo ENOTFOUND example.invalid') && !fetch.join(' ').includes('declined'), JSON.stringify(fetch))
  const grep = await rowOf(named('Grep'), wrapped('ripgrep exited with code 2'))
  check('Grep: its own short error line', grep.length === 1 && grep[0]!.endsWith('Error searching files'), JSON.stringify(grep))
  const read = await rowOf(named('Read'), wrapped('The file could not be opened.'))
  check('Read: its own short error line', read.length === 1 && read[0]!.endsWith('Error reading file'), JSON.stringify(read))
  const notebook = await rowOf(named('NotebookEdit'), wrapped('The cell does not exist.'))
  check('NotebookEdit: its own short error line', notebook.length === 1 && notebook[0]!.endsWith('Error editing notebook'), JSON.stringify(notebook))
}

await releaseScratchHome(home)
console.log(`\n${checks - failures} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
