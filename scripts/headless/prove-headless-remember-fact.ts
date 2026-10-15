#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, handoffTurn, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const FACT = "the deploy runs from the shop's Raspberry Pi over ssh as user pi, from the deploy folder"
const PROMPT = `remember: ${FACT}`
const ANSWER = 'Remembered: the deploy runs from the Raspberry Pi; saved to this project\'s memory.'
let failures = 0
function check(label: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(detail)}`)
  if (!ok) failures++
}
type Row = Record<string, unknown> & { type?: string; tool?: string; call_id?: string; status?: string; output?: unknown }
const convention = (): ScriptedTurn => ({ kind: 'tool_use', name: 'RecordConvention', input: { rule: FACT } })
const retain = (): ScriptedTurn => ({ kind: 'tool_use', name: 'Retain', input: { items: [{ content: FACT, context: 'the user said so in chat', topic: 'deploy' }] } })
const scripts: Record<string, { turns: ScriptedTurn[]; allowed: string[] }> = {
  'convention-then-fact': { turns: [convention(), retain()], allowed: [] },
  'fact-then-convention': { turns: [retain(), convention()], allowed: [] },
  'convention-alone': { turns: [convention()], allowed: [] },
  'pre-approved': { turns: [convention()], allowed: ['RecordConvention'] },
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
    return statSync(p).isDirectory() ? walk(p) : readFileSync(p, 'utf8')
  }).join('\n')
  return walk(lib)
}
function pinsOf(home: string): unknown[] {
  const lib = libraryOf(home)
  if (lib === null || !existsSync(join(lib, 'pins.json'))) return []
  return (JSON.parse(readFileSync(join(lib, 'pins.json'), 'utf8')) as { pins?: unknown[] }).pins ?? []
}
for (const [shape, script] of Object.entries(scripts)) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'remember-fact-')))
  const cwd = join(home, 'project')
  mkdirSync(cwd)
  seedFirstRun(home, [cwd])
  const api = await startFixtureApi([...script.turns, { kind: 'text', text: ANSWER }, handoffTurn(), handoffTurn()])
  try {
    const args = [join(ROOT, 'dist', 'mercury.mjs'), 'run', '--format', 'rows', PROMPT, ...(script.allowed.length > 0 ? ['--allowed-tools', ...script.allowed] : [])]
    const child = spawn('node', args, {
      windowsHide: true, cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), BROWSER: '/usr/bin/true', MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const code = await new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit) })
    const rows = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as Row)
    const outcome = rows.find(row => row.type === 'outcome') as (Row & { denials?: Array<{ tool: string }>; notices?: Array<{ text: string }>; answer?: string; error?: { message?: string } }) | undefined
    const calls = new Map(rows.filter(row => row.type === 'tool_call').map(row => [row.call_id, row.tool]))
    const resultOf = (tool: string): Row | undefined => rows.find(row => row.type === 'tool_result' && calls.get(row.call_id) === tool)
    const conventionResult = resultOf('RecordConvention')
    const conventionOutput = String(conventionResult?.output ?? '')
    const estateFile = join(cwd, 'MERCURY.md')
    const written = existsSync(estateFile) ? readFileSync(estateFile, 'utf8') : null
    console.log(`\n── ${shape} ──`)
    check(`${shape}: the run ends completed with exit 0 — never blocked on an ask nobody could answer`, code === 0 && outcome?.status === 'completed' && outcome.answer === ANSWER, { code, status: outcome?.status, error: outcome?.error?.message, stderr: stderr.slice(-400) })
    check(`${shape}: no denial is recorded against RecordConvention`, outcome !== undefined && !(outcome.denials ?? []).some(denial => denial.tool === 'RecordConvention'), outcome?.denials)
    check(`${shape}: no notice says RecordConvention was not approved`, outcome !== undefined && !(outcome.notices ?? []).some(notice => notice.text.includes('RecordConvention')), outcome?.notices)
    if (script.allowed.length > 0) {
      check(`${shape}: a pre-approved RecordConvention writes the convention into the project's MERCURY.md as before`, conventionResult?.status === 'ok' && written !== null && written.includes(FACT) && /recorded/i.test(conventionOutput), { status: conventionResult?.status, output: conventionOutput.slice(0, 240), written })
    } else {
      check(`${shape}: the RecordConvention result is a plain result, not an error row`, conventionResult?.status === 'ok', { status: conventionResult?.status, output: conventionOutput.slice(0, 300) })
      check(`${shape}: the result says the convention was not recorded and what Mercury would have asked (the file, the rule)`, /not recorded/i.test(conventionOutput) && conventionOutput.includes(estateFile) && conventionOutput.includes(FACT) && /would have asked/.test(conventionOutput), conventionOutput.slice(0, 400))
      check(`${shape}: nothing was written into the project's instruction file`, written === null, written)
    }
    if (script.turns.some(turn => turn.kind === 'tool_use' && turn.name === 'Retain')) {
      const retainOutput = String(resultOf('Retain')?.output ?? '')
      check(`${shape}: the fact is stored in memory`, retainOutput.startsWith('1 stored · 0 refused') && libraryText(home).includes(FACT), { retainOutput: retainOutput.slice(0, 200), library: libraryOf(home) })
      check(`${shape}: the fact is NOT pinned — a plain "remember:" is a fact, not a standing rule`, pinsOf(home).length === 0 && !retainOutput.includes('pinned rule'), { pins: pinsOf(home), retainOutput: retainOutput.slice(0, 200) })
    }
  } finally {
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
}
if (failures) process.exit(1)
console.log('prove-headless-remember-fact: GREEN')
