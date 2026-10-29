#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { findOnPath } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { isOutcome, parseFrame } from '../lib/rows.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const ENTRY = 'I answered the one question the operator asked and nothing more. They wanted a short answer; I kept it short. I had nothing to get wrong this time and I say so plainly.'
const NOTE = 'The work is a throwaway project for a proof. Nothing was decided. Nothing is still to do. I got nothing wrong.'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

if (!existsSync(DIST)) {
  check('dist/mercury.mjs exists (build first — this proof drives the artifact)', false)
  process.exit(1)
}
const nodeBin = findOnPath('node', process.env, process.platform)
if (!nodeBin) {
  check('node is on PATH', false)
  process.exit(1)
}

const scratchRoot = process.env.TMPDIR ?? tmpdir()
type Frame = Record<string, unknown>
type Body = Record<string, unknown>
type Run = { frames: Frame[]; stderr: string; exit: number | null; bodies: Body[]; home: string; cwd: string }

const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}
const lastUserText = (body: Body): string => {
  const messages = (body.messages as Array<{ role?: string; content?: unknown }> | undefined) ?? []
  const last = messages[messages.length - 1]
  if (!last || !Array.isArray(last.content)) return ''
  return (last.content as Array<{ type?: string; text?: string; content?: unknown }>)
    .map(block => (block.type === 'text' ? (block.text ?? '') : block.type === 'tool_result' ? (typeof block.content === 'string' ? block.content : JSON.stringify(block.content)) : ''))
    .join('\n')
}
const toolNamesOf = (body: Body): string[] => ((body.tools as Array<{ name?: string }> | undefined) ?? []).map(t => t.name ?? '')

async function run(label: string, settings: Record<string, unknown>, turns: ScriptedTurn[]): Promise<Run> {
  const home = realpathSync(mkdtempSync(join(scratchRoot, `journal-road-${label}-home-`)))
  const cwd = realpathSync(mkdtempSync(join(scratchRoot, `journal-road-${label}-proj-`)))
  writeFileSync(join(cwd, 'README.md'), '# Lantern\nA throwaway project for the journal proof.\n')
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { mode: 'sovereign' }, ...settings }, null, 2) + '\n')
  const fixture = await startFixtureApi(turns)
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: fixture.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    OPENAI_API_KEY: '',
    MERCURY_THINKING_BINDING: 'drop_block',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    TMPDIR: scratchRoot,
  }
  try {
    return await new Promise<Run>(resolve => {
      const child = spawn(nodeBin!, [DIST, 'run', 'Read README.md and state its first heading.', '--format', 'rows', '--mode', 'sovereign', '--model', 'claude-opus-5', '--max-turns', '2'], { cwd, env })
      const frames: Frame[] = []
      let stdout = ''
      let stderr = ''
      let ended = false
      const finish = (exit: number | null): void => {
        if (ended) return
        ended = true
        clearTimeout(killer)
        for (const line of stdout.split('\n')) {
          const frame = parseFrame(line.trim())
          if (frame !== null) frames.push(frame)
        }
        resolve({ frames, stderr, exit, bodies: fixture.messageRequests().map(r => r.body as Body), home, cwd })
      }
      const killer = setTimeout(() => child.kill('SIGKILL'), 180_000)
      child.stdout.on('data', d => (stdout += String(d)))
      child.stderr.on('data', d => (stderr += String(d)))
      child.on('close', exit => finish(exit))
      child.on('error', () => finish(null))
    })
  } finally {
    await fixture.close()
  }
}

section('§1 the whole road with memory.journal on: a headless run answers, is asked at its end, writes its entry with Journal, and the entry is in the home when the session is gone')
{
  const on = await run('on', { memory: { journal: true } }, [
    { kind: 'text', text: 'The first heading is Lantern.' },
    { kind: 'tool_use', name: 'Journal', input: { entry: ENTRY }, whenBody: 'The session is ending' },
    { kind: 'text', text: NOTE, whenBody: 'journal entry staged' },
  ])
  check('the run completed with its answer', on.exit === 0 && on.frames.some(f => isOutcome(f)), `exit ${on.exit} · ${on.stderr.slice(-300)}`)
  check('three model requests were made: the answer, the closing ask, the note after the tool round', on.bodies.length === 3, String(on.bodies.length))
  const askText = on.bodies[1] ? lastUserText(on.bodies[1]) : ''
  check('the closing ask carries the handoff ask and the journal line', askText.includes('The session is ending') && askText.includes('write a brief entry into the journal with the Journal tool'), askText.slice(0, 300))
  check('the Journal tool is on the wire in full for the closing ask', on.bodies[1] !== undefined && toolNamesOf(on.bodies[1]).includes('Journal'))
  const resultText = on.bodies[2] ? lastUserText(on.bodies[2]) : ''
  check('the tool result says the entry is staged for the session end', resultText.includes('journal entry staged') && resultText.includes('when this session ends'), resultText.slice(0, 300))
  const journals = walk(on.home).filter(p => p.endsWith(`${'journal'}/journal.md`))
  check('one journal file stands in the home under the project records', journals.length === 1 && /\/projects\/[^/]+\/journal\/journal\.md$/.test(journals[0] ?? ''), journals.join(', '))
  const file = journals[0] ? readFileSync(journals[0], 'utf8') : ''
  check('the entry is the model\'s words, under a dated heading from the clock', /^## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n\n/.test(file) && file.includes(ENTRY), file.slice(0, 200))
  const stamp = /^## (\S+)/.exec(file)?.[1] ?? ''
  const stampMs = Date.parse(stamp)
  check('the heading\'s time is now, not a time the model chose', Number.isFinite(stampMs) && Math.abs(Date.now() - stampMs) < 10 * 60_000, stamp)
  check('the journal sits beside the lineage ledger', journals[0] !== undefined && existsSync(join(journals[0], '..', '..', 'lineage', 'ledger.jsonl')))
  const ledger = journals[0] ? readFileSync(join(journals[0], '..', '..', 'lineage', 'ledger.jsonl'), 'utf8') : ''
  check('the note went to the ledger, not the journal, and the entry went to the journal, not the ledger', ledger.includes(NOTE) && !ledger.includes(ENTRY) && !file.includes(NOTE))
  const underProject = walk(on.cwd).map(p => relative(on.cwd, p))
  check('nothing journal-shaped under the project tree', !underProject.some(p => /journal/i.test(p)), underProject.join(', '))
  rmSync(on.home, { recursive: true, force: true })
  rmSync(on.cwd, { recursive: true, force: true })
}

section('§2 nothing set (memory.journal is off by default): no journal line in the closing ask, no Journal tool on the wire, nothing written')
{
  const off = await run('off', {}, [
    { kind: 'text', text: 'The first heading is Lantern.' },
    { kind: 'text', text: NOTE, whenBody: 'The session is ending' },
  ])
  check('the run completed with its answer', off.exit === 0 && off.frames.some(f => isOutcome(f)), `exit ${off.exit} · ${off.stderr.slice(-300)}`)
  check('two model requests were made: the answer and the closing ask', off.bodies.length === 2, String(off.bodies.length))
  const askText = off.bodies[1] ? lastUserText(off.bodies[1]) : ''
  check('the closing ask carries the handoff ask alone', askText.includes('The session is ending') && !askText.includes('into the journal'), askText.slice(0, 300))
  check('no request offered a Journal tool', off.bodies.every(body => !toolNamesOf(body).includes('Journal')))
  check('no journal file anywhere in the home', !walk(off.home).some(p => p.endsWith('journal.md')))
  rmSync(off.home, { recursive: true, force: true })
  rmSync(off.cwd, { recursive: true, force: true })
}

console.log(`\nprove-journal-road: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
