let failures = 0
let checks = 0
const check = (label: string, yes: boolean) => { checks++; if (!yes) failures++; console.log(`[${yes ? 'PASS' : 'FAIL'}] ${label}`) }
const { namedLaunchReceipts } = await import('../../src/tasks/LocalAgentTask/launchReceipts.ts')
for (const verb of ['SendMessage', 'ResumeCrewmate']) {
  const rows = [
    { type: 'assistant', uuid: 'launch', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'launch', name: 'Crewmate', input: { name: 'reader', description: 'read', prompt: 'read', crewmate_type: 'mercury-crew' } }] } },
    { type: 'user', uuid: 'receipt', message: { content: [{ type: 'tool_result', tool_use_id: 'launch', content: `done\nagentId: a12345678 (internal — do not mention it to the user). To continue this crewmate, use ${verb} addressed to that id.` }] } },
  ]
  check(`${verb} transcript trailer still pairs its launch name with its id`, namedLaunchReceipts(rows as never)[0]?.agentId === 'a12345678')
}
const { crewTrafficMessages } = await import('../../src/components/prompts-panel/rows.ts')
const traffic = crewTrafficMessages([{ type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'resume-row', name: 'ResumeCrewmate', input: { to: 'reader', message: 'continue reading' } }] } }] as never)
check('ResumeCrewmate is shown as crewmate message traffic', traffic.length === 1 && traffic[0]?.via === 'message' && traffic[0]?.text === 'continue reading')
console.log(`resume-door-words: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
