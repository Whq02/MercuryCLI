#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 SP-1 — the chat pane ↵ waits out a landing; the legend says so')
{
  const { regionKeysFor } = await import('../../src/components/concourse/controlManifest.ts')
  const landing = regionKeysFor('chat', { newSession: true, chatSession: true, landing: true })
  check('during a landing the chat legend prints no ↵ row (a printed key that does not fire is a lie)', landing.every(k => k.keys !== '↵') && landing.some(k => k.keys === 's'))
  check("with a session focused the row reads '↵ full chat'; with none, '↵ new session'", regionKeysFor('chat', { newSession: true, chatSession: true }).some(k => k.keys === '↵' && k.label === 'full chat') && regionKeysFor('chat', { newSession: true, chatSession: false }).some(k => k.keys === '↵' && k.label === 'new session'))
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('POISON: the unguarded birth is gone', !screen.includes('else callbacks.newSession?.()'))
  check('the key door is landing-guarded and rides the one birth door', screen.includes('if (hasFocusedSession()) callbacks.exitToRepl()\n        else if (!landingInFlight()) armContractAsk()'))
  check('the screen reads the landing fact from the one owner', screen.includes("import { hasFocusedSession, landingInFlight } from '../../services/engine-connector/focusedConnector.js'"))
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check('the legend hands the landing fact to the one resolver', layout.includes("...(region === 'chat' ? { chatSession: chat, landing: landingInFlight() } : {}),"))
  const pane = read('src/components/concourse/SplitChatPane.tsx')
  check("the pane's pointer door stays withdrawn during a landing (the paint the key now agrees with)", pane.includes('{landingInFlight() ? (') && pane.includes('opening the focused chat…'))
}

console.log('§2 MGR-3 — the replay carries the plan and the ask whole')
{
  const { buildCoordinatorReplay, renderPlanForReplay, renderAskForReplay } = await import('../../src/services/concourse/coordinatorReplay.ts')
  const now = 1_754_000_000_000
  const plan = {
    goal: 'split the parser rewrite',
    lanes: [
      { title: 'lexer', scope: 'tokenizer + tests', deliverables: 'a green lexer suite', territory: 'src/lexer/**' },
      { title: 'grammar', scope: 'the parser rules', deliverables: 'the AST builder', territory: 'src/parser/**' },
    ],
    seats: '2 of 5 free',
    supervision: 'supervising' as const,
    state: 'declined' as const,
  }
  const entries = [
    { id: 'op:1', role: 'operator' as const, text: 'split the parser rewrite into lanes', ts: now - 5000 },
    { id: 'co:1', role: 'coordinator' as const, text: 'the plan is ready — 2 lanes on the card below', ts: now - 4000, harness: true as const, plan },
    { id: 'op:2', role: 'operator' as const, text: 'make it three lanes instead', ts: now - 3000 },
    { id: 'co:2', role: 'coordinator' as const, text: 'which parser first?', ts: now - 2000, ask: { question: 'which parser first?', options: ['the lexer', 'the grammar'], index: 2 } },
    { id: 'op:3', role: 'operator' as const, text: 'reply only', ts: now - 1000 },
    { id: 'co:3', role: 'coordinator' as const, text: 'The turn did not run: not signed in.', ts: now - 500, harness: true as const },
  ]
  const rows = buildCoordinatorReplay(entries, now)
  const planRow = rows[1]
  check('the plan turn replays in the COORDINATOR voice (the model proposed it), never as a harness note', planRow?.role === 'coordinator', JSON.stringify(planRow?.role))
  check('the lanes replay whole — titles, scope, deliverables, territory, seats, state', ['<plan state="declined" supervision="supervising">', 'goal: split the parser rewrite', 'lane 1 · lexer', 'scope: tokenizer + tests', 'delivers: the AST builder', 'territory: src/parser/**', 'seats: 2 of 5 free', '</plan>'].every(s => planRow?.text.includes(s) === true), planRow?.text.slice(0, 200))
  check('the harness line still leads the row (the operator saw it)', planRow?.text.startsWith('the plan is ready — 2 lanes on the card below') === true)
  check('POISON: the goal that produced the plan is NOT flagged settled history', rows[0]?.settled === undefined, JSON.stringify(rows[0]))
  check('the ask replays with its options (the model’s own question, its own choices)', rows[3]?.text.includes('<ask question="2">') === true && rows[3]?.text.includes('1. the lexer') === true && rows[3]?.role === 'coordinator')
  check('a bare harness notice still replays as the harness and still settles its ask', rows[5]?.role === 'harness' && rows[4]?.settled === true)
  check('the renderers are pure and bounded to the card’s own fields', renderPlanForReplay(plan).split('\n').length === 12 && renderAskForReplay({ question: 'q', options: [] }) === '')
  const lane = read('src/services/concourse/coordinatorLane.ts')
  check('the lane still stores the harness line beside the plan (the card is the UI shape; the replay carries the payload)', lane.includes('replyText = `the plan is ready — ${receipt.plan.lanes.length} lane'))
}

process.exit(failures === 0 ? 0 : 1)
