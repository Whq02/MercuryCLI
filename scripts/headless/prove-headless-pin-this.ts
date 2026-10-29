#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startScriptedFixture, type WireBlock } from '../lib/scriptedTurn.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const RULE = 'deploys go through the release script'
const STATED = 'Deploys go through the release script.'
const CREWMATE_PROMPT = `pin this: ${RULE}`
const ASKED_GRADE = '[pinned · asked by the owner]'
const TODAYS_NOTE = 'pin needs the originating owner message asking for these words as a standing rule (none found in this turn); nothing was stored — retain the fact without pin, or the owner pins it in /memory'
const CREWMATE_NOTE = 'Retain is refused: a crewmate never writes memory — put the finding in your report; the lead decides what is remembered'
let failures = 0
function check(label: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${JSON.stringify(detail)?.slice(0, 700)}`}`)
  if (!ok) failures++
}
type Row = Record<string, unknown> & { type?: string; tool?: string; call_id?: string; status?: string; output?: unknown; parent_call_id?: string }
const retain = (pin: boolean): WireBlock => ({ type: 'tool_use', name: 'Retain', input: { items: [{ content: STATED, topic: 'deployment', ...(pin ? { pin: true } : {}) }] } })
const text = (words: string): WireBlock => ({ type: 'text', text: words })
type Cell = {
  prompt: string
  answer: string
  main: (step: number) => WireBlock[]
  crewmate?: (step: number) => WireBlock[]
  expect: 'pinned' | 'fact' | 'crewmate-refused'
}
const cells: Record<string, Cell> = {
  'explicit pin': {
    prompt: `pin this: ${RULE}`,
    answer: `Pinned, asked for by you: "${RULE}". It loads into every session from the next chat on.`,
    main: step => (step === 0 ? [retain(true)] : [text(`Pinned, asked for by you: "${RULE}". It loads into every session from the next chat on.`)]),
    expect: 'pinned',
  },
  'vague words': {
    prompt: `remember: we deploy through the release script these days`,
    answer: `Saved as a fact: ${STATED}`,
    main: step => (step === 0 ? [retain(true)] : step === 1 ? [retain(false)] : [text(`Saved as a fact: ${STATED}`)]),
    expect: 'fact',
  },
  'from now on': {
    prompt: `from now on, ${RULE}`,
    answer: `Pinned: "${RULE}".`,
    main: step => (step === 0 ? [retain(true)] : [text(`Pinned: "${RULE}".`)]),
    expect: 'pinned',
  },
  'a crewmate pins': {
    prompt: `have a crewmate pin this rule for me: ${RULE}`,
    answer: 'The crewmate could not pin it; nothing was stored.',
    main: step => (step === 0 ? [{ type: 'tool_use', name: 'Crewmate', input: { description: 'pin the rule', prompt: CREWMATE_PROMPT } }] : [text('The crewmate could not pin it; nothing was stored.')]),
    crewmate: step => (step === 0 ? [retain(true)] : [text('Refused: a crewmate cannot pin.')]),
    expect: 'crewmate-refused',
  },
}
function libraryOf(home: string): string | null {
  const projects = join(home, 'projects')
  if (!existsSync(projects)) return null
  const walk = (dir: string): string | null => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (name === 'library' && statSync(p).isDirectory()) return p
      if (statSync(p).isDirectory()) {
        const hit = walk(p)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(projects)
}
function libraryText(home: string): string {
  const lib = libraryOf(home)
  if (lib === null) return ''
  const walk = (dir: string): string => readdirSync(dir).map(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : name.endsWith('.json') ? '' : readFileSync(p, 'utf8')
  }).join('\n')
  return walk(lib)
}
function pinsOf(home: string): Array<{ seq?: number; asked?: boolean }> {
  const lib = libraryOf(home)
  if (lib === null || !existsSync(join(lib, 'pins.json'))) return []
  return (JSON.parse(readFileSync(join(lib, 'pins.json'), 'utf8')) as { pins?: Array<{ seq?: number; asked?: boolean }> }).pins ?? []
}
const { memoryGrade } = await import('../../src/mneme/memoryEvidence.ts')
for (const [name, cell] of Object.entries(cells)) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pin-this-')))
  const cwd = join(home, 'project')
  mkdirSync(cwd)
  seedFirstRun(home, [cwd])
  const api = await startScriptedFixture(req => {
    if (cell.crewmate !== undefined && req.opening.trim() === CREWMATE_PROMPT) return cell.crewmate(req.step)
    return cell.main(req.step)
  })
  try {
    const args = [join(ROOT, 'dist', 'mercury.mjs'), 'run', '--format', 'rows', '--', cell.prompt]
    const child = spawn('node', args, {
      windowsHide: true, cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), BROWSER: '/usr/bin/true', MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_EMBED_ENGINE: 'off', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.base },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    const code = await new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit) })
    clearTimeout(timer)
    const rows = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as Row)
    const outcome = rows.find(row => row.type === 'outcome') as (Row & { answer?: string; error?: { message?: string } }) | undefined
    const calls = rows.filter(row => row.type === 'tool_call')
    const retainCalls = calls.filter(row => row.tool === 'Retain')
    const resultOf = (call: Row | undefined): string => String((rows.find(row => row.type === 'tool_result' && row.call_id === call?.call_id) ?? {}).output ?? '')
    const retainOutputs = retainCalls.map(resultOf)
    const pins = pinsOf(home)
    const library = libraryText(home)
    console.log(`\n── ${name} · mercury run --format rows -- "${cell.prompt}" ──`)
    check(`${name}: the run ends completed, exit 0, the answer saying what landed`, code === 0 && outcome?.status === 'completed' && outcome.answer === cell.answer, { code, status: outcome?.status, answer: outcome?.answer, error: outcome?.error?.message, stderr: stderr.slice(-400) })
    if (cell.expect === 'pinned') {
      check(`${name}: the Retain with pin stored the rule (no refusal)`, retainOutputs.length === 1 && retainOutputs[0]!.startsWith('1 stored · 0 refused'), retainOutputs)
      check(`${name}: the result says the pinned rule reaches the shelf`, /pinned rule/.test(retainOutputs[0] ?? ''), retainOutputs)
      check(`${name}: the rule is on the pinned shelf, marked asked for by the owner`, pins.length === 1 && pins[0]!.asked === true, pins)
      check(`${name}: the page grades it exactly as an asked pin`, pins.length === 1 && memoryGrade({ pin: { asked: pins[0]!.asked === true } }) === ASKED_GRADE, pins)
      check(`${name}: the rule's words are in the library verbatim`, library.includes(STATED.replace(/\.$/, '')) || library.includes(STATED), library.slice(0, 600))
    } else if (cell.expect === 'fact') {
      check(`${name}: the pin was refused with today's note and nothing stored by that call`, retainOutputs.length === 2 && retainOutputs[0]!.startsWith('0 stored · 1 refused') && retainOutputs[0]!.includes(TODAYS_NOTE), retainOutputs)
      check(`${name}: the plain Retain stored the fact`, retainOutputs[1]?.startsWith('1 stored · 0 refused') === true && library.includes(STATED), { retainOutputs, library: library.slice(0, 400) })
      check(`${name}: nothing is pinned`, pins.length === 0, pins)
    } else {
      const crewmateCall = calls.find(row => row.tool === 'Crewmate')
      const childRetain = retainCalls.find(row => row.parent_call_id !== undefined && row.parent_call_id === crewmateCall?.call_id)
      const childResult = resultOf(childRetain)
      check(`${name}: the crewmate ran and its Retain with pin is on the rows`, crewmateCall !== undefined && childRetain !== undefined, { crewmate: crewmateCall?.call_id, retains: retainCalls.map(r => [r.call_id, r.parent_call_id]) })
      check(`${name}: the crewmate's pin is refused as today, word for word`, childResult.startsWith('0 stored · 1 refused') && childResult.includes(CREWMATE_NOTE), childResult)
      check(`${name}: nothing is pinned and the rule is not in the library`, pins.length === 0 && !library.includes(RULE), { pins, library: library.slice(0, 400) })
    }
  } finally {
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
}
if (failures) process.exit(1)
console.log('prove-headless-pin-this: GREEN')
