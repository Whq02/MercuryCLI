#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { answeredWith, frameLines, lastOutcome } from '../lib/rows.ts'
import { captureBriefing, dist, reminderTextsOf, systemTextOf } from './_briefingCapture.ts'

const CEILINGS = {
  tools: 24_050,
  system: 8_600,
  attachments: 6_350,
  request: 39_550,
} as const
const ECONOMY_DEFERRED = ['Crewmate', 'Skill', 'Test', 'LspRead', 'AstSearch']
const EAGER = ['Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'Eval', 'ChangeSet', 'ToolSearch']

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ': ' + detail : ''}`)
}
check('the built product is present', existsSync(dist))
if (!existsSync(dist)) process.exit(1)

const run = await captureBriefing('Read README.md and state its first heading.', [{ kind: 'text', text: 'FIRST-CALL-DONE' }], 2)
const outcome = lastOutcome(frameLines(run.stdout))
check('the built product completes its fixture turn on the ZAI road — one completed outcome row carrying the answer', run.code === 0 && answeredWith(run.stdout, 'FIRST-CALL-DONE'), `${JSON.stringify(outcome ?? null)} ${run.stderr.slice(-300)}`)
check('exactly one request is captured, the main call', run.requests.length === 1, `${run.requests.length} requests`)
const body = run.requests[0]
if (body) {
  const bytes = (value: unknown) => Buffer.byteLength(run.normalize(JSON.stringify(value)), 'utf8')
  const tools = body.tools.map(tool => tool.function)
  const system = systemTextOf(body)
  const reminders = reminderTextsOf(body)
  const toolBytes = bytes(body.tools)
  const systemBytes = Buffer.byteLength(run.normalize(system), 'utf8')
  const attachmentBytes = reminders.reduce((total, text) => total + Buffer.byteLength(run.normalize(text), 'utf8'), 0)
  const requestBytes = bytes(body)
  console.log(`  [INFO] model ${body.model} · tools ${toolBytes} B in ${tools.length} definitions · system ${systemBytes} B · attachments ${attachmentBytes} B in ${reminders.length} reminders · request ${requestBytes} B`)
  for (const tool of tools) {
    console.log(`  [INFO]   ${tool.name}: ${bytes(tool)} B (description ${Buffer.byteLength(tool.description, 'utf8')} B, parameters ${bytes(tool.parameters)} B)`)
  }
  const roster = reminders.find(text => text.includes('Deferred tools:')) ?? ''
  const rosterLines = roster.split('\n').filter(line => line !== '' && !line.startsWith('<') && !line.startsWith('Deferred tools:'))
  const skills = reminders.find(text => text.includes('## Skills')) ?? ''
  console.log(`  [INFO] deferred roster: ${rosterLines.length} lines, ${Buffer.byteLength(roster, 'utf8')} B · skill listing ${Buffer.byteLength(skills, 'utf8')} B`)
  check(`the tool array stays under its ceiling (${CEILINGS.tools} B)`, toolBytes <= CEILINGS.tools, `${toolBytes} B`)
  check(`the system prompt stays under its ceiling (${CEILINGS.system} B)`, systemBytes <= CEILINGS.system, `${systemBytes} B`)
  check(`the first-call attachments stay under their ceiling (${CEILINGS.attachments} B)`, attachmentBytes <= CEILINGS.attachments, `${attachmentBytes} B`)
  check(`the whole request stays under its ceiling (${CEILINGS.request} B)`, requestBytes <= CEILINGS.request, `${requestBytes} B`)
  check('the daily tools and the door ride eager', EAGER.every(name => tools.some(tool => tool.name === name)), EAGER.filter(name => !tools.some(tool => tool.name === name)).join(', '))
  check('no economy-deferred tool carries a definition on the first call', ECONOMY_DEFERRED.every(name => !tools.some(tool => tool.name === name)), ECONOMY_DEFERRED.filter(name => tools.some(tool => tool.name === name)).join(', '))
  check('each economy-deferred tool is announced on the roster with its purpose', ECONOMY_DEFERRED.every(name => rosterLines.some(line => line.startsWith(`${name} — `) && line.length > name.length + 4)), ECONOMY_DEFERRED.filter(name => !rosterLines.some(line => line.startsWith(`${name} — `))).join(', '))
}
process.exit(failures === 0 ? 0 : 1)
