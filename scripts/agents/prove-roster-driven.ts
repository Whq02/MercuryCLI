#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findOnPath } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { renderTurn, startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}
const KEEP = process.env.RD_KEEP === '1'
const nodeBin = findOnPath('node', process.env, process.platform)!

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const FIXTURE_KEY = 'fixture-key-000'
const CUSTOM_AGENT = 'harbour-counter'
const CUSTOM_PROMPT = 'You are the harbour counter, the owner\'s own agent kind: read the file you are pointed at and report how many harbours it names.'

type World = { home: string; cwd: string }
function seedWorld(): World {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'roster-drive-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'roster-drive-cwd-')))
  writeFileSync(join(cwd, 'harbours.txt'), 'Dover\nHull\nLeith\n')
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'sovereign' } }, null, 2) + '\n')
  mkdirSync(join(home, 'agents'), { recursive: true })
  writeFileSync(join(home, 'agents', `${CUSTOM_AGENT}.md`), `---\nname: ${CUSTOM_AGENT}\ndescription: "Counts the harbours a file names; the owner's own agent kind."\ntools: Read, Glob\n---\n\n${CUSTOM_PROMPT}\n`)
  return { home, cwd }
}

type Run = { frames: Array<Record<string, unknown>>; stderr: string; exit: number | null }
function runHeadless(world: World, fixture: FixtureApi, prompt: string): Promise<Run> {
  return new Promise(resolve => {
    const env: NodeJS.ProcessEnv = {
      HOME: world.home,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: world.home,
      MERCURY_DAEMON_DIR: join(world.home, 'daemon'),
      MERCURY_CREWS_DIR: join(world.home, 'crews'),
      MERCURY_CREDENTIAL_STORE: 'file',
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: FIXTURE_KEY,
      OPENAI_API_KEY: '',
      MERCURY_THINKING_BINDING: 'drop_block',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_TERMINAL_TITLE: '0',
    }
    const child = spawn(nodeBin, [DIST, 'run', '--input', 'rows', '--format', 'rows', '--mode', 'sovereign', '--model', 'claude-opus-5'], { cwd: world.cwd, env })
    const frames: Array<Record<string, unknown>> = []
    let stdout = ''
    let stderr = ''
    let consumed = 0
    let ended = false
    const finish = (exit: number | null): void => {
      if (ended) return
      ended = true
      clearTimeout(killer)
      resolve({ frames, stderr, exit })
    }
    const killer = setTimeout(() => child.kill('SIGKILL'), 150_000)
    child.stdout.on('data', d => {
      stdout += String(d)
      const lines = stdout.split('\n')
      for (; consumed < lines.length - 1; consumed++) {
        const line = lines[consumed]!.trim()
        if (line === '') continue
        try {
          const frame = JSON.parse(line) as Record<string, unknown>
          frames.push(frame)
          if (frame.type === 'result') child.stdin.end()
        } catch {
          continue
        }
      }
    })
    child.stderr.on('data', d => (stderr += String(d)))
    child.on('close', exit => finish(exit))
    child.on('error', () => finish(null))
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n')
  })
}

const resultText = (run: Run): string => run.frames.filter(f => f.type === 'result').map(f => String((f as { result?: unknown }).result ?? '')).join('\n')
const bodies = (fixture: FixtureApi): Array<Record<string, unknown>> => fixture.messageRequests().map(r => r.body as Record<string, unknown>)
const toolNamesOf = (body: Record<string, unknown>): string[] => (Array.isArray(body.tools) ? (body.tools as Array<{ name: string }>).map(t => t.name) : [])
const systemTextOf = (body: Record<string, unknown>): string => (Array.isArray(body.system) ? (body.system as Array<{ text?: string }>).map(s => s.text ?? '').join('\n') : String(body.system ?? ''))
const toolResultsOf = (body: Record<string, unknown>): string[] => {
  const out: string[] = []
  for (const message of (body.messages as Array<{ content?: unknown }> | undefined) ?? []) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content as Array<{ type?: string; content?: unknown }>) {
      if (block.type !== 'tool_result') continue
      out.push(typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? (block.content as Array<{ text?: string }>).map(b => b.text ?? '').join('\n') : '')
    }
  }
  return out
}
const seatBodies = (fixture: FixtureApi, brief: string): Array<Record<string, unknown>> => bodies(fixture).filter(body => JSON.stringify(body).includes(JSON.stringify({ text: brief }).slice(1, -1)))

async function leg(name: string, turnsFor: (world: World) => ScriptedTurn[], prompt: string): Promise<{ run: Run; fixture: FixtureApi; world: World }> {
  const world = seedWorld()
  const fixture = await startFixtureApi(turnsFor(world))
  let run: Run
  try {
    run = await runHeadless(world, fixture, prompt)
  } finally {
    await fixture.close()
  }
  if (KEEP) console.log(`  [${name}] frames=${run.frames.length} requests=${fixture.messageRequests().length} exit=${run.exit}\n${run.stderr.slice(-800)}`)
  return { run, fixture, world }
}
const drop = (world: World): void => {
  if (KEEP) return
  rmSync(world.home, { recursive: true, force: true })
  rmSync(world.cwd, { recursive: true, force: true })
}

const ASK = (word: string): string => `roster-drive ${word}: run the probe`
const BRIEF = (word: string): string => `${word}-seat: write the probe file ${word}-wrote.txt with the Write tool, then report in one line`

section('§1 a crew lane: mercury-crew carries the full tool set and writes the probe file')
{
  const word = 'crew'
  const { run, fixture, world } = await leg(word, w => [
    { kind: 'tool_use', name: 'Agent', input: { description: `${word}-seat`, prompt: BRIEF(word), subagent_type: 'mercury-crew' }, whenBody: ASK(word) },
    { kind: 'tool_use', name: 'Write', input: { file_path: join(w.cwd, `${word}-wrote.txt`), content: `${word} wrote this\n` }, whenSaid: BRIEF(word) },
    { kind: 'text', text: `${word}-seat: wrote the probe file`, whenSaid: BRIEF(word) },
    { kind: 'text', text: `roster-drive ${word}: the seat reported — ${word}-seat: wrote the probe file`, whenBody: `${word}-seat: wrote the probe file` },
  ], ASK(word))
  const seats = seatBodies(fixture, BRIEF(word))
  const probe = join(world.cwd, `${word}-wrote.txt`)
  check('the crew seat was dispatched (its brief reached the model as a user turn)', seats.length >= 2, `${seats.length} seat request(s); exit=${run.exit}; ${run.stderr.slice(-300)}`)
  const seatTools = toolNamesOf(seats[0] ?? {})
  check('the crew seat carries the writers and the shell', ['Write', 'Edit', 'Bash', 'Read'].every(t => seatTools.includes(t)), seatTools.join(','))
  check('the crew seat never carries the Agent tool', !seatTools.includes('Agent'))
  check("the crew seat's system prompt is Mercury's crew prompt", systemTextOf(seats[0] ?? {}).includes('You are an agent for Mercury'))
  check('the probe file stands written by the crew seat', existsSync(probe) && readFileSync(probe, 'utf8') === `${word} wrote this\n`, existsSync(probe) ? readFileSync(probe, 'utf8') : 'absent')
  check("the lead relayed the seat's report", resultText(run).includes(`${word}-seat: wrote the probe file`), resultText(run))
  drop(world)
}

section('§2 a scout run: mercury-scout has no writer; its write attempt is refused and nothing is written')
{
  const word = 'scout'
  const { run, fixture, world } = await leg(word, w => [
    { kind: 'tool_use', name: 'Agent', input: { description: `${word}-seat`, prompt: BRIEF(word), subagent_type: 'mercury-scout' }, whenBody: ASK(word) },
    { kind: 'tool_use', name: 'Write', input: { file_path: join(w.cwd, `${word}-wrote.txt`), content: `${word} wrote this\n` }, whenSaid: BRIEF(word) },
    { kind: 'text', text: `${word}-seat: the write was refused`, whenSaid: BRIEF(word) },
    { kind: 'text', text: `roster-drive ${word}: the seat reported — ${word}-seat: the write was refused`, whenBody: `${word}-seat: the write was refused` },
  ], ASK(word))
  const seats = seatBodies(fixture, BRIEF(word))
  const probe = join(world.cwd, `${word}-wrote.txt`)
  check('the scout seat was dispatched', seats.length >= 2, `${seats.length} seat request(s); exit=${run.exit}; ${run.stderr.slice(-300)}`)
  const seatTools = toolNamesOf(seats[0] ?? {})
  check('the scout seat carries no Write, Edit, NotebookEdit or Agent tool', !['Write', 'Edit', 'NotebookEdit', 'Agent'].some(t => seatTools.includes(t)), seatTools.join(','))
  check('the scout seat keeps Read, Grep and Glob', ['Read', 'Grep', 'Glob'].every(t => seatTools.includes(t)), seatTools.join(','))
  check("the scout seat's system prompt is the read-only scout's", systemTextOf(seats[0] ?? {}).includes("You are Mercury's repository scout") && systemTextOf(seats[0] ?? {}).includes('Read-only — absolute prohibitions'))
  const refusal = toolResultsOf(seats[1] ?? {}).find(text => text.includes('No such tool available: Write')) ?? ''
  check('the Write attempt came back to the scout as a refusal naming the missing tool', refusal.includes('No such tool available: Write'), toolResultsOf(seats[1] ?? {}).join(' | ').slice(0, 300))
  check('nothing was written', !existsSync(probe))
  check("the lead relayed the seat's report", resultText(run).includes(`${word}-seat: the write was refused`), resultText(run))
  drop(world)
}

section('§2b the scout\'s shell: a read-only command runs, a writing command is refused, nothing is written')
{
  const word = 'shell'
  const brief = `${word}-seat: run two shell commands and report both outcomes`
  const { run, fixture, world } = await leg(word, w => [
    { kind: 'tool_use', name: 'Agent', input: { description: `${word}-seat`, prompt: brief, subagent_type: 'mercury-scout' }, whenBody: ASK(word) },
    { kind: 'tool_use', name: 'Bash', input: { command: 'cat harbours.txt', description: 'read the harbours' }, whenSaid: brief },
    { kind: 'tool_use', name: 'Bash', input: { command: `printf shell > ${join(w.cwd, `${word}-wrote.txt`)}`, description: 'write a probe file' }, whenSaid: brief },
    { kind: 'text', text: `${word}-seat: the read ran, the write was refused`, whenSaid: brief },
    { kind: 'text', text: `roster-drive ${word}: the seat reported — ${word}-seat: the read ran, the write was refused`, whenBody: `${word}-seat: the read ran, the write was refused` },
  ], ASK(word))
  const seats = seatBodies(fixture, brief)
  const probe = join(world.cwd, `${word}-wrote.txt`)
  check('the scout seat was dispatched with the shell', seats.length >= 3 && toolNamesOf(seats[0] ?? {}).includes('Bash'), `${seats.length} seat request(s); exit=${run.exit}; ${run.stderr.slice(-300)}`)
  const results = seats.flatMap(toolResultsOf)
  check('the read-only command ran and its output came back', results.some(t => t.includes('Dover')), results.join(' | ').slice(0, 300))
  check('the writing command was refused as the scout\'s read-only shell', results.some(t => t.includes('mercury-scout is read-only')), results.join(' | ').slice(0, 400))
  check('nothing was written', !existsSync(probe))
  check("the lead relayed the seat's report", resultText(run).includes(`${word}-seat: the read ran, the write was refused`), resultText(run))
  drop(world)
}

section("§3 a custom agent the owner's shape defines works, with its own prompt and tools")
{
  const word = 'custom'
  const brief = `${word}-seat: count the harbours in harbours.txt`
  const { run, fixture, world } = await leg(word, w => [
    { kind: 'tool_use', name: 'Agent', input: { description: `${word}-seat`, prompt: brief, subagent_type: CUSTOM_AGENT }, whenBody: ASK(word) },
    { kind: 'tool_use', name: 'Read', input: { file_path: join(w.cwd, 'harbours.txt') }, whenSaid: brief },
    { kind: 'text', text: `${word}-seat: three harbours`, whenSaid: brief },
    { kind: 'text', text: `roster-drive ${word}: the seat reported — ${word}-seat: three harbours`, whenBody: `${word}-seat: three harbours` },
  ], ASK(word))
  const seats = seatBodies(fixture, brief)
  check('the custom agent was dispatched by its own name', seats.length >= 2, `${seats.length} seat request(s); exit=${run.exit}; ${run.stderr.slice(-300)}`)
  const seatTools = toolNamesOf(seats[0] ?? {})
  check('the custom agent carries exactly the tools its file declares', seatTools.includes('Read') && seatTools.includes('Glob') && !seatTools.includes('Write') && !seatTools.includes('Bash'), seatTools.join(','))
  check("the custom agent's system prompt is its own file's body", systemTextOf(seats[0] ?? {}).includes(CUSTOM_PROMPT))
  check('its Read reached the file and the result came back', toolResultsOf(seats[1] ?? {}).some(text => text.includes('Dover')), toolResultsOf(seats[1] ?? {}).join(' | ').slice(0, 200))
  check("the lead relayed the seat's report", resultText(run).includes(`${word}-seat: three harbours`), resultText(run))
  const roster = toolNamesOf(bodies(fixture)[0] ?? {})
  const agentTool = (bodies(fixture)[0]?.tools as Array<{ name: string; description?: string }> | undefined)?.find(t => t.name === 'Agent')
  check("the lead's Agent tool lists the two built-ins then the owner's agent", roster.includes('Agent') && /- mercury-crew: .*\n- mercury-scout: .*\n- harbour-counter: /s.test(agentTool?.description ?? ''), (agentTool?.description ?? '').split('\n').filter(l => l.startsWith('- ')).join(' | ').slice(0, 300))
  drop(world)
}

section('§4 an old type name is unknown exactly as a made-up one')
{
  const word = 'unknown'
  const oldName = 'mercury-' + 'general'
  const { run, fixture, world } = await leg(word, () => [
    { kind: 'tool_use', name: 'Agent', input: { description: 'old-seat', prompt: 'old-seat: nothing', subagent_type: oldName }, whenBody: ASK(word) },
    { kind: 'tool_use', name: 'Agent', input: { description: 'made-up-seat', prompt: 'made-up-seat: nothing', subagent_type: 'mercury-frobnicate' }, whenBody: `Agent type '${oldName}' not found` },
    { kind: 'text', text: `roster-drive ${word}: both refused`, whenBody: "Agent type 'mercury-frobnicate' not found" },
  ], ASK(word))
  const results = bodies(fixture).flatMap(toolResultsOf)
  const oldRefusal = results.find(t => t.includes(`Agent type '${oldName}' not found`)) ?? ''
  const madeUpRefusal = results.find(t => t.includes("Agent type 'mercury-frobnicate' not found")) ?? ''
  check('the old name is refused as not found', oldRefusal !== '', results.join(' | ').slice(0, 400))
  check('the made-up name is refused with the same words', madeUpRefusal !== '' && madeUpRefusal.replace('mercury-frobnicate', oldName) === oldRefusal, `${oldRefusal} ⇄ ${madeUpRefusal}`)
  check('the refusal names the available roster: the two built-ins and the owner\'s agent', oldRefusal.includes('Available agents: mercury-crew, mercury-scout, harbour-counter'), oldRefusal)
  check('the lead settled', resultText(run).includes(`roster-drive ${word}: both refused`), `${resultText(run)} ${run.stderr.slice(-200)}`)
  drop(world)
}

section('§5 the docs skill in a fresh chat: how do I schedule a prompt — answered from the shipped pages, no web fetch')
{
  const question = 'how do i schedule a prompt in mercury'
  const ask = `roster-drive docs: ${question}`
  const answer = 'roster-drive docs: the docs say — /saturn opens the schedule board; inside a session the model schedules with CronCreate (a prompt on a recurrence or a one-shot), and the /loop skill repeats a prompt on a cadence (docs/SATURN.md).'
  const captured: Array<Record<string, unknown>> = []
  let seq = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(url.endsWith('count_tokens') ? JSON.stringify({ input_tokens: 100 }) : '{}')
        return
      }
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        body = {}
      }
      captured.push(body)
      const text = JSON.stringify(body)
      const base = /Base directory for this skill: (\S+) /.exec(text)?.[1]?.replace(/\\\\/g, '\\')
      let turn: ScriptedTurn
      if (text.includes('## In-session schedules')) turn = { kind: 'text', text: answer }
      else if (base !== undefined) turn = { kind: 'tool_use', name: 'Read', input: { file_path: join(base, 'docs', 'SATURN.md') } }
      else turn = { kind: 'tool_use', name: 'Skill', input: { skill: 'mercury-docs', args: question } }
      seq++
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.end(renderTurn(turn, seq))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
  const world = seedWorld()
  const fixture = { url, messageRequests: () => captured.map(body => ({ body })) } as unknown as FixtureApi
  let run: Run
  try {
    run = await runHeadless(world, fixture, ask)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  if (KEEP) console.log(`  [docs] requests=${captured.length} exit=${run.exit}\n${run.stderr.slice(-800)}`)
  const all = captured
  const skillTurn = all.find(body => JSON.stringify(body).includes("Answer the question from Mercury's own documentation"))
  check("the Skill tool expanded mercury-docs into the chat with the shipped pages' map", skillTurn !== undefined && JSON.stringify(skillTurn).includes('- docs/SATURN.md — Saturn — session schedules'), `${all.length} request(s); exit=${run.exit}; ${run.stderr.slice(-300)}`)
  const base = /Base directory for this skill: (\S+) /.exec(JSON.stringify(skillTurn ?? {}))?.[1]?.replace(/\\\\/g, '\\')
  check('the pages stand extracted under a per-process temp root, not the config home', base !== undefined && !base.startsWith(world.home) && existsSync(join(base, 'docs', 'SATURN.md')), String(base))
  const saturnRead = all.flatMap(toolResultsOf).find(t => t.includes('## In-session schedules'))
  check('the model read the Saturn page from the extracted copy', saturnRead !== undefined && saturnRead.includes('CronCreate') && saturnRead.includes('`/saturn`'))
  const toolUses = all.flatMap(body => ((body.messages as Array<{ content?: unknown }> | undefined) ?? []).flatMap(m => (Array.isArray(m.content) ? (m.content as Array<{ type?: string; name?: string }>).filter(b => b.type === 'tool_use').map(b => b.name ?? '') : [])))
  check('no WebFetch and no WebSearch anywhere in the run', toolUses.length > 0 && !toolUses.includes('WebFetch') && !toolUses.includes('WebSearch'), toolUses.join(','))
  check('the answer names the real command and tool the docs name', /\/saturn/.test(resultText(run)) && /CronCreate/.test(resultText(run)), resultText(run))
  const systemText = systemTextOf(all[0] ?? {})
  check("the session's guidance sends questions about Mercury to the docs skill", systemText.includes('invoke the `mercury-docs` skill through the Skill tool'))
  drop(world)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} ROSTER DRIVEN ${failures === 0 ? 'GREEN' : 'RED'} (${checks - failures} of ${checks})`)
process.exit(failures === 0 ? 0 : 1)
