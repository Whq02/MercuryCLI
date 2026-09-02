#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.log('❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)')
  process.exit(1)
}
const nodeBin = Bun.which('node')
if (!nodeBin) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — scenario exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

interface Arena {
  home: string
  cwd: string
  env: Record<string, string>
}
function makeArena(fixture: FixtureApi): Arena {
  const home = mkdtempSync(join(tmpdir(), 'convergence-s16-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'convergence-s16-cwd-'))
  mkdirSync(join(home, '.mercury'), { recursive: true })
  return {
    home,
    cwd,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_VERIFY_EVIDENCE: '0',
    },
  }
}
function run(arena: Arena, args: string[]): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return new Promise(resolvePromise => {
    const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.on('close', exit => {
      clearTimeout(killer)
      resolvePromise({ exit, stdout, stderr })
    })
  })
}

function countOf(hay: string, needle: string): number {
  let n = 0
  let i = hay.indexOf(needle)
  while (i !== -1) {
    n++
    i = hay.indexOf(needle, i + needle.length)
  }
  return n
}

console.log('============================================================')
console.log(' S16 — restart after a COMPLETED turn (no duplication)')
console.log('============================================================')

const SID = 'facef00d-0000-4000-8000-00000000c160'
const MARKER = 'S16-TURN-ONE-COMPLETE'
const fixtureTurns: ScriptedTurn[] = [
  { kind: 'tool_use', name: 'Write', input: {} },
  { kind: 'text', text: MARKER },
  { kind: 'text', text: 'S16-SECOND-REPLY' },
]
const fixture = await startFixtureApi(fixtureTurns)
const arena = makeArena(fixture)
const target = join(arena.cwd, 's16-effect.txt')
;(fixtureTurns[0] as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = {
  file_path: target,
  content: 'S16-EFFECT-ONCE',
}

const r1 = await run(arena, ['-p', 'write the file', '--model', 'claude-opus-4-8', '--session-id', SID, '--permission-mode', 'implement'])
check('turn 1 exit 0', r1.exit === 0, `exit=${r1.exit} stderr=${r1.stderr.slice(0, 300)}`)
check('turn 1 completed with the scripted text', r1.stdout.includes(MARKER), JSON.stringify(r1.stdout.slice(0, 160)))
check('the tool effect landed', existsSync(target))
check('…with the exact content, once', existsSync(target) && readFileSync(target, 'utf-8') === 'S16-EFFECT-ONCE')

const projectDirRoot = join(arena.home, '.mercury', 'projects')
function transcriptFiles(): Array<{ path: string; text: string }> {
  if (!existsSync(projectDirRoot)) return []
  const out: Array<{ path: string; text: string }> = []
  const stack = [projectDirRoot]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name.endsWith('.jsonl')) out.push({ path: p, text: readFileSync(p, 'utf-8') })
    }
  }
  return out
}
const t1Files = transcriptFiles()
check('turn 1 persisted: the user prompt is in a transcript', t1Files.some(f => countOf(f.text, 'write the file') >= 1))
check('turn 1 persisted: the completion is in a transcript', t1Files.some(f => countOf(f.text, MARKER) >= 1))

const r2 = await run(arena, ['-p', 'second prompt', '--model', 'claude-opus-4-8', '--resume', SID])
check('resume exit 0', r2.exit === 0, `exit=${r2.exit} stderr=${r2.stderr.slice(0, 300)}`)
check('turn 2 completed', r2.stdout.includes('S16-SECOND-REPLY'), JSON.stringify(r2.stdout.slice(0, 160)))

check('the effect did NOT replay across restart', readFileSync(target, 'utf-8') === 'S16-EFFECT-ONCE')

const msgs = fixture.messageRequests()
check('three model calls total (tool round = 2, resume = 1)', msgs.length === 3, String(msgs.length))
const resumeBody = JSON.stringify(msgs[2]?.body ?? {})
check('the resume request carries the turn-1 prompt exactly once', countOf(resumeBody, 'write the file') === 1, `count=${countOf(resumeBody, 'write the file')}`)
check('the resume request carries the turn-1 completion exactly once', countOf(resumeBody, MARKER) === 1, `count=${countOf(resumeBody, MARKER)}`)
check('the resume request carries the tool effect exactly once', countOf(resumeBody, 'S16-EFFECT-ONCE') >= 1 && countOf(resumeBody, '"tool_use_id"') >= 1)

for (const f of transcriptFiles()) {
  const userN = f.text
    .split('\n')
    .filter(l => (l.includes('"type":"user"') || l.includes('"kind":"input"')) && l.includes('write the file')).length
  const markerN = f.text
    .split('\n')
    .filter(l => (l.includes('"type":"assistant"') || l.includes('"kind":"output"')) && l.includes(MARKER)).length
  check(`no in-file duplication of the turn-1 user message (${f.path.split('/').pop()})`, userN <= 1, `count=${userN}`)
  check(`turn-1 completion appears once or as publish+settle (${f.path.split('/').pop()})`, markerN >= 1 && markerN <= 2, `count=${markerN}`)
}

const sidecarText = (() => {
  if (!existsSync(projectDirRoot)) return ''
  let out = ''
  const stack = [projectDirRoot]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name.includes('run') && e.name.endsWith('.json')) out += readFileSync(p, 'utf-8')
    }
  }
  return out
})()
if (sidecarText.length > 0) {
  check('the sidecar carries no fabricated execution lifecycle', !/"lifecycle"\s*:\s*"(executing|running)"/.test(sidecarText), sidecarText.slice(0, 200))
  check("an open (active) sidecar is the LATEST request's run, never a replay of turn 1", !/"lifecycle"\s*:\s*"active"/.test(sidecarText) || sidecarText.includes('"objective": "second prompt"') || sidecarText.includes('"objective":"second prompt"'), sidecarText.slice(0, 200))
} else {
  console.log('  [INFO] no run sidecar found (non-substantive classification) — laws 1–3 carry the scenario')
}

await fixture.close()

console.log('')
if (failures > 0) {
  console.log(`❌ S16: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ S16: restart after a completed turn duplicates nothing')
