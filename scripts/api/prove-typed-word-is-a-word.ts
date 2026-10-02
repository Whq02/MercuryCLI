#!/usr/bin/env bun
// gate-watch: src/utils/attachments/modeLifecycles.ts src/utils/attachments/orchestrator.ts
// gate-watch: src/utils/messages/attachmentText.ts src/utils/thinking.ts src/utils/effort.ts
// gate-watch: src/tools/WorkflowTool/workflowPrompt.ts src/run-core/attachment-drain.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'typed-word-pure-'))
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL

import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_BUNDLE ?? join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const CONTROL = 'plainword'
const WORDS = ['deepthink', 'supercode', 'ultrathink', 'ultracode', 'ultraplan', 'think harder']
const PHRASE = 'then answer with the number seven'
const promptFor = (word: string): string => `please ${word} ${PHRASE}`

type Body = Record<string, unknown>

function stripVolatile(body: Body): Body {
  const out: Body = { ...body }
  delete out.metadata
  return out
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const steady = (text: string): string => text.replace(/cc_version=[^;"\\]*/g, 'cc_version=*').replace(UUID, '<session>')

function normalised(body: Body, word: string): string {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const { messages, ...rest } = stripVolatile(body)
  const turn = steady(JSON.stringify(messages)).replace(new RegExp(escaped, 'gi'), CONTROL)
  return `${steady(JSON.stringify(rest))}\n${turn}`
}

function userTexts(body: Body): string[] {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []
  const texts: string[] = []
  for (const m of messages) {
    if (m.role !== 'user') continue
    const content = m.content
    if (typeof content === 'string') texts.push(content)
    else if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      }
    }
  }
  return texts
}

console.log('============================================================')
console.log(' a typed word is a word — the request the model receives')
console.log('============================================================')
console.log(`  bundle: ${DIST}`)

if (!existsSync(DIST)) {
  check('the bundle is built (bun run build.ts; MERCURY_PROOF_BUNDLE points elsewhere)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    const turns: ScriptedTurn[] = Array.from({ length: 40 }, () => ({ kind: 'text', text: 'seven' }))
    const fixture = await startFixtureApi(turns)
    const home = mkdtempSync(join(tmpdir(), 'typed-word-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'typed-word-cwd-'))
    mkdirSync(join(home, 'config'), { recursive: true })
    const env: Record<string, string> = {
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, 'config'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_CREWS_DIR: join(home, 'crews'),
      MERCURY_DAP: '0',
    }
    const run = (args: string[]): Promise<{ exit: number | null; stdout: string; stderr: string }> =>
      new Promise(resolvePromise => {
        const child = spawn(nodeBin, [DIST, ...args], { cwd, env })
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
    const common = ['--model', 'claude-opus-4-8', '--format', 'text']

    async function mainRequestFor(word: string): Promise<Body | null> {
      const before = fixture.messageRequests().length
      const r = await run(['run', promptFor(word), ...common])
      check(`"${word}": the turn runs and the fixture answers`, r.exit === 0 && r.stdout.includes('seven'), `exit=${r.exit} stderr=${r.stderr.slice(0, 300)}`)
      const fresh = fixture.messageRequests().slice(before)
      const main = fresh.find(req => {
        const body = req.body as Body
        return body.model === 'claude-opus-4-8' && JSON.stringify(body).includes(PHRASE)
      })
      check(`"${word}": one main request carries the prompt`, main !== undefined, `${fresh.length} fresh requests`)
      return main ? (main.body as Body) : null
    }

    const control = await mainRequestFor(CONTROL)
    const controlAgain = await mainRequestFor(CONTROL)
    if (control && controlAgain) {
      check('two runs of the control prompt send the same request (the comparison is sound)', normalised(control, CONTROL) === normalised(controlAgain, CONTROL))
    }
    if (control) {
      const systemText = JSON.stringify(control.system ?? '').toLowerCase()
      const carried = WORDS.filter(word => systemText.includes(word.toLowerCase()))
      check('the system prompt of the control request names none of the typed words (the words are no lever by Mercury\'s own instruction either)', carried.length === 0, `the system block carries: ${carried.join(', ')}`)
    }
    for (const word of WORDS) {
      const body = await mainRequestFor(word)
      if (!control || !body) continue
      const same = normalised(body, word) === normalised(control, CONTROL)
      check(`"${word}" changes nothing in the request but the letters of the word`, same, (() => {
        const a = normalised(body, word)
        const b = normalised(control, CONTROL)
        let i = 0
        while (i < a.length && i < b.length && a[i] === b[i]) i++
        return `first difference at ${i}: …${a.slice(Math.max(0, i - 80), i + 200)}…`
      })())
      const texts = userTexts(body)
      check(`"${word}" rides the user text as plain words`, texts.some(t => t.includes(promptFor(word))))
      const carrying = texts.filter(t => t.toLowerCase().includes(word.toLowerCase()))
      check(`"${word}" appears in the user turn once — the prompt — and in no reminder`, carrying.length === 1, `${carrying.length} texts carry it: ${carrying.map(t => t.slice(0, 120)).join(' | ')}`)
      const systemOf = (b: Body): string => steady(JSON.stringify(b.system))
      check(`"${word}": the system prompt and the tools are the control's`, systemOf(body) === systemOf(control) && JSON.stringify(body.tools) === JSON.stringify(control.tools))
      check(`"${word}": the thinking and effort fields are the control's`, JSON.stringify(body.thinking) === JSON.stringify(control.thinking) && JSON.stringify(body.output_config) === JSON.stringify(control.output_config))
    }
    await fixture.close()
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ TYPED WORD IS A WORD GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ TYPED WORD IS A WORD: ${failures} FAILED of ${checks}`)
process.exit(1)
