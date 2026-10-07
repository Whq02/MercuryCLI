import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
let failures = 0
let checks = 0
const check = (label: string, yes: boolean) => { checks++; if (!yes) failures++; console.log(`[${yes ? 'PASS' : 'FAIL'}] ${label}`) }
const expectations: Array<[string, string[]]> = [
  ['src/tools/AgentTool/AgentTool.tsx', ['To continue this agent, use ${RESUME_AGENT_TOOL_NAME} addressed to that id', 'An agent name must be addressable by SendMessage and ResumeAgent:', 'takes more work through ResumeAgent({to: name}), running or finished, and notes through SendMessage({to: name}) while it runs.']],
  ['src/tools/AgentTool/prompt.ts', ['back up, call ${RESUME_AGENT_TOOL_NAME} with its id or name']],
  ['src/tasks/LocalAgentTask/LocalAgentTask.tsx', ['resume it from the crew view (r on its row) or by ResumeAgent to its id']],
  ['src/services/agentResults/lifecycle.ts', ['ResumeAgent revives it from its transcript with your message', 'ResumeAgent revives it warm (the prompt cache still holds its prefix)', 'ResumeAgent revives it (cold replay)']],
  ['src/tasks/stopTask.ts', ['; ResumeAgent to that id resumes it']],
  ['src/utils/crew/crewStart.ts', ['the address SendMessage, ResumeAgent and the crew view use', 'addressable by SendMessage and ResumeAgent:']],
  ['src/utils/messages/attachmentText.ts', ['resume it: ${RESUME_AGENT_TOOL_NAME} to "${row.address}"', '${SEND_MESSAGE_TOOL_NAME} reaches a running crewmate and ${RESUME_AGENT_TOOL_NAME} gives any one a new turn, by the id or name shown']],
  ['src/skills/bundled/loop.ts', ['and a one-line outcome as the last line of your reply — skip it when the user themselves just said stop.', 'and a one-line outcome as the last line of your reply (skipped when the user just asked for the stop).']],
  ['src/services/loopFire.ts', ["Say so in one line of your reply when the loop can't move further without the user, or when something landed that they'd want to act on now:"]],
  ['docs/CREW.md', ['ResumeAgent']],
]
for (const [path, expected] of expectations) {
  const source = read(path)
  for (const words of expected) check(`${path} carries the split resume-door words: ${words}`, source.includes(words))
}
const { namedLaunchReceipts } = await import('../../src/tasks/LocalAgentTask/launchReceipts.ts')
for (const verb of ['SendMessage', 'ResumeAgent']) {
  const rows = [
    { type: 'assistant', uuid: 'launch', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'launch', name: 'Agent', input: { name: 'reader', description: 'read', prompt: 'read', subagent_type: 'mercury-crew' } }] } },
    { type: 'user', uuid: 'receipt', message: { content: [{ type: 'tool_result', tool_use_id: 'launch', content: `done\nagentId: a12345678 (internal — do not mention it to the user). To continue this agent, use ${verb} addressed to that id.` }] } },
  ]
  check(`${verb} transcript trailer still pairs its launch name with its id`, namedLaunchReceipts(rows as never)[0]?.agentId === 'a12345678')
}
const { crewTrafficMessages } = await import('../../src/components/prompts-panel/rows.ts')
const traffic = crewTrafficMessages([{ type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'resume-row', name: 'ResumeAgent', input: { to: 'reader', message: 'continue reading' } }] } }] as never)
check('ResumeAgent is shown as crewmate message traffic', traffic.length === 1 && traffic[0]?.via === 'message' && traffic[0]?.text === 'continue reading')
check('ResumeAgent joins the non-indexing coordination verbs', read('src/utils/transcriptSearch.ts').includes("  'ResumeAgent',"))
console.log(`resume-door-words: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
