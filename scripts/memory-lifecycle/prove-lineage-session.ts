#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { answeredWith } from '../lib/rows.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { HANDOFF_ASK_MARK, startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const REPO = resolve(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'lineage-session-home-'))
const configDir = join(HOME, 'home', '.mercury')
mkdirSync(configDir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_BARE
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_WIRE_DUMP

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const absent = (name: string) => (): never => {
  throw new Error(`${name} is not in this tree`)
}
const handoffModule = await import('../../src/mneme/handoffAsk.ts').catch(() => null)
const entryModule = await import('../../src/mneme/entryPage.ts').catch(() => null)
const { HANDOFF_GRADE } = await import('../../src/mneme/memoryEvidence.ts')
const pathsModule = await import('../../src/mneme/paths.ts')
const ledgerModule = await import('../../src/mneme/ledger.ts').catch(() => null)
const HANDOFF_ASK: string = handoffModule?.HANDOFF_ASK ?? 'Leave one note for the next session'
const ENTRY_PAGE_HEADING: string = entryModule?.ENTRY_PAGE_HEADING ?? '# Lineage'
const NO_NOTE_LEFT: string = entryModule?.NO_NOTE_LEFT ?? 'left no note'
const mnemeProjectKeyFor: (root: string) => string = (pathsModule as { mnemeProjectKeyFor?: (root: string) => string }).mnemeProjectKeyFor ?? absent('mnemeProjectKeyFor')
const lineagePath: (key: string) => string = (pathsModule as { lineagePath?: (key: string) => string }).lineagePath ?? (() => join(configDir, 'projects', '(no lineage path in this tree)'))
const readLedger: (key: string) => Array<{ ordinal: number; sessionId: string; endedAt: string | null; outcome: string | null; engines: Array<{ model: string; at: string }>; handoff: { text: string; at: string } | null }> = ledgerModule?.readLedger ?? (() => [])
const recordHandoff: (key: string, sessionId: string, text: string) => unknown = ledgerModule?.recordHandoff ?? absent('recordHandoff')
check('the lineage modules are in the tree (ledger, entry page, handoff ask)', handoffModule !== null && entryModule !== null && ledgerModule !== null)
check('the ask carries the mark the proof fixtures answer to (scripts/lib/fixtureApi.ts HANDOFF_ASK_MARK) — the two cannot drift apart', HANDOFF_ASK.includes(HANDOFF_ASK_MARK), HANDOFF_ASK)

console.log('a headless session reads the entry page at its start and leaves no note at its end (an unattended run makes no closing call); the ledger of the scratch home keeps its entry, and the page shows the last note that exists')

const project = realpathSync(mkdtempSync(join(tmpdir(), 'lineage-session-project-')))
writeFileSync(join(project, 'README.md'), 'a project under proof\n')
seedFirstRun(configDir, [project])
const projectKey = (() => {
  try {
    return mnemeProjectKeyFor(project)
  } catch {
    return 'no-key'
  }
})()
const ledgerFile = lineagePath(projectKey)
const nodeBin = Bun.which('node')

type Body = { system?: unknown; messages?: Array<{ role: string; content: unknown }> }
type Captured = { body: Body }

async function session(sid: string, prompt: string, turns: ScriptedTurn[]): Promise<{ exit: number | null; stdout: string; stderr: string; requests: Captured[] }> {
  const fixture = await startFixtureApi(turns)
  const env: Record<string, string> = {
    HOME: join(HOME, 'home'),
    PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    ANTHROPIC_BASE_URL: fixture.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_DAEMON_DIR: join(HOME, 'home', 'daemon'),
    MERCURY_THINKING_BINDING: 'drop_block',
  }
  const result = await new Promise<{ exit: number | null; stdout: string; stderr: string }>(done => {
    const child = spawn(nodeBin!, [DIST, 'run', prompt, '--model', 'claude-opus-4-8', '--format', 'rows', '--session-id', sid], { cwd: project, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('close', exit => {
      clearTimeout(killer)
      done({ exit, stdout, stderr })
    })
  })
  const requests = [...(fixture.requests as unknown as Captured[])]
  await fixture.close()
  return { ...result, requests }
}

const systemText = (body: Body): string[] => (Array.isArray(body.system) ? (body.system as Array<{ text?: string }>).map(b => b.text ?? '') : [String(body.system ?? '')])
const userTexts = (body: Body, index: number): string[] => {
  const message = body.messages?.[index]
  if (message === undefined) return []
  const content = message.content
  if (typeof content === 'string') return [content]
  return (content as Array<{ type?: string; text?: string }>).filter(b => b.type === 'text').map(b => b.text ?? '')
}

const SID1 = '11111111-0000-4000-8000-000000000001'
const SID2 = '22222222-0000-4000-8000-000000000002'
const SID3 = '33333333-0000-4000-8000-000000000003'
const NOTE_ONE = 'The work: the probe.\nDecided: answer with the marker.\nStill to do: the second probe.\nWrong: nothing yet.'

if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the gate prebuilds it)', false, DIST)
} else if (!nodeBin) {
  check('a node binary on PATH', false)
} else {
  section('§1 the first session: no record at the start; no ask at the end (the fixture\'s note turn stays unserved); the entry closes with no note; the answer untouched')
  const one = await session(SID1, 'first probe', [
    { kind: 'text', text: 'ANSWER-ONE', whenBody: 'first probe' },
    { kind: 'text', text: NOTE_ONE, whenBody: 'Leave one note for the next session' },
  ])
  check('the run exits 0 and its outcome row answers the operator\'s prompt, not the note', one.exit === 0 && answeredWith(one.stdout, 'ANSWER-ONE') && !answeredWith(one.stdout, NOTE_ONE), `exit=${one.exit} stderr=${one.stderr.slice(0, 300)}`)
  check('one request reached the engine: the turn; no ask followed it', one.requests.length === 1 && !j(one.requests[0]?.body).includes(HANDOFF_ASK_MARK), `${one.requests.length}`)
  const firstSystem = systemText(one.requests[0]?.body ?? {}).join('\n')
  check('the first session\'s page says first session, no record', firstSystem.includes(`${ENTRY_PAGE_HEADING}\nFirst session of this work; no record.`), firstSystem.slice(firstSystem.indexOf(ENTRY_PAGE_HEADING), firstSystem.indexOf(ENTRY_PAGE_HEADING) + 120))
  let entries = readLedger(projectKey)
  check('the ledger of the scratch home holds one closed entry for the session', existsSync(ledgerFile) && entries.length === 1 && entries[0]!.sessionId === SID1 && entries[0]!.endedAt !== null, j(entries))
  check('the entry closes with no note (an unattended run leaves none)', entries[0]?.handoff === null, j(entries[0]?.handoff))
  check('the entry carries the engine the session ran on and the outcome', entries[0]?.engines[0]?.model === 'claude-opus-4-8' && entries[0]?.outcome === 'closed', j(entries[0]))
  check('the ledger lives under the home, never under the project', ledgerFile.startsWith(configDir) && !existsSync(join(project, 'lineage')) && !existsSync(join(project, '.mercury')))
  recordHandoff(projectKey, SID1, NOTE_ONE)
  entries = readLedger(projectKey)
  check('a note left on the entry through the ledger (the road an attended session\'s ask writes by) is stored exactly as written, every line', entries.length === 1 && entries[0]?.handoff?.text === NOTE_ONE && entries[0]?.endedAt !== null, j(entries[0]?.handoff))

  section('§2 the second session: the page composed from the ledger rides the system prompt, apart from the operator\'s words; the session leaves no note of its own')
  const two = await session(SID2, 'second probe', [
    { kind: 'text', text: 'ANSWER-TWO', whenBody: 'second probe' },
    { kind: 'text', text: 'NOTE-TWO', whenBody: 'Leave one note for the next session' },
  ])
  check('the second run answers its own prompt', two.exit === 0 && answeredWith(two.stdout, 'ANSWER-TWO'), `exit=${two.exit} stderr=${two.stderr.slice(0, 300)}`)
  check('one request reached the engine: the turn; no ask followed it', two.requests.length === 1 && !j(two.requests[0]?.body).includes(HANDOFF_ASK_MARK), `${two.requests.length}`)
  const first = two.requests.find(r => j(r.body).includes('second probe'))
  check('the first request of the second session was captured', first !== undefined)
  const system = first ? systemText(first.body) : []
  const pageBlock = system.find(s => s.includes(ENTRY_PAGE_HEADING)) ?? ''
  const pageStart = pageBlock.indexOf(ENTRY_PAGE_HEADING)
  const pageEnd = pageBlock.indexOf('\n# ', pageStart + 1)
  const page = pageStart >= 0 ? pageBlock.slice(pageStart, pageEnd > 0 ? pageEnd : undefined) : ''
  check('the page is in the system prompt under its own heading', page.startsWith(ENTRY_PAGE_HEADING), j(system.map(s => s.slice(0, 40))))
  check('the page sits after the memory index, before the environment', pageBlock.indexOf('# Memory') >= 0 && pageBlock.indexOf('# Memory') < pageStart && pageBlock.indexOf('# Environment') > pageStart, j([pageBlock.indexOf('# Memory'), pageStart, pageBlock.indexOf('# Environment')]))
  check('the page carries the ordinal and the count from the ledger', page.includes('Session 2 of this work; 1 session before it'), page)
  check('the page names the earlier session\'s engine with its time, never the current one as current', page.includes('Engines before this session: claude-opus-4-8 from ') && page.includes('(session 1)'), page)
  check('the last note rides word for word under its heading with its time, every line graded as a model-authored note', page.includes('## The last note left (session 1, ') && page.includes(NOTE_ONE.split('\n').map(line => line.trim() === '' ? line : `${HANDOFF_GRADE} ${line}`).join('\n')), page)
  check('the page points at the pinned rules instead of repeating them', page.includes('Standing rulings: none pinned.'), page)
  const messages = first?.body.messages ?? []
  check('nothing of the page is in the messages: not the heading, not the note', !j(messages).includes(ENTRY_PAGE_HEADING) && !j(messages).includes(NOTE_ONE) && !j(messages).includes('Session 2 of this work'))
  const userText = first ? userTexts(first.body, 0) : []
  check('the first user message ends with the operator\'s own words, untouched', userText[userText.length - 1] === 'second probe', j(userText))
  check('the page appears once in the request', system.join('\n').split(ENTRY_PAGE_HEADING).length === 2)
  entries = readLedger(projectKey)
  check('the ledger now holds two closed entries in order, the second with no note of its own (the fixture\'s note turn stayed unserved)', entries.length === 2 && entries[1]!.ordinal === 2 && entries[1]!.sessionId === SID2 && entries[1]!.handoff === null && entries[1]!.endedAt !== null, j(entries.map(e => [e.ordinal, e.sessionId, e.handoff?.text, e.endedAt !== null])))

  section('§3 a session that leaves no note ends with "no note left" — never an invented note; the last note that exists stays on the page')
  const three = await session(SID3, 'third probe', [{ kind: 'text', text: 'ANSWER-THREE', whenBody: 'third probe' }])
  check('the run answers and exits 0', three.exit === 0 && answeredWith(three.stdout, 'ANSWER-THREE'), `exit=${three.exit} stderr=${three.stderr.slice(0, 300)}`)
  check('no ask was put: the turn is the only request', three.requests.length === 1, `${three.requests.length}`)
  entries = readLedger(projectKey)
  check('the entry closes with handoff null', entries.length === 3 && entries[2]!.handoff === null && entries[2]!.endedAt !== null, j(entries[2]))
  const next = entryModule?.composeEntryPage(projectKey, 'next-session') ?? ''
  check('the next session\'s page says the last session left no note and shows the last note that exists (session 1\'s)', next.includes(`The last session (3, ended `) && next.includes(NO_NOTE_LEFT) && next.includes('## The last note left (session 1, ') && next.includes(NOTE_ONE.split('\n').map(line => `${HANDOFF_GRADE} ${line}`).join('\n')), next)
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ LINEAGE SESSION GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ LINEAGE SESSION RED (${failures} of ${checks} checks failed)`)
process.exit(1)
