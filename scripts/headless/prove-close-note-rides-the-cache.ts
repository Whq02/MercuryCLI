#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, handoffTurn, isHandoffRequest, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }

const home = realpathSync(mkdtempSync(join(tmpdir(), 'close-note-cache-')))
seedFirstRun(home, [home])
const cwd = join(home, 'project')
mkdirSync(cwd, { recursive: true })
const answer: ScriptedTurn = { kind: 'text', text: 'DONE', usage: { input_tokens: 100, output_tokens: 10 } }
const close: ScriptedTurn = { ...handoffTurn('The note for the next session.'), usage: { input_tokens: 120, output_tokens: 12 } }
const api = await startFixtureApi([answer, close])
const child = spawn('node', [dist, 'run', '--format', 'rows', 'reply with exactly DONE'], {
  cwd,
  env: { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_HOME: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: api.url },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = '', err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000)
try {
  const code = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
  const requests = api.messageRequests()
  const closeAt = requests.findIndex(r => isHandoffRequest(r as never))
  const rows = out.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(r => r !== null) as Array<Record<string, unknown>>
  const closeRow = rows.find(r => r.type === 'close') as { state?: string; note_chars?: number } | undefined
  check('the run completed (exit 0)', code === 0, JSON.stringify({ code, err: err.slice(0, 300) }))
  check('the close ask fired after the answer', closeAt >= 1, `${closeAt} of ${requests.length} requests`)
  if (closeAt >= 1) {
    const parent = requests[closeAt - 1]!.body as { system?: unknown; tools?: unknown[]; messages?: unknown[] }
    const note = requests[closeAt]!.body as { system?: unknown; tools?: unknown[]; messages?: unknown[] }
    const parentTools = JSON.stringify(parent.tools ?? null)
    const noteTools = JSON.stringify(note.tools ?? null)
    check('the close-note request carries the tools array the answer rode, byte for byte (the cached prefix every provider keys on)', noteTools === parentTools && (note.tools?.length ?? 0) > 0, `${(note.tools ?? []).length} vs ${(parent.tools ?? []).length} tools`)
    check('the close-note request carries the same system prompt', JSON.stringify(note.system) === JSON.stringify(parent.system))
    const parentMessages = JSON.stringify(parent.messages ?? [])
    const noteMessages = JSON.stringify(note.messages ?? [])
    check('the close-note request continues the conversation: the answer request\'s messages are its prefix', noteMessages.startsWith(parentMessages.slice(0, -1)), `${(note.messages ?? []).length} vs ${(parent.messages ?? []).length} messages`)
    const last = (note.messages ?? []).at(-1) as { role?: string; content?: unknown } | undefined
    check('and adds only the answer and the one-line ask', last?.role === 'user' && JSON.stringify(last.content).includes('Leave one note for the next session') && (note.messages?.length ?? 0) === (parent.messages?.length ?? 0) + 2, JSON.stringify(last).slice(0, 200))
  }
  check('the note is written', closeRow?.state === 'stored' && (closeRow.note_chars ?? 0) > 0, JSON.stringify(closeRow))
} finally {
  clearTimeout(timeout)
  await api.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(failures === 0 ? 'CLOSE NOTE RIDES THE CACHE: ALL PASS' : `close note rides the cache: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
