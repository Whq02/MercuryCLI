#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const captureFile = process.argv[2]
const fixtureCwd = process.argv[3]
const branch = process.argv[4]
if (!captureFile || !fixtureCwd || !branch) {
  console.error('usage: apollo-consent-fixture-server.ts <captureFile> <fixtureCwd> <branch>')
  process.exit(2)
}
if (!['build', 'build-ask-first', 'more-questions', 'spec-review', 'stray-write'].includes(branch)) {
  console.error(`unknown branch ${branch}`)
  process.exit(2)
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
export const FINAL_TEXT = 'APOLLO JOURNEY DONE: the prototype slice is written'
export const RESUME_TEXT = 'INTERVIEW RESUMED: noting the second answer in the spec'
const POLL_ONE = 'How should the demo greet? (the output — console or page)'
const POLL_TWO = 'What colour should the greeting be? (the look — palette)'

function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
}

type Block = Record<string, unknown>

function anthropicTurn(blocks: Block[], stopReason: 'end_turn' | 'tool_use'): string {
  const head = [
    `event: message_start\n${sse({
      type: 'message_start',
      message: {
        id: `msg_apollo_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
      },
    })}`,
  ]
  const body: string[] = []
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      body.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: String(block.text) } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    } else {
      body.push(
        `event: content_block_start\n${sse({
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: String(block.id), name: String(block.name), input: {} },
        })}`,
        `event: content_block_delta\n${sse({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    }
  })
  const tail = [
    `event: message_delta\n${sse({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 12 },
    })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ]
  return [...head, ...body, ...tail].join('')
}

const poll = (id: string, question: string): Block => ({
  type: 'tool_use',
  id,
  name: 'AskUserQuestion',
  input: {
    questions: [
      {
        question,
        header: 'Demo',
        options: [
          { label: 'Console line', description: 'Prints once in the terminal' },
          { label: 'Browser page', description: 'Opens a page that greets' },
          { label: 'Both at once', description: 'Terminal and page together' },
          { label: 'A file it writes', description: 'Leaves a greeting file behind' },
        ],
        multiSelect: false,
      },
    ],
  },
})

const specBranch = branch === 'spec-review' || branch === 'stray-write'
const SPEC_FILE = join(fixtureCwd, '.mercury', 'apollo', 'spec.md')
const DESIGN_FILE = join(fixtureCwd, '.mercury', 'apollo', 'design.md')
const STRAY_FILE = join(fixtureCwd, 'docs', 'notes.md')

const review: Block = {
  type: 'tool_use',
  id: 'toolu_apollo_review',
  name: 'ApolloReview',
  input: {
    summary:
      'A one-file hello demo: run it and a greeting prints. Everything the prototype needs is settled.',
    blockers: [],
    specFiles: specBranch ? [SPEC_FILE, DESIGN_FILE] : [SPEC_FILE],
    runNote: 'node hello.js in the project folder',
  },
}

const specWrite = (id: string, filePath: string, title: string): Block => ({
  type: 'tool_use',
  id,
  name: 'Write',
  input: {
    file_path: filePath,
    content: `# ${title}\n\nThe demo greets once from the terminal.\n`,
  },
})

const writeFileBlock: Block = {
  type: 'tool_use',
  id: 'toolu_apollo_write',
  name: 'Write',
  input: {
    file_path: join(fixtureCwd, 'hello.js'),
    content: "console.log('hello from the apollo prototype')\n",
  },
}

let calls = 0
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = (req.url ?? '').split('?')[0] ?? ''
    const body = ((): Record<string, unknown> => {
      try {
        return JSON.parse(raw) as Record<string, unknown>
      } catch {
        return {}
      }
    })()
    if (req.method === 'POST' && url.endsWith('/v1/messages')) {
      const model = String((body as { model?: unknown }).model ?? '')
      if (model.includes('haiku')) {
        record({ kind: 'side', model, url, at: Date.now() })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(anthropicTurn([{ type: 'text', text: 'hello demo' }], 'end_turn'))
        return
      }
      calls += 1
      record({ kind: 'anthropic', n: calls, url, body, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (calls === 1) {
        res.end(anthropicTurn([poll('toolu_apollo_poll1', POLL_ONE)], 'tool_use'))
      } else if (specBranch) {
        if (calls === 2) {
          res.end(anthropicTurn([specWrite('toolu_apollo_spec1', SPEC_FILE, 'Spec')], 'tool_use'))
        } else if (calls === 3) {
          res.end(
            anthropicTurn(
              [
                branch === 'spec-review'
                  ? specWrite('toolu_apollo_spec2', DESIGN_FILE, 'Design')
                  : specWrite('toolu_apollo_stray', STRAY_FILE, 'Notes'),
              ],
              'tool_use',
            ),
          )
        } else if (calls === 4) {
          res.end(anthropicTurn([review], 'tool_use'))
        } else {
          res.end(anthropicTurn([{ type: 'text', text: FINAL_TEXT }], 'end_turn'))
        }
      } else if (calls === 2) {
        res.end(anthropicTurn([review], 'tool_use'))
      } else if (calls === 3) {
        if (branch === 'more-questions') {
          res.end(anthropicTurn([poll('toolu_apollo_poll2', POLL_TWO)], 'tool_use'))
        } else {
          res.end(anthropicTurn([writeFileBlock], 'tool_use'))
        }
      } else {
        res.end(
          anthropicTurn(
            [{ type: 'text', text: branch === 'more-questions' ? RESUME_TEXT : FINAL_TEXT }],
            'end_turn',
          ),
        )
      }
      return
    }
    record({ kind: 'hit', method: req.method, url, at: Date.now() })
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  console.log(`PORT ${port}`)
})
