import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { ERROR_CLASSES, OUTCOME_STATUSES } from '../../sdk/src/rows.ts'
import { DIST, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { frameLines, isOutcome, type Frame } from '../lib/rows.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-local-reply-outcome')
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'local-reply-outcome-')))
const home = join(root, 'home')
const cwd = join(root, 'work')
seedScratchHome(home, cwd)

const MODEL = 'qwen2.5-coder:3b'
const ASK = 'Create a file hello.py that prints a greeting.'
const NUDGE =
  'The provider stream dropped mid-response after partial content. ' +
  'Pick up exactly where your output stopped rather than restarting. Do not apologise ' +
  'and do not restate anything you already produced. Finish the outstanding work and ' +
  'end with a complete final message.'
const OLLAMA_ERROR = 'llama-server chat error: map[code:500 message:The model produced output that does not match the expected peg-native format type:server_error]'
const HELLO = 'print("Hello, world!")\n'

type ChatBody = { messages?: Array<{ role?: string; content?: unknown }>; tools?: unknown[] }
type Answer = string[]
const row = (fields: Record<string, unknown>): string => `${JSON.stringify({ model: MODEL, created_at: '2026-10-27T10:00:00.000000Z', ...fields })}\n`
const content = (text: string): string => row({ message: { role: 'assistant', content: text }, done: false })
const done = (): string => row({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', total_duration: 900_000_000, load_duration: 50_000_000, prompt_eval_count: 420, prompt_eval_duration: 300_000_000, eval_count: 24, eval_duration: 500_000_000 })
const reply = (text: string): Answer => [content(text), done()]

const chats: ChatBody[] = []
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
      let parsed: ChatBody = {}
      try {
        parsed = JSON.parse(body || '{}') as ChatBody
      } catch {
        parsed = {}
      }
      chats.push(parsed)
      const answer = script.shift()
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      if (answer === undefined) {
        res.end(reply('script exhausted').join(''))
        return
      }
      res.end(answer.join(''))
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

type Run = { frames: Frame[]; stderr: string; code: number | null; chats: ChatBody[] }
function run(answers: Answer[]): Promise<Run> {
  script = [...answers]
  const before = chats.length
  return new Promise(resolve => {
    const child = spawn(NODE, [DIST, 'run', '--model', `local/${MODEL}`, '--ephemeral', '--mode', 'implement', '--format', 'rows', '-d', ASK], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), bound(120_000))
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('close', code => { clearTimeout(timer); resolve({ frames: frameLines(stdout), stderr, code, chats: chats.slice(before) }) })
    child.on('error', error => { clearTimeout(timer); resolve({ frames: frameLines(stdout), stderr: String(error), code: null, chats: chats.slice(before) }) })
  })
}
const outcomeOf = (spent: Run): { status?: string; answer?: string; error?: { message?: string; class?: string }; denials?: unknown[] } | undefined => spent.frames.find(isOutcome) as never
const noticesOf = (spent: Run): string[] => spent.frames.filter(frame => frame.type === 'notice').map(frame => String(frame.text ?? ''))
const sdkReads = (outcome: { status?: string; error?: { class?: string } } | undefined): boolean =>
  outcome !== undefined && (OUTCOME_STATUSES as readonly string[]).includes(outcome.status ?? '') && (ERROR_CLASSES as readonly string[]).includes(outcome.error?.class ?? '')
const hello = join(cwd, 'hello.py')

try {
  console.log(`build under proof: ${DIST}`)
  tally.section('1 · the reported shape: the small model writes a Write call as bare JSON — the call runs, the file lands, the run completes')
  {
    const spent = await run([reply(JSON.stringify({ name: 'Write', arguments: { file_path: hello, content: HELLO } })), reply('Created hello.py with a greeting.')])
    const outcome = outcomeOf(spent)
    const calls = spent.frames.filter(frame => frame.type === 'tool_call').map(frame => String(frame.tool ?? ''))
    tally.check('the fixture served the model and its tools on the first request', spent.chats.length >= 1 && Array.isArray(spent.chats[0]?.tools) && spent.chats[0]!.tools!.length > 0, JSON.stringify({ chats: spent.chats.length, stderr: spent.stderr.slice(-600) }))
    tally.check('one Write tool_call row rides the stream', calls.includes('Write'), JSON.stringify(calls))
    tally.check('hello.py exists with the greeting the model wrote', existsSync(hello) && readFileSync(hello, 'utf8') === HELLO, existsSync(hello) ? readFileSync(hello, 'utf8') : 'missing')
    tally.check('the second request carries the tool result and the run completes on the model\'s closing words with exit 0', spent.chats.length === 2 && outcome?.status === 'completed' && outcome.answer === 'Created hello.py with a greeting.' && spent.code === 0, JSON.stringify({ chats: spent.chats.length, outcome, code: spent.code }))
  }
  rmSync(hello, { force: true })

  tally.section('2 · a tool call the reader leaves as text (an undeclared tool) never settles as completed')
  {
    const spent = await run([reply('{"name":"create_file","arguments":{"path":"hello.py","content":"print(1)\\n"}}')])
    const outcome = outcomeOf(spent)
    tally.check('one request, no tool_call row, no file', spent.chats.length === 1 && !spent.frames.some(frame => frame.type === 'tool_call') && !existsSync(hello), JSON.stringify({ chats: spent.chats.length, frames: spent.frames.map(frame => frame.type) }))
    tally.check('the outcome is failed with the model class, never completed', outcome?.status === 'failed' && outcome.error?.class === 'model', JSON.stringify(outcome))
    tally.check('the error names the call that did not run', outcome?.error?.message === 'The turn failed: the model answered with a tool call (create_file) that was not executed', JSON.stringify(outcome?.error))
    tally.check('the JSON is not carried as the answer', outcome?.answer === undefined, JSON.stringify(outcome?.answer))
    tally.check('the words are ones the SDK reads (its outcome statuses and error classes)', sdkReads(outcome), JSON.stringify(outcome))
    tally.check('the headless exit follows the failure: 1', spent.code === 1, JSON.stringify({ code: spent.code, stderr: spent.stderr.slice(-400) }))
  }

  tally.section('3 · the same call inside a ```json fence after a sentence, naming an undeclared tool: the same outcome')
  {
    const spent = await run([reply('Sure! Here is the call:\n\n```json\n{"name":"create_file","arguments":{"path":"hello.py","content":"print(1)\\n"}}\n```\n')])
    const outcome = outcomeOf(spent)
    tally.check('failed / model, exit 1, the call named', outcome?.status === 'failed' && outcome.error?.class === 'model' && outcome.error.message?.includes('(create_file)') === true && spent.code === 1, JSON.stringify({ outcome, code: spent.code }))
  }

  tally.section('4 · a plain answer, and an answer that merely holds JSON, still complete')
  {
    const spent = await run([reply('I cannot create files without a tool; here is the code:\n\n```python\nprint("hi")\n```')])
    const outcome = outcomeOf(spent)
    tally.check('prose with a code block completes with exit 0', outcome?.status === 'completed' && spent.code === 0, JSON.stringify({ outcome, code: spent.code }))
    const data = await run([reply('{"files": ["hello.py"], "ok": true}')])
    const settled = outcomeOf(data)
    tally.check('a JSON object that is not a tool call completes as the answer', settled?.status === 'completed' && settled.answer === '{"files": ["hello.py"], "ok": true}' && data.code === 0, JSON.stringify({ settled, code: data.code }))
  }

  tally.section('5 · a stream fault after partial content (Ollama\'s {"error"} row): the cut is a notice row, and a reply that parrots the continuation nudge is never the answer')
  {
    const spent = await run([[content('```'), content('python\n'), `${JSON.stringify({ error: OLLAMA_ERROR })}\n`], reply(NUDGE)])
    const outcome = outcomeOf(spent)
    const notices = noticesOf(spent)
    tally.check('two requests: the cut turn and its continuation', spent.chats.length === 2, JSON.stringify({ chats: spent.chats.length, stderr: spent.stderr.slice(-600) }))
    tally.check('the continuation request carries the nudge as the last user words', JSON.stringify(spent.chats[1]?.messages?.at(-1)?.content ?? '').includes('Pick up exactly where your output stopped'), JSON.stringify(spent.chats[1]?.messages?.at(-1)))
    tally.check('the stream cut rides as a notice row naming the continuation', notices.some(text => text.includes('continuation 1 of 1')), JSON.stringify(notices))
    tally.check('the outcome is failed, never completed, and its words are the fault\'s own', outcome?.status === 'failed' && outcome.error?.message?.includes('stream fault after partial content') === true && outcome.answer === undefined, JSON.stringify(outcome))
    tally.check('the words are ones the SDK reads', sdkReads(outcome), JSON.stringify(outcome))
    tally.check('exit 1', spent.code === 1, String(spent.code))
  }

  tally.section('6 · an empty reply, retried once and empty again, ends failed with the notice\'s words, not completed')
  {
    const spent = await run([[done()], [done()]])
    const outcome = outcomeOf(spent)
    const notices = noticesOf(spent)
    tally.check('two requests: the reply and its one retry', spent.chats.length === 2, JSON.stringify({ chats: spent.chats.length, stderr: spent.stderr.slice(-600) }))
    tally.check('the retry notice and the ending notice ride as rows', notices.length === 2 && notices[0]?.includes('retry 1 of 1') === true && notices[1] === 'The provider returned an empty reply — the model was already asked for its answer once; the turn ends here', JSON.stringify(notices))
    tally.check('the outcome is failed / model with the ending notice as its words, no answer', outcome?.status === 'failed' && outcome.error?.class === 'model' && outcome.error.message === notices[1] && outcome.answer === undefined, JSON.stringify(outcome))
    tally.check('exit 1', spent.code === 1, String(spent.code))
  }
} finally {
  ollama.close()
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
