#!/usr/bin/env bun
// gate-watch: src/tools/MemoryTools/MemoryTools.ts src/memdir/mnemeMaintenance.ts src/memdir/mnemeConsolidate.ts
// gate-watch: src/memdir/memoryVerbs.ts src/memdir/mnemeFrontPage.ts src/constants/prompts.ts
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findOnPath } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const RULE = 'end every reply with the word Fairwinds'
const TELL = `Please remember this as a standing rule for every future chat here: ${RULE}. Confirm in one line.`
const ASK = 'What is 12 times 12? One sentence.'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

if (!existsSync(DIST)) {
  check('dist/mercury.mjs exists (build first — this proof drives the artifact)', false)
  console.log('\n❌ PINNED AT ONCE: no dist to drive')
  process.exit(1)
}
const nodeBin = findOnPath('node', process.env, process.platform)
if (!nodeBin) {
  check('node is on PATH', false)
  process.exit(1)
}

const scratchRoot = process.env.TMPDIR ?? tmpdir()
const home = realpathSync(mkdtempSync(join(scratchRoot, 'pinned-at-once-home-')))
const cwd = realpathSync(mkdtempSync(join(scratchRoot, 'pinned-at-once-proj-')))
writeFileSync(join(cwd, 'README.md'), '# Lantern\nA throwaway project for the memory proof.\n')
seedFirstRun(home, [cwd])
writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { mode: 'sovereign' } }, null, 2) + '\n')

type Frame = Record<string, unknown>
type Body = Record<string, unknown>
type Run = { frames: Frame[]; stderr: string; exit: number | null; bodies: Body[] }

async function chat(prompt: string, turns: ScriptedTurn[]): Promise<Run> {
  const fixture = await startFixtureApi(turns)
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREWS_DIR: join(home, 'crews'),
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
      const child = spawn(nodeBin!, [DIST, 'run', '--input', 'rows', '--format', 'rows', '--mode', 'sovereign', '--model', 'claude-opus-5'], { cwd, env })
      const frames: Frame[] = []
      let stdout = ''
      let stderr = ''
      let consumed = 0
      let ended = false
      const finish = (exit: number | null): void => {
        if (ended) return
        ended = true
        clearTimeout(killer)
        resolve({ frames, stderr, exit, bodies: fixture.messageRequests().map(r => r.body as Body) })
      }
      const killer = setTimeout(() => child.kill('SIGKILL'), 180_000)
      child.stdout.on('data', d => {
        stdout += String(d)
        const parts = stdout.split('\n')
        for (; consumed < parts.length - 1; consumed++) {
          const line = parts[consumed]!.trim()
          if (line === '') continue
          try {
            const frame = JSON.parse(line) as Frame
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
  } finally {
    await fixture.close()
  }
}

const systemTextOf = (body: Body): string => (Array.isArray(body.system) ? (body.system as Array<{ text?: string }>).map(s => s.text ?? '').join('\n') : String(body.system ?? ''))
const toolResultsOf = (body: Body): string[] => {
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
const resultText = (run: Run): string => run.frames.filter(f => f.type === 'result').map(f => String((f as { result?: unknown }).result ?? '')).join('\n')
const libraryOf = (): string | null => {
  const projects = join(home, 'projects')
  if (!existsSync(projects)) return null
  const walk = (dir: string): string | null => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (name === 'library' && existsSync(join(p, 'pins.json'))) return p
      if (statSync(p).isDirectory()) {
        const hit = walk(p)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(projects)
}

try {
  section('§1 the chat that asks: the model pins the rule as said, with every optional field filled, and the shelf has it before the reply')
  const tell = await chat(TELL, [
    { kind: 'tool_use', name: 'Retain', input: { items: [{ content: RULE, context: '', topic: '', pin: true, replaces: '' }] }, whenBody: 'standing rule' },
    { kind: 'text', text: 'Saved as a standing rule. Fairwinds', whenBody: 'stored' },
  ])
  check('the chat ended on its own', tell.exit === 0 && tell.frames.some(f => f.type === 'result'), `exit=${tell.exit} frames=${tell.frames.length} stderr=${tell.stderr.slice(-300)}`)
  check("the first request's shelf is empty (nothing pinned yet)", tell.bodies.length >= 1 && systemTextOf(tell.bodies[0] ?? {}).includes('no pinned rules'), systemTextOf(tell.bodies[0] ?? {}).slice(0, 200))
  const results = tell.bodies.flatMap(toolResultsOf)
  const retainResult = results.find(r => r.includes('stored'))
  check('the Retain with pin: true and "" in every other optional field stored the rule (nothing refused)', retainResult !== undefined && retainResult.startsWith('1 stored · 0 refused'), results.join(' | ') || 'no tool result reached the model')
  check('the tool result tells the model the pinned rule is on the shelf now', retainResult !== undefined && retainResult.includes('the pinned rule is on the shelf now'), retainResult ?? '')
  const lib = libraryOf()
  const pinsOf = (dir: string): Array<{ seq: number; asked?: boolean }> => (JSON.parse(readFileSync(join(dir, 'pins.json'), 'utf8')) as { pins?: Array<{ seq: number; asked?: boolean }> }).pins ?? []
  const frontPageOf = (dir: string): string => (existsSync(join(dir, 'front-page.md')) ? readFileSync(join(dir, 'front-page.md'), 'utf8') : '')
  check('the library has the rule pinned with the asked mark, on a page, with the front page republished', lib !== null && pinsOf(lib).some(p => p.asked === true) && frontPageOf(lib).includes(`- ${RULE} <seq=`) && frontPageOf(lib).includes('asked for by the user'), lib ? `pins=${JSON.stringify(pinsOf(lib))} page=${frontPageOf(lib).slice(frontPageOf(lib).indexOf('## Pinned'), frontPageOf(lib).indexOf('## Pinned') + 240)}` : 'no library with pins.json under the home')
  check('the buffer holds no pending row — the rule did not wait for a maintenance pass', lib !== null && (!existsSync(join(lib, 'current.jsonl')) || readFileSync(join(lib, 'current.jsonl'), 'utf8').trim() === ''))
  check('the reply reached the user', resultText(tell).includes('Saved as a standing rule'), resultText(tell).slice(0, 200))

  section('§2 a fresh chat, nothing said about memory: its first request carries the rule on the shelf, word for word, marked')
  const fresh = await chat(ASK, [{ kind: 'text', text: '12 times 12 is 144. Fairwinds', whenBody: '12 times 12' }])
  check('the fresh chat ended on its own', fresh.exit === 0 && fresh.frames.some(f => f.type === 'result'), `exit=${fresh.exit} stderr=${fresh.stderr.slice(-300)}`)
  const freshSystem = systemTextOf(fresh.bodies[0] ?? {})
  const pinned = freshSystem.slice(freshSystem.indexOf('## Pinned'))
  check("the first request's system prompt carries the pinned shelf with the rule, word for word, asked for by the user", freshSystem.includes('## Pinned') && /^- end every reply with the word Fairwinds <seq=\d+, asked for by the user>$/m.test(pinned), pinned.slice(0, 400) || freshSystem.slice(0, 300))
  check('the shelf tells the model to follow it word for word and never reword a rule marked asked for', pinned.includes('follow them word for word') && pinned.includes('never reworded, merged or dropped'))
  check('the rule rides the prompt, not a relevant_memories attachment', !JSON.stringify(fresh.bodies[0] ?? {}).includes('relevant_memories'))
  check('the calm over-limit line is in no request body and no output row', ![...tell.bodies, ...fresh.bodies].some(b => JSON.stringify(b).includes('Pinned memory:')) && ![...tell.frames, ...fresh.frames].some(f => JSON.stringify(f).includes('Pinned memory:')))
} finally {
  if (process.env.KEEP !== '1') {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  } else {
    console.log(`\n[kept: home ${home} project ${cwd}]`)
  }
}

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ A PINNED RULE REACHES THE NEXT CHAT AT ONCE' : `❌ ${failures} PINNED-AT-ONCE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
