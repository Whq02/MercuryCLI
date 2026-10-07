import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { makeWorld, bootLead, LEAD_MODEL, toolResultOf, userTextsOf } from './crew-world.ts'

const legacy = process.argv.includes('--legacy-base')
const background = !process.argv.includes('--foreground')
const verb = legacy ? 'SendMessage' : 'ResumeAgent'
const schema = { type: 'object', properties: { function_name: { type: 'string' } }, required: ['function_name'] }
const payload = { function_name: 'compute_201' }
let failures = 0
let checks = 0
const check = (label: string, yes: boolean, detail = '') => { checks++; if (!yes) failures++; console.log(`[${yes ? 'PASS' : 'FAIL'}] ${label}${!yes && detail ? ` — ${detail}` : ''}`) }
const guard = setTimeout(() => { console.log('[FAIL] resume structured proof exceeded 240 seconds'); process.exit(1) }, 240_000)
guard.unref()
type Body = { messages?: unknown[]; tools?: Array<{ name?: string; input_schema?: unknown }>; system?: unknown }
for (const structured of [true, false]) {
  const label = structured ? 'structured' : 'plain'
  const opening = `P2-${label}-child-only`
  const parent = `P2-${label}-launch-parent`
  const followup = `P2-${label}-resume-parent`
  const childTurns = structured
    ? [
        { kind: 'tool_use' as const, name: 'StructuredOutput', id: `p2-${label}-first`, input: payload, whenSaid: opening, model: LEAD_MODEL },
        { kind: 'text' as const, text: 'FIRST-CHILD-DONE', whenSaid: opening, model: LEAD_MODEL },
        { kind: 'tool_use' as const, name: 'StructuredOutput', id: `p2-${label}-second`, input: payload, whenSaid: opening, model: LEAD_MODEL },
        { kind: 'text' as const, text: 'SECOND-CHILD-DONE', whenSaid: opening, model: LEAD_MODEL },
      ]
    : [
        { kind: 'text' as const, text: 'FIRST-CHILD-DONE', whenSaid: opening, model: LEAD_MODEL },
        { kind: 'text' as const, text: 'SECOND-CHILD-DONE', whenSaid: opening, model: LEAD_MODEL },
      ]
  const world = await makeWorld(`resume-${label}`, [
    ...childTurns,
    { kind: 'tool_use', name: 'Agent', id: `p2-${label}-launch`, input: { name: `${label}-child`, description: `${label} child`, prompt: opening, subagent_type: 'mercury-crew', run_in_background: background, ...(structured ? { output_schema: schema } : {}) }, whenSaid: parent, model: LEAD_MODEL },
    { kind: 'text', text: 'PARENT-FIRST-DONE', whenSaid: parent, model: LEAD_MODEL },
    { kind: 'tool_use', name: verb, id: `p2-${label}-resume`, input: { to: `${label}-child`, message: 'submit it again' }, whenSaid: followup, model: LEAD_MODEL },
    { kind: 'text', text: 'PARENT-RESUME-DONE', whenSaid: followup, model: LEAD_MODEL },
    ...Array.from({ length: 8 }, () => ({ kind: 'text' as const, text: 'PARENT-NOTED', model: LEAD_MODEL })),
  ])
  const sid = randomUUID()
  let first: ReturnType<typeof bootLead> | undefined
  let second: ReturnType<typeof bootLead> | undefined
  try {
    first = bootLead(world, ['--sovereign', '--session-id', sid], ['Agent', 'SendMessage', 'ResumeAgent'])
    first.submit(parent)
    await first.waitFor('the launch turn settled', () => first!.frames.some(row => row.type === 'outcome'))
    if (background) await first.waitFor('the first child completion reached the main model', () => userTextsOf(world).some(text => text.includes('<status>completed</status>') && text.includes('FIRST-CHILD-DONE')))
    const launch = toolResultOf(world, `p2-${label}-launch`)
    const completed = background ? userTextsOf(world).some(text => text.includes('<status>completed</status>') && text.includes('FIRST-CHILD-DONE')) : launch?.text.includes('FIRST-CHILD-DONE')
    check(`${label}: the child completed its first turn`, launch !== null && !launch.isError && completed === true, JSON.stringify(launch))
    const firstRequests = world.fixture.messageRequests().filter(request => JSON.stringify((request.body as Body).messages).includes(opening))
    const childFirst = firstRequests.find(request => !JSON.stringify((request.body as Body).messages).includes(parent))
    const toolsBefore = (childFirst?.body as Body | undefined)?.tools ?? []
    check(`${label}: launch roster matches the schema choice`, toolsBefore.some(tool => tool.name === 'StructuredOutput') === structured)
    check(`${label}: process one exits cleanly, evicting every task row`, await first.end() === 0)
    first = undefined
    const beforeResume = world.fixture.messageRequests().length
    second = bootLead(world, ['--sovereign', '--resume', sid], ['Agent', 'SendMessage', 'ResumeAgent'])
    second.submit(followup)
    await second.waitFor('the parent resume turn settled', () => second!.frames.some(row => row.type === 'outcome'))
    const resume = toolResultOf(world, `p2-${label}-resume`)
    check(`${label}: the evicted child resumed by its recorded name`, resume !== null && !resume.isError && resume.text.includes('resumed in the background with your message'), JSON.stringify(resume))
    if (resume !== null && !resume.isError && resume.text.includes('resumed in the background')) {
      await second.waitFor('the resumed completion reached the main model', () => userTextsOf(world).some(text => text.includes('<status>completed</status>') && text.includes('SECOND-CHILD-DONE')))
    }
    const childResumed = world.fixture.messageRequests().slice(beforeResume).find(request => {
      const messages = JSON.stringify((request.body as Body).messages)
      return messages.includes(opening) && !messages.includes(parent)
    })
    const toolsAfter = (childResumed?.body as Body | undefined)?.tools ?? []
    check(`${label}: the resumed child made a request`, childResumed !== undefined)
    const beforeSchema = toolsBefore.find(tool => tool.name === 'StructuredOutput')?.input_schema
    const afterSchema = toolsAfter.find(tool => tool.name === 'StructuredOutput')?.input_schema
    check(`${label}: StructuredOutput schema stays byte-identical, absent stays absent`, JSON.stringify(beforeSchema) === JSON.stringify(afterSchema) && (structured ? afterSchema !== undefined : !toolsAfter.some(tool => tool.name === 'StructuredOutput')))
    check(`${label}: the whole tool roster stays byte-identical`, JSON.stringify(toolsBefore) === JSON.stringify(toolsAfter))
    const systemBefore = JSON.stringify((childFirst?.body as Body | undefined)?.system)
    const systemAfter = JSON.stringify((childResumed?.body as Body | undefined)?.system)
    let changedAt = 0
    while (systemBefore?.[changedAt] === systemAfter?.[changedAt] && changedAt < Math.max(systemBefore?.length ?? 0, systemAfter?.length ?? 0)) changedAt++
    check(`${label}: the system prefix stays byte-identical`, systemBefore === systemAfter, `at ${changedAt}: ${systemBefore?.slice(Math.max(0, changedAt - 100), changedAt + 300)} -> ${systemAfter?.slice(Math.max(0, changedAt - 100), changedAt + 300)}`)
    if (structured) {
      const result = toolResultOf(world, `p2-${label}-second`)
      check('the restored StructuredOutput is callable, not merely advertised', result?.isError === false && result.text === 'Structured output provided successfully', JSON.stringify(result))
      check('the resumed completion carries the existing valid structured block', userTextsOf(world).some(text => text.includes('<status>completed</status>') && text.includes('<structured status="valid">\n{"function_name":"compute_201"}\n</structured>') && text.includes('SECOND-CHILD-DONE')))
    } else {
      check('a schema-less resumed completion invents no structured block', userTextsOf(world).some(text => text.includes('SECOND-CHILD-DONE') && text.includes('<status>completed</status>') && !text.includes('<structured')))
    }
    check(`${label}: process two exits cleanly`, await second.end() === 0)
    second = undefined
  } catch (error) {
    check(`${label}: the complete resumed journey`, false, String(error))
  } finally {
    if (first) await first.terminate()
    if (second) await second.terminate()
    await world.fixture.close()
    rmSync(world.dir, { recursive: true, force: true })
  }
}
clearTimeout(guard)
console.log(`resume-structured: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
