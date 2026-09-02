#!/usr/bin/env bun
// ============================================================================
//  scripts/voice/voice-transcriber-fixture-server.ts — a loopback stand-in
//  for the two speech-to-text wires, run as its OWN process (a PTY-driven
//  child cannot reach an in-prover listener).
//
//    POST */audio/transcriptions        the OpenAI shape: multipart with a
//                                       `file` part and a `model` part →
//                                       { text }
//    POST */models/<model>:generateContent
//                                       the Gemini shape: JSON with the WAV
//                                       inline → { candidates: [ … ] }
//    GET  */v1beta/models[?…]           the Gemini catalogue: one
//                                       generateContent-capable row (the
//                                       family's rows come from this wire
//                                       alone, so a Gemini-only home boots)
//
//  Appends one line per served request to the ledger file named by
//  argv[3] — method · path · the model · the body's byte count · whether a
//  RIFF/WAVE take rode in it (the prover's request census). argv[2]
//  optionally delays each answer (ms — long enough for a screen to show
//  "transcribing…"); argv[4] is the canned transcript; argv[5] a
//  comma-separated list of OpenAI models to refuse with 404 (the
//  row-fallback leg). Prints "PORT <n>" once listening; binds inside
//  35100-35199.
// ============================================================================
import { createServer, type IncomingMessage } from 'node:http'
import { appendFileSync } from 'node:fs'

const delayMs = Number(process.argv[2] ?? '0')
const ledger = process.argv[3] ?? ''
const transcript = process.argv[4] ?? 'the quick brown fox jumps over the lazy dog'
const refused = new Set((process.argv[5] ?? '').split(',').map(s => s.trim()).filter(s => s !== ''))

function record(line: string): void {
  if (ledger === '') return
  try {
    appendFileSync(ledger, line + '\n')
  } catch {
    /* the ledger is best-effort; the prover also counts via the tripwire log */
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

const server = createServer(async (req, res) => {
  const url = req.url ?? ''
  const body = await readBody(req)
  const text = body.toString('latin1')
  const hasWav = text.includes('RIFF') && text.includes('WAVE')
  const answer = (status: number, payload: unknown): void => {
    const send = (): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (delayMs > 0) setTimeout(send, delayMs)
    else send()
  }
  if (req.method === 'POST' && url.endsWith('/audio/transcriptions')) {
    const model = /name="model"\r\n\r\n([^\r\n]+)/.exec(text)?.[1] ?? '?'
    const hasFile = /name="file"; filename="[^"]+"/.test(text)
    record(`${new Date().toISOString()} POST ${url} model=${model} bytes=${body.length} wav=${hasWav && hasFile ? 'yes' : 'no'}`)
    if (refused.has(model)) {
      answer(404, { error: { message: `The model \`${model}\` does not exist or you do not have access to it.`, type: 'invalid_request_error' } })
      return
    }
    answer(200, { text: transcript })
    return
  }
  const gemini = /\/models\/([^/:]+):generateContent$/.exec(url)
  if (req.method === 'POST' && gemini) {
    let inline = 'no'
    let prompt = ''
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { contents?: Array<{ parts?: Array<{ text?: string; inline_data?: { mime_type?: string; data?: string } }> }> }
      const parts = parsed.contents?.[0]?.parts ?? []
      const audio = parts.find(p => p.inline_data !== undefined)?.inline_data
      if (audio?.mime_type === 'audio/wav' && typeof audio.data === 'string') {
        const bytes = Buffer.from(audio.data, 'base64')
        inline = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE' ? 'yes' : 'bad'
      }
      prompt = parts.find(p => typeof p.text === 'string')?.text ?? ''
    } catch {
      inline = 'unparseable'
    }
    record(`${new Date().toISOString()} POST ${url} model=${decodeURIComponent(gemini[1] as string)} bytes=${body.length} wav=${inline} verbatim=${/verbatim/i.test(prompt) ? 'yes' : 'no'}`)
    answer(200, { candidates: [{ content: { role: 'model', parts: [{ text: transcript }] }, finishReason: 'STOP' }] })
    return
  }
  if (req.method === 'GET' && /\/v1beta\/models(\?|$)/.test(url)) {
    // The Gemini catalogue (the family's rows come from this wire alone):
    // one generateContent-capable row, so a Gemini-only home has a usable
    // model and the chat can start. The census counts POSTs only.
    record(`${new Date().toISOString()} GET ${url} catalogue`)
    answer(200, {
      models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', version: '001', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent'] },
      ],
    })
    return
  }
  if (req.method === 'GET' && url.endsWith('/models')) {
    // A catalogue refresh from a booted product: an empty list keeps the
    // boot quiet; the census counts POSTs only.
    record(`${new Date().toISOString()} GET ${url} catalogue`)
    answer(200, { object: 'list', data: [] })
    return
  }
  record(`${new Date().toISOString()} ${req.method} ${url} bytes=${body.length} unexpected`)
  answer(404, { error: { message: `no fixture route for ${req.method} ${url}` } })
})

function listen(port: number): void {
  server.once('error', () => {
    if (port < 35199) listen(port + 1)
    else {
      console.error('no free port in 35100-35199')
      process.exit(2)
    }
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`PORT ${port}`)
  })
}
listen(35100)
