import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'resume-prefix-sibling-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { getAgentTranscriptPath } = await import('../../src/utils/sessionStorage/paths.ts')
const { getAgentTranscript } = await import('../../src/utils/sessionStorage/logs.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
const { asAgentId } = await import('../../src/types/ids.ts')
const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
let failures = 0
let checks = 0
const check = (label: string, yes: boolean) => { checks++; if (!yes) failures++; console.log(`[${yes ? 'PASS' : 'FAIL'}] ${label}`) }
const sessionId = String(getSessionId())
const agentId = asAgentId('a12345678')
const first = crypto.randomUUID()
const assistant = crypto.randomUUID()
const middle = crypto.randomUUID()
const final = crypto.randomUUID()
const stamp = (n: number) => new Date(1700000000000 + n * 1000).toISOString()
const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
const definition = JSON.stringify({ name: 'StructuredOutput', description: 'fixture', input_schema: schema })
const prefix = (uuid: string, n: number, conversation = first, session = sessionId, owner = agentId) => ({
  type: 'attachment', uuid, parentUuid: assistant, timestamp: stamp(n), isSidechain: true, agentId: owner, sessionId: session,
  attachment: { type: 'bound_prefix', boundKey: `${owner}|${conversation}|fixture`, rosterEnabled: false, roster: [{ name: 'StructuredOutput', deferred: false, definition }], sections: [], systemContext: {} },
})
const older = crypto.randomUUID()
const newest = crypto.randomUUID()
const rows = [
  { type: 'user', uuid: first, parentUuid: null, timestamp: stamp(0), message: { role: 'user', content: 'work' } },
  { type: 'assistant', uuid: assistant, parentUuid: first, timestamp: stamp(1), message: { role: 'assistant', id: 'msg_first', model: 'fixture', content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 1, output_tokens: 1 } } },
  prefix(older, 2), prefix(newest, 3), prefix(crypto.randomUUID(), 4, crypto.randomUUID()), prefix(crypto.randomUUID(), 5, first, crypto.randomUUID()), prefix(crypto.randomUUID(), 6, first, sessionId, asAgentId('a87654321')),
  { type: 'user', uuid: middle, parentUuid: assistant, timestamp: stamp(7), message: { role: 'user', content: 'tool settled' } },
  { type: 'assistant', uuid: final, parentUuid: middle, timestamp: stamp(8), message: { role: 'assistant', id: 'msg_final', model: 'fixture', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } } },
].map(row => ({ isSidechain: true, agentId, sessionId, ...row }))
const path = getAgentTranscriptPath(agentId)
mkdirSync(dirname(path), { recursive: true })
let ordinal = 0
writeFileSync(path, rows.map(row => JSON.stringify(entryToRecord(row as never, { sessionId, nextOrdinal: () => ordinalOf(++ordinal), observedAt: stamp(9), source: { channel: 'interactive' } } as never))).join('\n') + '\n')
const before = readFileSync(path, 'utf8')
const resumed = await getAgentTranscript(agentId)
const records = resumed?.messages.filter(row => row.type === 'attachment' && row.attachment.type === 'bound_prefix') ?? []
check('the agent resume read carries the newest matching sibling prefix record', records.length === 1 && records[0]?.uuid === newest)
check('the original conversational chain stays in its original order', resumed?.messages.filter(row => row.type !== 'attachment').map(row => row.uuid).join(',') === [first, assistant, middle, final].join(','))
check('the recorded definition stays byte-identical', records.length === 1 && JSON.stringify(records[0]).includes(JSON.stringify(definition)))
check('reading the matching sibling never rewrites the transcript', readFileSync(path, 'utf8') === before)
console.log(`resume-prefix-sibling: ${checks} checks, ${failures} failed`)
rmSync(home, { recursive: true, force: true })
process.exit(failures ? 1 : 0)
