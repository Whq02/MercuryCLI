#!/usr/bin/env bun
// gate-watch: src/mneme/lineageSession.ts src/mneme/journal.ts src/mneme/handoffAsk.ts src/mneme/exitHandoff.ts src/mneme/entryPage.ts src/tools/JournalTool/JournalTool.ts src/tools/JournalTool/prompt.ts src/main.tsx src/bootstrap/state.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { answeredWith, frameLines } from '../lib/rows.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { HANDOFF_ASK_MARK, startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const REPO = resolve(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'ephemeral-nothing-home-'))
const configDir = join(HOME, 'home', '.mercury')
mkdirSync(configDir, { recursive: true })
writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ memory: { journal: true } }))
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
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const { JOURNAL_ASK, journalPath } = await import('../../src/mneme/journal.ts')
const { JOURNAL_DESCRIPTION, JOURNAL_PROMPT } = await import('../../src/tools/JournalTool/prompt.ts')
const { ENTRY_PAGE_HEADING, FIRST_SESSION_LINE } = await import('../../src/mneme/entryPage.ts')
const { mnemeProjectKeyFor, lineagePath } = await import('../../src/mneme/paths.ts')
const { readLedger } = await import('../../src/mneme/ledger.ts')

section('§0 the note\'s content law: the asks name the user\'s own words, never Mercury\'s standing instructions as the user\'s constraints')
for (const [name, text] of [['JOURNAL_ASK', JOURNAL_ASK], ['JOURNAL_DESCRIPTION', JOURNAL_DESCRIPTION], ['JOURNAL_PROMPT', JOURNAL_PROMPT]] as const) {
  check(`${name} no longer asks for "constraints set by the operator"`, !text.includes('constraints set by the operator'), text.slice(0, 200))
  check(`${name} asks for what the user said in this session and rules out Mercury's own standing instructions`, /what the user asked for in this session/.test(text) && /never Mercury's own standing instructions/.test(text), text.slice(0, 240))
}

const project = realpathSync(mkdtempSync(join(tmpdir(), 'ephemeral-nothing-project-')))
writeFileSync(join(project, 'README.md'), 'a project under proof\n')
seedFirstRun(configDir, [project])
const projectKey = mnemeProjectKeyFor(project)
const ledgerFile = lineagePath(projectKey)
const journalFile = journalPath(projectKey)
const nodeBin = Bun.which('node')

type Body = { system?: unknown; messages?: Array<{ role: string; content: unknown }> }
type Captured = { body: Body; raw?: string }

async function session(sid: string, prompt: string, turns: ScriptedTurn[], extraArgs: string[] = []): Promise<{ exit: number | null; stdout: string; stderr: string; requests: Captured[] }> {
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
    BROWSER: '/usr/bin/true',
  }
  const result = await new Promise<{ exit: number | null; stdout: string; stderr: string }>(done => {
    const child = spawn(nodeBin!, [DIST, 'run', prompt, '--model', 'claude-opus-4-8', '--format', 'rows', '--session-id', sid, ...extraArgs], { cwd: project, env })
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

const systemText = (body: Body): string => (Array.isArray(body.system) ? (body.system as Array<{ text?: string }>).map(b => b.text ?? '').join('\n') : String(body.system ?? ''))
const transcriptFiles = (): string[] => {
  const root = join(configDir, 'projects')
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/^[0-9a-f-]{36}\.jsonl$/.test(entry.name)) out.push(full)
    }
  }
  if (existsSync(root)) walk(root)
  return out
}
const homeBytes = (): string => {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try {
          out.push(readFileSync(full, 'utf8'))
        } catch {
          out.push('')
        }
      }
    }
  }
  walk(configDir)
  return out.join('\n')
}

const SID1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const SID2 = 'bbbbbbbb-0000-4000-8000-000000000002'
const SID3 = 'cccccccc-0000-4000-8000-000000000003'

if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the gate prebuilds it)', false, DIST)
} else if (!nodeBin) {
  check('a node binary on PATH', false)
} else {
  section('§1 the control: a plain run joins the lineage — a ledger row, the ask put, the note stored')
  const one = await session(SID1, 'first probe', [
    { kind: 'text', text: 'ANSWER-ONE', whenBody: 'first probe' },
    { kind: 'text', text: 'NOTE-ONE', whenBody: HANDOFF_ASK_MARK },
  ])
  check('the control run exits 0 and answers', one.exit === 0 && answeredWith(one.stdout, 'ANSWER-ONE'), `exit=${one.exit} stderr=${one.stderr.slice(0, 300)}`)
  check('the ask was put (two requests)', one.requests.length === 2 && one.requests.some(r => j(r.body).includes(HANDOFF_ASK_MARK)), String(one.requests.length))
  const afterControl = readLedger(projectKey)
  check('the ledger holds the control session with its note', afterControl.length === 1 && afterControl[0]!.sessionId === SID1 && afterControl[0]!.handoff?.text === 'NOTE-ONE', j(afterControl))
  const ledgerBytesBefore = readFileSync(ledgerFile, 'utf8')
  const journalBefore = existsSync(journalFile) ? readFileSync(journalFile, 'utf8') : null
  const transcriptsBefore = transcriptFiles().length

  section('§2 --ephemeral: the run answers, reads the lineage, and leaves nothing of itself — no row, no ask, no note, no journal line, no transcript')
  const two = await session(SID2, 'ephemeral probe EPHEMERAL-MARK-7731', [
    { kind: 'tool_use', name: 'Journal', input: { entry: 'A journal line the ephemeral run tried to leave: EPHEMERAL-JOURNAL-7731.' }, whenBody: 'EPHEMERAL-MARK-7731' },
    { kind: 'text', text: 'ANSWER-EPHEMERAL', whenBody: 'EPHEMERAL-MARK-7731' },
    { kind: 'text', text: 'NOTE-EPHEMERAL-SHOULD-NEVER-BE-ASKED', whenBody: HANDOFF_ASK_MARK },
  ], ['--ephemeral'])
  check('the ephemeral run exits 0 and answers', two.exit === 0 && answeredWith(two.stdout, 'ANSWER-EPHEMERAL'), `exit=${two.exit} stderr=${two.stderr.slice(0, 400)}`)
  const firstSystem = systemText(two.requests[0]?.body ?? {})
  check('it still reads the lineage at its start (the control\'s note is on its entry page)', firstSystem.includes(ENTRY_PAGE_HEADING) && firstSystem.includes('NOTE-ONE'), firstSystem.slice(firstSystem.indexOf(ENTRY_PAGE_HEADING), firstSystem.indexOf(ENTRY_PAGE_HEADING) + 200))
  check('no request carried the handoff ask', !two.requests.some(r => j(r.body).includes(HANDOFF_ASK_MARK)), String(two.requests.length))
  const journalRows = frameLines(two.stdout).filter(f => f.type === 'tool_result')
  const journalResult = journalRows.map(f => String((f as { output?: unknown }).output ?? '')).find(text => /journal/i.test(text)) ?? ''
  check('a Journal call inside the run is refused and says why (the run is ephemeral)', /refused/.test(journalResult) && /ephemeral/.test(journalResult), journalResult || j(journalRows).slice(0, 300))
  check('the ledger file is byte-identical to before: the ephemeral session never joined it', readFileSync(ledgerFile, 'utf8') === ledgerBytesBefore, j(readLedger(projectKey).map(e => [e.ordinal, e.sessionId])))
  check('the journal gained no line', (existsSync(journalFile) ? readFileSync(journalFile, 'utf8') : null) === journalBefore, existsSync(journalFile) ? readFileSync(journalFile, 'utf8').slice(-300) : 'absent')
  check('no transcript was written for the ephemeral session', transcriptFiles().length === transcriptsBefore && !transcriptFiles().some(f => f.includes(SID2)), j(transcriptFiles()))
  const bytes = homeBytes()
  check('nothing under the home carries a word of the ephemeral session: not the prompt, not the answer, not the journal line it tried to leave', !bytes.includes('EPHEMERAL-MARK-7731') && !bytes.includes('EPHEMERAL-JOURNAL-7731') && !bytes.includes('ANSWER-EPHEMERAL'), 'words on disk')
  const namesSession = (): string[] => {
    const out: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (readFileSync(full, 'utf8').includes(SID2)) out.push(full.slice(configDir.length + 1))
      }
    }
    walk(configDir)
    return out
  }
  const costKeys = (value: unknown, path: string[] = []): string[] => {
    if (typeof value === 'string') return value.includes(SID2) ? [path.join('.')] : []
    if (value !== null && typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => costKeys(inner, [...path, key]))
    return []
  }
  const configMentions = existsSync(join(configDir, '.mercury.json')) ? costKeys(JSON.parse(readFileSync(join(configDir, '.mercury.json'), 'utf8'))) : []
  check('the only files naming the ephemeral session are the tool-invocation trace (tool, time, ok) and the project\'s spend record (its totals) — never a word of the session', namesSession().every(path => path === 'mercury-trace.jsonl' || path === '.mercury.json') && configMentions.every(path => path.endsWith('.lastSessionId') || path.endsWith('.lastCostWindow.sessionId')), j({ files: namesSession(), configKeys: configMentions }))

  section('§3 the next session does not know the ephemeral one ran')
  const three = await session(SID3, 'third probe', [
    { kind: 'text', text: 'ANSWER-THREE', whenBody: 'third probe' },
    { kind: 'text', text: 'NOTE-THREE', whenBody: HANDOFF_ASK_MARK },
  ])
  check('the third run exits 0 and answers', three.exit === 0 && answeredWith(three.stdout, 'ANSWER-THREE'), `exit=${three.exit} stderr=${three.stderr.slice(0, 300)}`)
  const page = systemText(three.requests[0]?.body ?? {})
  const start = page.indexOf(ENTRY_PAGE_HEADING)
  const nextHeading = start >= 0 ? page.indexOf('\n# ', start + 1) : -1
  const lineage = start >= 0 ? page.slice(start, nextHeading > start ? nextHeading : start + 2000) : ''
  check('its page counts one session before it, the control, and never a third', lineage.includes('Session 2 of this work; 1 session before it') && !lineage.includes(FIRST_SESSION_LINE), lineage)
  check('its page carries the control\'s note as the last one left', lineage.includes('## The last note left (session 1, ') && lineage.includes('NOTE-ONE'), lineage)
  const final = readLedger(projectKey)
  check('the ledger holds the two plain sessions as ordinals 1 and 2', final.length === 2 && final[0]!.sessionId === SID1 && final[1]!.ordinal === 2 && final[1]!.sessionId === SID3, j(final.map(e => [e.ordinal, e.sessionId])))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ EPHEMERAL LEAVES NOTHING GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ EPHEMERAL LEAVES NOTHING RED (${failures} of ${checks} checks failed)`)
process.exit(1)
