#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { BrowserTool, ROOT, check, finish, requireBrowser, section, serve, validate } from './harness.ts'

await requireBrowser()

const DIST = process.env.PROVE_DIST ?? join(ROOT, 'dist')
const NODE = join(DIST, 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
const { repairToolInput } = (await import(join(ROOT, 'src/services/providers/toolCallGate.ts'))) as { repairToolInput: (tool: unknown, input: Record<string, unknown>) => Record<string, unknown> }

const A = await serve(0, (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`<!doctype html><title>form</title><input id="one" type="file"><p id="facts"></p>
<script>const one = document.getElementById('one'); const say = () => { document.getElementById('facts').textContent = 'the input holds ' + one.files.length }; one.addEventListener('change', say); say()</script>`)
})

type Call = Record<string, unknown> & { op: string }
async function throughTheBundle(calls: Call[]): Promise<{ code: number | null; answers: string[]; sent: string[]; noise: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'browser-upload-clear-')))
  const home = join(root, 'home')
  const config = join(home, '.mercury')
  const project = join(root, 'project')
  for (const folder of [join(config, 'tmp'), project]) mkdirSync(folder, { recursive: true })
  writeFileSync(join(project, 'a.txt'), 'alpha file')
  process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
  seedFirstRun(config, [project])
  const fixture = await startFixtureApi([...calls.map(input => ({ kind: 'tool_use' as const, name: 'Browser', input })), { kind: 'text' as const, text: 'Done.' }])
  try {
    const env = {
      PATH: [dirname(NODE), ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin'])].join(delimiter),
      HOME: home,
      USERPROFILE: home,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: config,
      MERCURY_TMPDIR: join(config, 'tmp'),
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_BROWSER_CACHE_DIR: process.env.MERCURY_BROWSER_CACHE_DIR ?? '',
      MERCURY_BROWSER_NO_DISCOVERY: '1',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: fixture.url,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    }
    const child = spawn(NODE, [join(DIST, 'mercury.mjs'), '--sovereign', 'run', '--model', 'claude-opus-4-8', '--format', 'json', 'Drive the browser.'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let noise = ''
    child.stdout.on('data', chunk => {
      noise += String(chunk)
    })
    child.stderr.on('data', chunk => {
      noise += String(chunk)
    })
    const code = await new Promise<number | null>(settle => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 150_000)
      child.once('close', status => {
        clearTimeout(timer)
        settle(status)
      })
    })
    const requests = fixture.messageRequests() as Array<{ body: { messages?: Array<{ role: string; content: unknown }> } }>
    const textOf = (content: unknown): string =>
      typeof content === 'string' ? content : Array.isArray(content) ? content.map(block => (block !== null && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : '')).join('') : ''
    const answers: string[] = []
    const sent: string[] = []
    for (const request of requests) {
      const messages = request.body.messages ?? []
      const last = messages.at(-1)
      const result = (Array.isArray(last?.content) ? (last!.content as Array<{ type?: string; content?: unknown }>) : []).find(block => block.type === 'tool_result')
      if (result === undefined) continue
      answers.push(textOf(result.content))
      const asked = messages.at(-2)
      const use = (Array.isArray(asked?.content) ? (asked!.content as Array<{ type?: string; input?: unknown }>) : []).find(block => block.type === 'tool_use')
      sent.push(JSON.stringify(use?.input ?? null))
    }
    return { code, answers, sent, noise }
  } finally {
    await fixture.close()
    rmSync(root, { recursive: true, force: true })
  }
}

section('S0 what the road to the tool keeps of a call')
{
  const kept = repairToolInput(BrowserTool, { op: 'upload', selector: '#one', files: [] })
  check('an empty files list reaches the Browser tool as the list it is', Array.isArray(kept.files) && (kept.files as unknown[]).length === 0, JSON.stringify(kept))
  const others = repairToolInput(BrowserTool, { op: 'press', key: 'Tab', modifiers: [], values: [], text: '', selector: '' })
  check('the other empty placeholders of a call are still taken out: modifiers, values, text, selector (holds on the parent too)', JSON.stringify(others) === '{"op":"press","key":"Tab"}', JSON.stringify(others))
  const stray = await validate({ op: 'click', selector: '#one', files: [] })
  check('an empty files list beside another operation refuses nothing (holds on the parent too)', stray.ok, stray.message)
  const absent = await validate({ op: 'upload', selector: '#one' })
  check('no files at all is refused in the tool’s own sentence (holds on the parent too)', !absent.ok && absent.message === 'upload requires selector and files (an empty list clears a file input)', absent.message)
}

section('S1 a model’s call through the bundle: a scripted provider, the tool loop, a real page')
if (!existsSync(join(DIST, 'mercury.mjs')) || !existsSync(NODE)) {
  check('the built bundle is there to drive', false, `${join(DIST, 'mercury.mjs')} or its node is missing — run bun run build.ts first`)
} else {
  const ran = await throughTheBundle([
    { op: 'open', url: `${A.origin}/` },
    { op: 'upload', selector: '#one', files: ['a.txt'] },
    { op: 'upload', selector: '#one', files: [] },
    { op: 'extract', selector: '#facts' },
    { op: 'upload', selector: '#one', files: [] },
    { op: 'upload', selector: '#one' },
    { op: 'close' },
  ])
  const [opened, held, cleared, facts, again, absent, closed] = ran.answers
  check('the run ends with every call answered', ran.code === 0 && ran.answers.length === 7 && (closed ?? '').startsWith('session closed'), `exit ${ran.code}, ${ran.answers.length} answers ${ran.noise.slice(-600)}`)
  check('the provider sent the call with its empty list', ran.sent[2] === '{"op":"upload","selector":"#one","files":[]}', String(ran.sent[2]))
  check('control: a file is set on the input (holds on the parent too)', (opened ?? '').includes('[200]') && (held ?? '').startsWith(`upload: #one holds 1 file — a.txt (10 bytes, text/plain) at ${A.origin}/`), `${opened} | ${held}`)
  check('[M02] an empty list clears the input that held one file, and the answer says what it held', cleared === `upload: #one cleared at ${A.origin}/ (it held 1 file)`, String(cleared))
  check('the page’s input then holds nothing', (facts ?? '').includes('the input holds 0'), String(facts))
  check('an empty list on an input that holds nothing clears it too and says so', again === `upload: #one cleared at ${A.origin}/ (it held no file)`, String(again))
  check('a call with no files at all is still refused (holds on the parent too)', (absent ?? '').includes('upload requires selector and files (an empty list clears a file input)'), String(absent))
}

await finish('prove-browser-upload-clear')
