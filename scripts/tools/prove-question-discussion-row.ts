#!/usr/bin/env bun
import React from 'react'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = pinScratchHome('question-discussion-row')

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { Box } = await import('../../src/screen/themedRenderer.ts')
const { AskUserQuestionTool } = await import('../../src/tools/ask-question/AskUserQuestionTool.tsx')

const h = React.createElement
const ROAD = { id: 'road', question: 'Which road should it take?', header: 'Road', multiSelect: false, options: [{ label: 'North', description: 'Over the pass.' }, { label: 'South', description: 'Along the coast.' }] }
const COLOUR = { id: 'colour', question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Green', description: 'As the hills.' }, { label: 'Blue', description: 'As the sea.' }] }
const HEAD = "User answered Mercury's questions:"
const WORDS = 'Chat about this'

async function outputOf(input: Record<string, unknown>): Promise<never> {
  return ((await AskUserQuestionTool.call(input as never)) as { data: never }).data
}
const wireOf = (output: never): unknown => (AskUserQuestionTool.mapToolResultToToolResultBlockParam(output, 'tu_question_1') as { content: unknown }).content

async function rowsOf(output: never): Promise<string[]> {
  const view: Mounted = await mountOffscreen(
    h(AppStateProvider, null, h(ThemeProvider, null, h(Box, { width: 100, height: 12, flexDirection: 'column' }, AskUserQuestionTool.renderToolResultMessage(output, [] as never, {} as never) as React.ReactNode))),
    100, 12,
  )
  try {
    await waitFor(() => view.lines().some(line => line.includes(HEAD)), 5_000)
    await settle(80)
    return view.lines().map(line => line.trim()).filter(line => line !== '')
  } finally {
    view.unmount()
  }
}
const under = (rows: string[]): string[] => rows.slice(rows.findIndex(row => row.includes(HEAD)) + 1).map(row => row.replace(/^[└⎿]\s*/, '')).filter(row => row !== '')

section('the operator asks to talk a question through: the row says what he pressed')
{
  const asked = await outputOf({ questions: [ROAD], outcome: { kind: 'discussion-requested', questionId: 'road' } })
  const rows = await rowsOf(asked)
  check('under the header stands the question with the card\'s own words for the choice', under(rows).length === 1 && under(rows)[0] === `· ${ROAD.question} → ${WORDS}`, 'Fix renderToolResultMessage in src/tools/ask-question/AskUserQuestionTool.tsx so a discussion-requested question reads with the Chat about this label. Rows: ' + JSON.stringify(rows))
  check('what the model reads is what it read, to the byte', wireOf(asked) === `The user wants to DISCUSS the question ${JSON.stringify(ROAD.question)} before answering. Talk it through with them; the interview session and its drafts are preserved and will resume at this question.`, 'Fix the discussion-requested case in the answer text built in src/tools/ask-question/AskUserQuestionTool.tsx (near line 159) so the model text matches byte for byte. Got: ' + String(wireOf(asked)))
  const byText = await outputOf({ questions: [{ ...ROAD, id: undefined }], outcome: { kind: 'discussion-requested', questionId: ROAD.question } })
  check('a question named by its text reads the same', under(await rowsOf(byText))[0] === `· ${ROAD.question} → ${WORDS}`, 'Fix renderToolResultMessage in src/tools/ask-question/AskUserQuestionTool.tsx so a questionId that is the question text matches the question like an id does. Rows: ' + JSON.stringify(await rowsOf(byText)))
}

section('two questions, the first answered, the second to be talked through: both rows, in the questions\' order')
{
  const mixed = await outputOf({ questions: [COLOUR, ROAD], answers: { colour: 'Green' }, outcome: { kind: 'discussion-requested', questionId: 'road' } })
  const rows = under(await rowsOf(mixed))
  check('the answer given stands first, the talk asked second', rows.length === 2 && rows[0] === `· ${COLOUR.question} → Green` && rows[1] === `· ${ROAD.question} → ${WORDS}`, 'Fix renderToolResultMessage in src/tools/ask-question/AskUserQuestionTool.tsx so an answered question and a discussed one both show, in the questions order. Rows: ' + JSON.stringify(rows))
  check('the model still reads the answers so far behind the request', String(wireOf(mixed)).includes(`DISCUSS the question ${JSON.stringify(ROAD.question)}`) && String(wireOf(mixed)).includes('Answers so far:') && String(wireOf(mixed)).includes('"Green"'), 'Fix the discussion-requested case in the answer text built in src/tools/ask-question/AskUserQuestionTool.tsx so it keeps the Answers so far block. Got: ' + String(wireOf(mixed)))
  const first = await outputOf({ questions: [ROAD, COLOUR], answers: { colour: 'Blue' }, outcome: { kind: 'discussion-requested', questionId: 'road' } })
  const firstRows = under(await rowsOf(first))
  check('a talk asked on the first of two keeps the questions\' order', firstRows.length === 2 && firstRows[0] === `· ${ROAD.question} → ${WORDS}` && firstRows[1] === `· ${COLOUR.question} → Blue`, 'Fix renderToolResultMessage in src/tools/ask-question/AskUserQuestionTool.tsx so rows follow the questions order, not the order of answers. Rows: ' + JSON.stringify(firstRows))
}

section('answers submitted read as before')
{
  const answered = await outputOf({ questions: [COLOUR, ROAD], answers: { colour: 'Green', road: 'North' }, outcome: { kind: 'answers-submitted' } })
  const rows = under(await rowsOf(answered))
  check('each question with its answer, no other word', rows.length === 2 && rows[0] === `· ${COLOUR.question} → Green` && rows[1] === `· ${ROAD.question} → North` && !rows.some(row => row.includes(WORDS)), 'Fix renderToolResultMessage in src/tools/ask-question/AskUserQuestionTool.tsx so an answers-submitted outcome shows only the answers and never the Chat about this label. Rows: ' + JSON.stringify(rows))
  check('and the model reads the answers as before', String(wireOf(answered)).startsWith('User has answered your questions:') && String(wireOf(answered)).includes('"North"'), 'Fix the answers-submitted text built in src/tools/ask-question/AskUserQuestionTool.tsx (near line 196), which must start with User has answered your questions and list each answer. Got: ' + String(wireOf(answered)))
}

await releaseScratchHome(home)
console.log(`\n${checks - failures} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
