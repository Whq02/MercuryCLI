import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { frameLines, isOutcome } from '../lib/rows.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'
import { caretEscape } from '../../src/utils/caretEscape.ts'

const tally = makeTally('prove-text-format-caret-escapes')
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'text-format-caret-')))
const home = join(root, 'home')
const cwd = join(root, 'work')
seedScratchHome(home, cwd)

const MODEL = 'qwen2.5-coder:3b'
const ASK = 'Say something.'
const TITLE = '\x1b]0;PWNED-TITLE\x07'
const CLIPBOARD = '\x1b]52;c;SGVsbG8=\x07'
const CLEAR = '\x1b[2J'
const C1_CSI = '\x9b'
const ARABIC = 'مرحبا بالعالم'
const EMOJI = '🚀✨'
const ANSWER = `A${TITLE}B${CLIPBOARD}C${CLEAR}D\rE\x08F${C1_CSI}G\x7fH\x00I\ttab\nline two ${ARABIC} ${EMOJI} end`
const RAW_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/

type ChatBody = { messages?: Array<{ role?: string; content?: unknown }>; tools?: unknown[] }
type Answer = string[]
const row = (fields: Record<string, unknown>): string => `${JSON.stringify({ model: MODEL, created_at: '2026-10-27T10:00:00.000000Z', ...fields })}\n`
const content = (text: string): string => row({ message: { role: 'assistant', content: text }, done: false })
const done = (): string => row({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', total_duration: 900_000_000, load_duration: 50_000_000, prompt_eval_count: 420, prompt_eval_duration: 300_000_000, eval_count: 24, eval_duration: 500_000_000 })
const reply = (text: string): Answer => [content(text), done()]

let script: Answer[] = []
const json = (res: ServerResponse, body: unknown): void => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const ollama = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = ''
  req.on('data', chunk => {
    body += String(chunk)
  })
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (url === '/api/tags') return json(res, { models: [{ name: MODEL, model: MODEL, modified_at: '2026-10-01T00:00:00Z', size: 1_900_000_000, digest: 'f'.repeat(64), details: { family: 'qwen2', families: ['qwen2'], parameter_size: '3.1B', quantization_level: 'Q4_K_M' } }] })
    if (url === '/api/version') return json(res, { version: '0.34.4' })
    if (url === '/api/ps') return json(res, { models: [] })
    if (url === '/api/show') return json(res, { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32_768 }, parameters: '', details: { family: 'qwen2', parameter_size: '3.1B', quantization_level: 'Q4_K_M' } })
    if (url === '/api/chat' && req.method === 'POST') {
      void (body as ChatBody)
      const answer = script.shift()
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end((answer ?? reply('script exhausted')).join(''))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
})
const base: string = await new Promise(resolve => {
  ollama.listen(0, '127.0.0.1', () => {
    const address = ollama.address()
    resolve(`http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`)
  })
})
const port = Number(new URL(base).port)
const env = { ...childEnv(home, port), MERCURY_LOCAL_PROBE_TARGETS: `ollama=${base}`, MERCURY_LOCAL_BASE_URL: base }

type Run = { stdout: Buffer; stderr: string; code: number | null }
function run(answers: Answer[], format: 'text' | 'rows' | 'json'): Promise<Run> {
  script = [...answers]
  return new Promise(resolve => {
    const child = spawn(NODE, [DIST, 'run', '--model', `local/${MODEL}`, '--ephemeral', '--mode', 'implement', '--format', format, ASK], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), bound(120_000))
    child.stdout.on('data', chunk => { out.push(Buffer.from(chunk)) })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('close', code => { clearTimeout(timer); resolve({ stdout: Buffer.concat(out), stderr, code }) })
    child.on('error', error => { clearTimeout(timer); resolve({ stdout: Buffer.concat(out), stderr: String(error), code: null }) })
  })
}
const hex = (bytes: Buffer): string => bytes.toString('hex')

try {
  console.log(`build under proof: ${DIST}`)
  tally.section('1 · the escape itself: every control character becomes its caret form, nothing is dropped')
  {
    tally.check('ESC → ^[', caretEscape('\x1b') === '^[', JSON.stringify(caretEscape('\x1b')))
    tally.check('BEL → ^G', caretEscape('\x07') === '^G')
    tally.check('CR → ^M', caretEscape('\r') === '^M')
    tally.check('BS → ^H', caretEscape('\x08') === '^H')
    tally.check('NUL → ^@', caretEscape('\x00') === '^@')
    tally.check('DEL → ^?', caretEscape('\x7f') === '^?')
    tally.check('C1 CSI (U+009B) → ^[[ (ESC plus its 7-bit equivalent)', caretEscape('\x9b') === '^[[', JSON.stringify(caretEscape('\x9b')))
    tally.check('C1 OSC (U+009D) → ^[]', caretEscape('\x9d') === '^[]')
    tally.check('the window-title sequence reads as ^[]0;PWNED-TITLE^G', caretEscape(TITLE) === '^[]0;PWNED-TITLE^G', JSON.stringify(caretEscape(TITLE)))
    tally.check('the clipboard write reads as ^[]52;c;SGVsbG8=^G', caretEscape(CLIPBOARD) === '^[]52;c;SGVsbG8=^G')
    tally.check('the clear sequence reads as ^[[2J', caretEscape(CLEAR) === '^[[2J')
    tally.check('newline and tab survive', caretEscape('a\tb\nc') === 'a\tb\nc')
    tally.check('Arabic and emoji are byte-identical', caretEscape(`${ARABIC} ${EMOJI}`) === `${ARABIC} ${EMOJI}`)
    tally.check('plain ASCII is untouched (a literal caret included)', caretEscape('x^y ~ `q`') === 'x^y ~ `q`')
    tally.check('the escaped answer carries no raw control character', !RAW_CONTROL.test(caretEscape(ANSWER)), JSON.stringify(caretEscape(ANSWER)))
    tally.check('the escape is total: every character of the answer is still accounted for', caretEscape(ANSWER).length > ANSWER.length && caretEscape(ANSWER).endsWith(`line two ${ARABIC} ${EMOJI} end`))
  }

  tally.section('2 · --format text: the bytes on stdout are printable')
  {
    const spent = await run([reply(ANSWER)], 'text')
    const text = spent.stdout.toString('utf8')
    tally.check('the run completed with exit 0', spent.code === 0, JSON.stringify({ code: spent.code, stderr: spent.stderr.slice(-400) }))
    tally.check('no raw C0 (other than newline and tab), DEL or C1 character reaches stdout', !RAW_CONTROL.test(text), hex(spent.stdout))
    tally.check('no ESC byte (0x1b) on stdout', !spent.stdout.includes(0x1b), hex(spent.stdout))
    tally.check('no BEL byte (0x07) on stdout', !spent.stdout.includes(0x07))
    tally.check('no raw U+009B (c2 9b) on stdout', !hex(spent.stdout).includes('c29b'))
    tally.check('the window title sequence is shown as ^[]0;PWNED-TITLE^G', text.includes('A^[]0;PWNED-TITLE^GB'), JSON.stringify(text))
    tally.check('the clipboard write is shown as ^[]52;c;SGVsbG8=^G', text.includes('B^[]52;c;SGVsbG8=^GC'))
    tally.check('the clear sequence is shown as ^[[2J', text.includes('C^[[2JD'))
    tally.check('CR, BS, the C1 CSI, DEL and NUL are shown as ^M ^H ^[[ ^? ^@', text.includes('D^ME^HF^[[G^?H^@I'), JSON.stringify(text))
    tally.check('the tab survives', text.includes('I\ttab'))
    tally.check('the newline survives and the answer ends with one', text.includes('tab\nline two') && text.endsWith('end\n'))
    tally.check('the Arabic and emoji bytes are byte-identical', spent.stdout.includes(Buffer.from(`${ARABIC} ${EMOJI}`, 'utf8')), hex(spent.stdout))
    tally.check('stdout is exactly the escaped answer plus one newline', text === `${caretEscape(ANSWER)}\n`, JSON.stringify(text))
  }

  tally.section('3 · --format rows and --format json carry the answer unchanged')
  {
    const rows = await run([reply(ANSWER)], 'rows')
    const outcome = frameLines(rows.stdout.toString('utf8')).find(isOutcome) as { answer?: string } | undefined
    tally.check('rows: the outcome answer is the raw model text', outcome?.answer === ANSWER, JSON.stringify(outcome?.answer))
    const lines = rows.stdout.toString('utf8').split('\n').filter(line => line.trim() !== '')
    const allJson = lines.every(line => {
      try {
        JSON.parse(line)
        return true
      } catch {
        return false
      }
    })
    tally.check('rows: every stdout line is still one JSON row (no raw text leaks around the escape)', lines.length > 0 && allJson, lines.find(line => { try { JSON.parse(line); return false } catch { return true } }))
    const js = await run([reply(ANSWER)], 'json')
    let parsed: { answer?: string } | undefined
    try {
      parsed = JSON.parse(js.stdout.toString('utf8')) as { answer?: string }
    } catch {
      parsed = undefined
    }
    tally.check('json: the outcome answer is the raw model text', parsed?.answer === ANSWER, JSON.stringify(parsed?.answer ?? js.stdout.toString('utf8').slice(0, 300)))
  }
} finally {
  ollama.close()
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
