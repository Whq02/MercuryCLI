#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
          if (frame.type === 'outcome') child.stdin.end()
        } catch {
          continue
        }
      }
    })
    child.stderr.on('data', d => (stderr += String(d)))
    child.on('close', exit => finish(exit))
    child.on('error', () => finish(null))
    child.stdin.write(JSON.stringify({ type: 'prompt', content: prompt }) + '\n')
  })
}

const resultText = (run: Run): string => run.frames.filter(f => f.type === 'outcome').map(f => String((f as { answer?: unknown }).answer ?? '')).join('\n')
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
const SCOUT_REFUSAL = 'mercury-scout is read-only'
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}
const filesCarrying = (dir: string, needle: string): string[] => walk(dir).filter(path => {
  try {
    return readFileSync(path, 'utf8').includes(needle)
  } catch {
    return false
  }
})
type ClassifiedTool = { name: string; isReadOnly: (input: Record<string, unknown>) => boolean; call: (...args: unknown[]) => Promise<unknown> }
const readsOnlyAtRest = (tool: ClassifiedTool | undefined): boolean => {
  if (tool === undefined) return false
  try {
    return tool.isReadOnly({}) === true
  } catch {
    return false
  }
}

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
  check('the scout seat carries no worktree door, no schedule writer and no memory writer', !['EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete', 'ScheduleWakeup', 'Retain', 'Correct', 'RecordConvention'].some(t => seatTools.includes(t)), seatTools.join(','))
  const { getAllBaseTools } = await import('../../src/tools.ts')
  const baseTools = new Map((getAllBaseTools() as unknown as ClassifiedTool[]).map(t => [t.name, t]))
  const offered = seatTools.filter(t => t !== 'Bash' && t !== 'Skill')
  const writers = offered.filter(t => !readsOnlyAtRest(baseTools.get(t)))
  check("every tool the scout seat is offered is read-only by the tool's own classification (the shell and the skill door apart)", offered.length > 0 && writers.length === 0, `writers offered: ${writers.join(',') || 'none'}; wire: ${seatTools.join(',')}`)
  check("the scout seat's system prompt is the read-only scout's", systemTextOf(seats[0] ?? {}).includes("You are Mercury's repository scout") && systemTextOf(seats[0] ?? {}).includes('Read-only — absolute prohibitions'))
  const refusal = toolResultsOf(seats[1] ?? {}).find(text => text.includes('No such tool available: Write')) ?? ''
  check('the Write attempt came back to the scout as a refusal naming the missing tool', refusal.includes('No such tool available: Write'), toolResultsOf(seats[1] ?? {}).join(' | ').slice(0, 300))
  check('nothing was written', !existsSync(probe))
  check("the lead relayed the seat's report", resultText(run).includes(`${word}-seat: the write was refused`), resultText(run))
  const agentTool = (bodies(fixture)[0]?.tools as Array<{ name: string; description?: string }> | undefined)?.find(t => t.name === 'Agent')
  const scoutLine = (agentTool?.description ?? '').split('\n').find(line => line.startsWith('- mercury-scout: ')) ?? ''
  check("the lead's roster line describes the scout's tools as read-only", scoutLine.includes('(Tools: read-only') && !scoutLine.includes('All tools'), scoutLine.slice(-160))
  drop(world)
}

section('§2c a scout run: a memory write (Retain) is refused and nothing lands on disk')
{
  const word = 'retain'
  const brief = `${word}-seat: remember the reef fact, then report in one line`
  const fact = 'the reef probe fact: a scout tried to store this'
  const { run, fixture, world } = await leg(word, () => [
    { kind: 'tool_use', name: 'Agent', input: { description: `${word}-seat`, prompt: brief, subagent_type: 'mercury-scout' }, whenBody: ASK(word) },
    { kind: 'tool_use', name: 'Retain', input: { items: [{ content: fact, topic: 'scout-probe' }] }, whenSaid: brief },
    { kind: 'text', text: `${word}-seat: the memory write was refused`, whenSaid: brief },
    { kind: 'text', text: `roster-drive ${word}: the seat reported — ${word}-seat: the memory write was refused`, whenBody: `${word}-seat: the memory write was refused` },
  ], ASK(word))
  const seats = seatBodies(fixture, brief)
  check('the scout seat was dispatched', seats.length >= 2, `${seats.length} seat request(s); exit=${run.exit}; ${run.stderr.slice(-300)}`)
  check('the scout seat is not offered the memory writer', !toolNamesOf(seats[0] ?? {}).includes('Retain'), toolNamesOf(seats[0] ?? {}).join(','))
  const results = seats.flatMap(toolResultsOf)
  check('the Retain attempt came back refused — never "stored"', results.length > 0 && results.some(t => t.includes('No such tool available: Retain') || t.includes(SCOUT_REFUSAL)) && !results.some(t => /\d+ stored/.test(t)), results.join(' | ').slice(0, 400))
  const stored = filesCarrying(world.home, fact).filter(path => !/\/subagents\/|\/[0-9a-f-]{36}\.jsonl$/.test(path))
  check('nothing carrying the fact landed in a memory store under the home (the transcripts alone carry the attempt)', stored.length === 0, stored.join(','))
  check("the lead relayed the seat's report", resultText(run).includes(`${word}-seat: the memory write was refused`), resultText(run))
  drop(world)
}

section('§2d a scout run: an input-dependent tool is offered, its writing form (AstEdit apply) is refused as the scout\'s, nothing changes')
{
  const word = 'astedit'
  const brief = `${word}-seat: rewrite Dover to Calais in harbours.txt, then report in one line`
  const { run, fixture, world } = await leg(word, w => [
    { kind: 'tool_use', name: 'Agent', input: { description: `${word}-seat`, prompt: brief, subagent_type: 'mercury-scout' }, whenBody: ASK(word) },
    { kind: 'tool_use', name: 'AstEdit', input: { pattern: 'Dover', rewrite: 'Calais', path: join(w.cwd, 'harbours.txt'), apply: true, plan: 'ae-probe' }, whenSaid: brief },
    { kind: 'text', text: `${word}-seat: the rewrite was refused`, whenSaid: brief },
    { kind: 'text', text: `roster-drive ${word}: the seat reported — ${word}-seat: the rewrite was refused`, whenBody: `${word}-seat: the rewrite was refused` },
  ], ASK(word))
  const seats = seatBodies(fixture, brief)
  check('the scout seat was dispatched and is offered AstEdit (a dry run reads)', seats.length >= 2 && toolNamesOf(seats[0] ?? {}).includes('AstEdit'), `${seats.length} seat request(s); tools=${toolNamesOf(seats[0] ?? {}).join(',')}; exit=${run.exit}; ${run.stderr.slice(-300)}`)
  const results = seats.flatMap(toolResultsOf)
  check("the apply came back refused with the scout's one read-only line", results.some(t => t.includes(SCOUT_REFUSAL) && t.includes('AstEdit')), results.join(' | ').slice(0, 400))
  check('the file stands unchanged', readFileSync(join(world.cwd, 'harbours.txt'), 'utf8') === 'Dover\nHull\nLeith\n')
  check("the lead relayed the seat's report", resultText(run).includes(`${word}-seat: the rewrite was refused`), resultText(run))
  drop(world)
}

section("§2e the scout's tool gate itself: the pool is the read-only pool, the call road refuses a writing form")
{
  const policy = await import('../../src/tools/AgentTool/scoutPolicy.ts') as Partial<{ restrictScoutTools: (tools: ClassifiedTool[]) => ClassifiedTool[]; scoutRefusal: (tool: ClassifiedTool, input: Record<string, unknown>) => string | null }>
  const calls: string[] = []
  const tool = (name: string, isReadOnly: (input: Record<string, unknown>) => boolean): ClassifiedTool => ({ name, isReadOnly, call: async (...args: unknown[]) => { calls.push(`${name}:${JSON.stringify(args[0])}`); return 'ran' } })
  const pool = [
    tool('Bash', input => input.command === 'ls'),
    tool('Skill', () => false),
    tool('Read', () => true),
    tool('Retain', () => false),
    tool('AstEdit', input => input.apply !== true),
    tool('Agent', () => true),
    tool('EnterWorktree', () => true),
    tool('ExitWorktree', () => true),
    tool('Throws', () => { throw new Error('no input') }),
  ]
  const gated = policy.restrictScoutTools?.(pool) ?? []
  const names = gated.map(t => t.name)
  check('the pool keeps the shell, the skill door, the readers and the input-dependent tools', ['Bash', 'Skill', 'Read', 'AstEdit'].every(n => names.includes(n)), names.join(','))
  check('the pool drops an unconditional writer', !names.includes('Retain'), names.join(','))
  check('the pool drops the Agent tool and both worktree doors even when they claim to read', !['Agent', 'EnterWorktree', 'ExitWorktree'].some(n => names.includes(n)), names.join(','))
  check('a tool whose classification throws is not offered', !names.includes('Throws'), names.join(','))
  const astEdit = gated.find(t => t.name === 'AstEdit')
  const bash = gated.find(t => t.name === 'Bash')
  const read = gated.find(t => t.name === 'Read')
  const refusalOf = async (t: ClassifiedTool | undefined, input: Record<string, unknown>): Promise<string> => {
    try {
      await t?.call(input, {})
      return ''
    } catch (error) {
      return (error as Error).message
    }
  }
  check('the reading form passes through the call road', (await refusalOf(astEdit, { pattern: 'x', rewrite: 'y' })) === '' && (await refusalOf(read, { file_path: 'x' })) === '' && calls.length === 2, calls.join(' | '))
  const applyRefusal = await refusalOf(astEdit, { pattern: 'x', rewrite: 'y', apply: true, plan: 'ae-1' })
  check("the writing form is refused on the call road with the scout's one line naming the tool, and the tool never ran", applyRefusal.includes(SCOUT_REFUSAL) && applyRefusal.includes('AstEdit') && !applyRefusal.includes('\n') && calls.length === 2, applyRefusal)
  check("the shell keeps its own gate: a read-only command runs, a writing command is refused with the shell's line", (await refusalOf(bash, { command: 'ls' })) === '' && (await refusalOf(bash, { command: 'rm x' })).includes(SCOUT_REFUSAL) && (await refusalOf(bash, { command: 'ls', dangerouslyDisableSandbox: true })).includes(SCOUT_REFUSAL), calls.join(' | '))
  const askRoad = policy.scoutRefusal
  check('the ask road answers the same: a writing form is denied, a reading form and the skill door are not', typeof askRoad === 'function' && askRoad(pool[4]!, { apply: true }) !== null && askRoad(pool[4]!, {}) === null && askRoad(pool[1]!, { skill: 'mercury-docs' }) === null && askRoad(pool[3]!, { items: [] }) !== null && askRoad(pool[5]!, {}) !== null, String(askRoad?.(pool[4]!, { apply: true })))
}

section("§2f the agents screen says the scout's tools are the read-only pool, and the crew agent's are all")
{
  const { MERCURY_SCOUT_AGENT } = await import('../../src/tools/AgentTool/built-in/mercuryScoutAgent.ts')
  const { MERCURY_CREW_AGENT } = await import('../../src/tools/AgentTool/built-in/mercuryCrewAgent.ts')
  const { resolveEffectiveAgentRuntime } = await import('../../src/services/agents/resolver.ts')
  const { agentFaceDetailLines } = await import('../../src/components/BootAgentsScreen.tsx')
  const { getAllBaseTools } = await import('../../src/tools.ts')
  const { SCOUT_TOOLS_DESCRIPTION } = await import('../../src/tools/AgentTool/scoutPolicy.ts')
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const tools = getAllBaseTools()
  const lineFor = (agent: typeof MERCURY_SCOUT_AGENT): string => {
    const eff = resolveEffectiveAgentRuntime(agent as never, { parentModel: 'claude-fable-5', sessionEffort: undefined, tools })
    return agentFaceDetailLines({ id: `agent:${agent.agentType}`, kind: 'agent', agent } as never, new Map(), eff).find(l => l.startsWith('tools:')) ?? '(no tools line)'
  }
  const scoutLine = lineFor(MERCURY_SCOUT_AGENT)
  const crewLine = lineFor(MERCURY_CREW_AGENT)
  check("the scout's detail says the read-only pool — the same words the Agent tool's roster line uses", scoutLine === `tools: ${SCOUT_TOOLS_DESCRIPTION}` && scoutLine.includes('read-only'), scoutLine)
  check("the scout's detail never says all", !/\ball\b/.test(scoutLine), scoutLine)
  check("the crew agent's detail still says all", crewLine.startsWith('tools: all'), crewLine)
  const scoutEff = resolveEffectiveAgentRuntime(MERCURY_SCOUT_AGENT as never, { parentModel: 'claude-fable-5', sessionEffort: undefined, tools })
  const crewEff = resolveEffectiveAgentRuntime(MERCURY_CREW_AGENT as never, { parentModel: 'claude-fable-5', sessionEffort: undefined, tools })
  check('the resolution itself carries the read-only fact for the scout alone', scoutEff.tools?.readOnly === true && crewEff.tools?.readOnly === undefined, JSON.stringify({ scout: scoutEff.tools?.readOnly, crew: crewEff.tools?.readOnly }))
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
