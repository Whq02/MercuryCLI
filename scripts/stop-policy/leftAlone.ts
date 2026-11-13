import { spawn } from 'node:child_process'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootRunner, bound, childEnv, DIST, isOutcome, NODE, seedHome } from '../daemon/dupline-world.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { HANDOFF_ASK_MARK } from '../lib/fixtureApi.ts'
import { frameLines, lastOutcome, type Frame } from '../lib/rows.ts'

type WireStep = { write: string } | { wait: number } | { end: true } | { destroy: true } | { hold: true }
export type WireAnswer = { json: unknown } | { steps: WireStep[] }
export type Asked = { n: number; streamed: boolean; body: Record<string, unknown>; tail: string; opening: string; at: number }
type Wire = { url: string; port: number; asked: Asked[]; close(): Promise<void> }
type Script = (asked: Asked) => WireAnswer

type Block = { type?: string; text?: string }
type Item = { role?: string; content?: unknown }

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const REPLY_MODEL = 'claude-opus-4-8'

export const sse = {
  start: (n: number): string =>
    frame('message_start', { type: 'message_start', message: { id: `msg_alone_${n}`, type: 'message', role: 'assistant', model: REPLY_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } }),
  text: (index: number, text: string): string =>
    frame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }) +
    frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }) +
    frame('content_block_stop', { type: 'content_block_stop', index }),
  tool: (index: number, id: string, name: string, input: Record<string, unknown>): string =>
    frame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } }) +
    frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }) +
    frame('content_block_stop', { type: 'content_block_stop', index }),
  end: (stop: string): string =>
    frame('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 12 } }) + frame('message_stop', { type: 'message_stop' }),
}

export function say(asked: Asked, text: string): WireAnswer {
  if (!asked.streamed) return { json: { id: `msg_alone_${asked.n}`, type: 'message', role: 'assistant', model: REPLY_MODEL, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 25, output_tokens: 12 } } }
  return { steps: [{ write: sse.start(asked.n) + sse.text(0, text) + sse.end('end_turn') }, { end: true }] }
}

export function call(asked: Asked, name: string, input: Record<string, unknown>): WireAnswer {
  const id = `toolu_alone_${asked.n}`
  if (!asked.streamed) return { json: { id: `msg_alone_${asked.n}`, type: 'message', role: 'assistant', model: REPLY_MODEL, content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 25, output_tokens: 12 } } }
  return { steps: [{ write: sse.start(asked.n) + sse.tool(0, id, name, input) + sse.end('tool_use') }, { end: true }] }
}

export const mark = (label: string): Record<string, unknown> => ({ command: `echo ${label} >> marks.txt`, description: label })

function plainTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return (content as Block[]).flatMap(block => (block.type === 'text' && typeof block.text === 'string' && !block.text.trimStart().startsWith('<system-reminder>') ? [block.text] : []))
}

function carriesResult(item: Item): boolean {
  return Array.isArray(item.content) && (item.content as Block[]).some(block => block.type === 'tool_result')
}

async function startWire(script: Script): Promise<Wire> {
  const asked: Asked[] = []
  const open = new Set<ServerResponse>()
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      const raw = Buffer.concat(chunks).toString('utf8')
      if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(url.endsWith('/count_tokens') ? JSON.stringify({ input_tokens: Math.ceil(raw.length / 4) }) : '{}')
        return
      }
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        body = {}
      }
      const items = Array.isArray(body.messages) ? (body.messages as Item[]) : []
      const users = items.filter(item => item.role === 'user')
      const last = items.at(-1)
      const turn: Asked = {
        n: asked.length + 1,
        streamed: body.stream === true,
        body,
        tail: last !== undefined && last.role === 'user' && !carriesResult(last) ? plainTexts(last.content).join('\n') : '',
        opening: users.map(item => plainTexts(item.content).join('\n')).find(text => text.trim() !== '') ?? '',
        at: Date.now(),
      }
      let answer: WireAnswer
      if (raw.includes(HANDOFF_ASK_MARK)) answer = say({ ...turn, n: 0 }, 'The note for the next session.')
      else {
        asked.push(turn)
        try {
          answer = script(turn)
        } catch (error) {
          answer = say(turn, `the script failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if ('json' in answer) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(answer.json))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.flushHeaders()
      open.add(res)
      res.on('close', () => open.delete(res))
      const steps = [...answer.steps]
      const next = (): void => {
        const step = steps.shift()
        if (step === undefined || res.destroyed || 'hold' in step) return
        if ('write' in step) {
          res.write(step.write)
          next()
        } else if ('wait' in step) setTimeout(next, step.wait)
        else if ('end' in step) res.end()
        else req.socket.destroy()
      }
      next()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    asked,
    close: async () => {
      for (const res of open) res.destroy()
      open.clear()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

export type Ran = { code: number | null; outcome: Frame | undefined; rows: Frame[]; asked: Asked[]; marks: string[]; stderr: string }

const marksOf = (cwd: string): string[] => {
  const file = join(cwd, 'marks.txt')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(line => line !== '') : []
}

export async function oneShot(world: string, name: string, task: string, script: Script, options: { env?: Record<string, string>; flags?: string[] } = {}): Promise<Ran> {
  const home = join(world, name, 'home')
  const cwd = join(world, name, 'project')
  mkdirSync(join(home, 'tmp'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'calc.py'), 'def add(a, b):\n    return a + b\n')
  seedFirstRun(home, [cwd])
  const wire = await startWire(script)
  const child = spawn(NODE, [DIST, 'run', '--mode', 'sovereign', '--model', 'claude-sonnet-5', '--format', 'rows', ...(options.flags ?? []), '--', task], {
    cwd,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? '',
      TMPDIR: join(home, 'tmp'),
      MERCURY_TMPDIR: join(home, 'tmp'),
      MERCURY_CONFIG_DIR: home,
      MERCURY_HOME: home,
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
      ANTHROPIC_BASE_URL: wire.url,
      ...(options.env ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout += String(chunk)
  })
  child.stderr.on('data', chunk => {
    stderr += String(chunk)
  })
  const guard = setTimeout(() => child.kill('SIGKILL'), bound(120_000))
  const code = await new Promise<number | null>(done => child.once('close', exit => done(exit)))
  clearTimeout(guard)
  await wire.close()
  const rows = frameLines(stdout)
  return { code, outcome: lastOutcome(rows), rows, asked: wire.asked, marks: marksOf(cwd), stderr }
}

export async function hosted(world: string, name: string, task: string, script: Script, env: Record<string, string> = {}): Promise<Ran> {
  const home = join(world, name, 'home')
  const cwd = join(home, 'project')
  seedHome(home, cwd)
  const wire = await startWire(script)
  const runner = bootRunner({ cwd, env: { ...childEnv(home, wire.port), ...env } })
  void runner.prompt(task)
  const outcome = await runner.waitFor('the outcome', isOutcome, bound(120_000))
  await runner.stop(bound(8_000))
  await wire.close()
  return { code: await runner.exited, outcome: outcome ?? undefined, rows: runner.frames, asked: wire.asked, marks: marksOf(cwd), stderr: runner.stderr() }
}

export const noticesOf = (ran: Ran): string[] => ((ran.outcome?.notices as Array<{ text?: string }> | undefined) ?? []).map(notice => String(notice.text ?? ''))
export const recoveriesOf = (ran: Ran): string[] | undefined => (ran.outcome?.recoveries as Array<{ kind?: string }> | undefined)?.map(entry => String(entry.kind ?? ''))
