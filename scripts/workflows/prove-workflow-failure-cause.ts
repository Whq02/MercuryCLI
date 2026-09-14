#!/usr/bin/env bun
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import {
  bootLead,
  closeWorld,
  findFiles,
  LEAD_GATE,
  LEAD_MODEL,
  makeTally,
  makeWorld,
  readJson,
  record,
  userTextsOf,
} from '../crew/team-world.ts'

const LAUNCH = 'RUN-REVIEWS'
const WORKFLOW_ID = 'toolu_two_reviews'
const REVIEW_A = 'REVIEW-A: review the capture code.'
const REVIEW_B = 'REVIEW-B: review the docs.'
const SCRIPT = [
  "export const meta = { name: 'two-reviews', description: 'two reviewers, one refuses', phases: [{ title: 'Review' }] };",
  `const [a, b] = await parallel([() => agent(${JSON.stringify(REVIEW_A)}, { model: 'claude-opus-5', phase: 'Review', label: 'capture-review' }), () => agent(${JSON.stringify(REVIEW_B)}, { model: 'claude-sonnet-5', phase: 'Review', label: 'docs-review' })]);`,
  'return { a, b };',
].join('\n')

const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn =>
  ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn

const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', id: WORKFLOW_ID, name: 'Workflow', input: { script: SCRIPT } }, LAUNCH),
  lead({ kind: 'text', text: 'WORKFLOW-LAUNCHED' }, LAUNCH),
  lead({ kind: 'text', text: 'NOTIFIED' }, 'task-notification'),
  { kind: 'text', text: '', stopReason: 'refusal', model: 'claude-opus-5', whenModel: 'opus-5', whenBody: 'REVIEW-A' } as ScriptedTurn,
  { kind: 'text', text: 'The docs read well.', model: 'claude-sonnet-5', whenModel: 'sonnet-5', whenBody: 'REVIEW-B' } as ScriptedTurn,
]

const tally = makeTally('prove-workflow-failure-cause')
const world = await makeWorld('workflow-failure-cause', script)
const session = bootLead(world, [], ['Workflow'])
try {
  tally.section('a workflow with two reviewers, one of which ends in a refusal')
  session.submit(`${LAUNCH}: run both reviews.`)
  await session.waitFor('the workflow never launched', () => session.stdout().includes('WORKFLOW-LAUNCHED'))
  const launch = toolResultOf(WORKFLOW_ID)
  tally.check('the Workflow tool answered', launch !== null, launch?.text.slice(0, 200))
  await session.waitFor('the lead never read the workflow notification', () => session.stdout().includes('NOTIFIED'), 120_000)
  const notification = userTextsOf(world).find(text => text.includes('<task-notification>')) ?? ''
  record('workflow-notification.txt', notification + '\n')
  const summaryLine = notification.split('\n').find(line => /Dynamic workflow/.test(line)) ?? ''
  record('workflow-summary-line.txt', summaryLine + '\n')
  tally.check('the notification reached the lead', notification !== '')
  tally.check('the run completed with failures, not silently', /completed WITH 1 agent failure/.test(summaryLine), summaryLine.slice(0, 240))

  tally.section('the line the lead reads names the first failing agent and its cause')
  tally.check('the summary line names the failing agent', /capture-review/.test(summaryLine), summaryLine.slice(0, 240))
  tally.check("the summary line names the refusal's stop reason", /refusal/.test(summaryLine), summaryLine.slice(0, 240))
  tally.check('the failures section carries the cause too', /<failures>[\s\S]*refusal[\s\S]*<\/failures>/.test(notification), notification.slice(0, 400))

  tally.section('the record carries the same cause')
  const manifests = findFiles(world.dir, 'run.json')
  tally.check('the run wrote its record', manifests.length >= 1)
  const manifest = manifests[0] ? readJson<{ status: string; error?: string; failures?: string[]; agents: Array<{ label: string; state: string; error?: string }> }>(manifests[0]) : null
  record('run.json', JSON.stringify(manifest, null, 2) + '\n')
  tally.check('the record says completed with failures', manifest?.status === 'completed_with_failures', String(manifest?.status))
  const failedRow = manifest?.agents.find(row => row.state === 'error')
  tally.check("the record's agent row carries the refusal", failedRow !== undefined && /refusal/.test(failedRow.error ?? ''), JSON.stringify(failedRow))
  tally.check("the record's own failure line names the agent and the cause", Array.isArray(manifest?.failures) && manifest.failures.some(line => /capture-review/.test(line) && /refusal/.test(line)), JSON.stringify(manifest?.failures))
} finally {
  await session.end()
  await closeWorld(world)
}
tally.finish()

function toolResultOf(id: string): { text: string; isError: boolean } | null {
  type Block = { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean; text?: string }
  const textOf = (content: unknown): string =>
    typeof content === 'string' ? content : Array.isArray(content) ? (content as Block[]).map(b => (typeof b.text === 'string' ? b.text : b.type === 'tool_result' ? textOf(b.content) : '')).join('\n') : ''
  for (const request of world.fixture.messageRequests()) {
    const body = request.body as { messages?: Array<{ role?: string; content?: unknown }> } | null
    for (const item of body?.messages ?? []) {
      if (item.role !== 'user' || !Array.isArray(item.content)) continue
      for (const part of item.content as Block[]) {
        if (part.type === 'tool_result' && part.tool_use_id === id) return { text: textOf(part.content), isError: part.is_error === true }
      }
    }
  }
  return null
}
