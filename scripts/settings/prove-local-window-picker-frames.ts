#!/usr/bin/env bun
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_)/.test(name)) delete process.env[name]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'local-window-picker-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.FORCE_COLOR = '3'
delete process.env.MERCURY_LOCAL_BASE_URL

const SERVED_MODEL = 'qwen3.5:9b-q4_K_M'
const UNLOADED_MODEL = 'qwen3.8:27b-mtp-q4_K_M'
const GIB = 1024 ** 3
const kvHeads = (blocks: number): number[] => Array.from({ length: blocks }, (_, i) => ((i + 1) % 4 === 0 ? 4 : 0))
const INFO: Record<string, Record<string, unknown>> = {
  [SERVED_MODEL]: { 'general.architecture': 'qwen35', 'qwen35.attention.head_count': 16, 'qwen35.attention.head_count_kv': kvHeads(32), 'qwen35.attention.key_length': 256, 'qwen35.attention.value_length': 256, 'qwen35.block_count': 32, 'qwen35.context_length': 262144, 'qwen35.embedding_length': 4096, 'qwen35.full_attention_interval': 4 },
  [UNLOADED_MODEL]: { 'general.architecture': 'qwen35', 'qwen35.attention.head_count': 24, 'qwen35.attention.head_count_kv': 4, 'qwen35.attention.key_length': 256, 'qwen35.attention.value_length': 256, 'qwen35.block_count': 65, 'qwen35.context_length': 262144, 'qwen35.embedding_length': 5120, 'qwen35.full_attention_interval': 4, 'qwen35.nextn_predict_layers': 1 },
}
const SIZES: Record<string, number> = { [SERVED_MODEL]: 6594474711, [UNLOADED_MODEL]: 17741872154 }
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const ollama = await new Promise<{ server: Server; root: string }>(resolve => {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', chunk => {
      raw += String(chunk)
    })
    req.on('end', () => {
      const url = req.url ?? ''
      if (url === '/api/tags') return json(res, 200, { models: [SERVED_MODEL, UNLOADED_MODEL].map(name => ({ name, model: name, size: SIZES[name], details: { family: 'qwen35' } })) })
      if (url === '/api/version') return json(res, 200, { version: '0.34.4' })
      if (url === '/api/ps') return json(res, 200, { models: [{ name: SERVED_MODEL, model: SERVED_MODEL, context_length: 262144 }] })
      if (url === '/api/show') {
        const model = String((raw ? (JSON.parse(raw) as { model?: string }) : {}).model ?? '')
        return json(res, 200, { parameters: '', model_info: INFO[model] ?? { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 }, capabilities: ['completion', 'tools', 'thinking'], details: { family: 'qwen35' }, requested: raw })
      }
      json(res, 404, { error: 'not found' })
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    resolve({ server, root: `http://127.0.0.1:${port}` })
  })
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${ollama.root}`

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
async function stub(path: string, fixture: () => Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixture() }))
}
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const frameDir = arg('--frames')
await stub('../../src/hooks/useCatalogueEpoch.js', () => ({ useCatalogueEpoch: () => 0 }))
await stub('../../src/keybindings/useKeybinding.js', () => ({ useKeybinding: () => undefined }))
await stub('../../src/services/providers/providerUsage.js', () => ({ activeSourceUsage: () => ({ tier: 'local · no metering' }) }))
await stub('../../src/utils/settings/settings.js', () => ({ getInitialSettings: () => ({ modelPickerCentred: false }) }))

const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.js')
const { localRecordFor, LOCAL_MODEL_GROUP } = await import('../../src/services/providers/local/localCatalogue.js')
const w = await import('../../src/services/providers/local/localWindow.js')
const { __pinLocalServerTruthForTest } = await import('../../src/services/localServer/localServerTruth.js')
const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.js')
const { Box, render, flushPendingSyncWork, EventEmitter, InputEvent } = await import('../../src/ink.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
await refreshLocalDiscovery({ force: true })
const served = localRecordFor(`local/${SERVED_MODEL}`)!
const unloaded = localRecordFor(`local/${UNLOADED_MODEL}`)!
__pinLocalServerTruthForTest({ loaded: [], listed: [], runners: [], launchForm: { kind: 'unknown', note: 'fixture' }, machine: { platform: 'darwin', totalMemoryBytes: 16 * GIB, usableMemoryBytes: 12 * GIB, usableSource: 'about three quarters of unified memory, the Metal default working set (no server log read)' }, readAtMs: Date.now() })
const REFUSED_MAX = '[max — 14.1 GiB does not fit 12.0 GiB usable · 128k fits]'

let failures = 0
function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
}
const settle = async () => {
  for (let index = 0; index < 6; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

const MODELS = [
  { id: 'claude-fable-5-1', name: 'fable', tag: '', ctx: '1M', group: 'Anthropic' },
  { id: `local/${SERVED_MODEL}`, name: SERVED_MODEL, tag: '', ctx: '256k', group: LOCAL_MODEL_GROUP },
  { id: `local/${UNLOADED_MODEL}`, name: UNLOADED_MODEL, tag: '', ctx: '', group: LOCAL_MODEL_GROUP },
]

async function mount(columns: number, rows: number, current: string) {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows }) as unknown as NodeJS.WriteStream
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  let closed = 0
  const node = React.createElement(
    StdinContext.Provider,
    { value: context },
    React.createElement(Box, { flexDirection: 'column' }, React.createElement(MercuryModelPicker, { models: MODELS, current, ctxPct: 23, efforts: ['low', 'medium', 'high', 'max'], effort: 'high', onClose: () => { closed++ } } as never)),
  )
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  return {
    frame: () => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
    raw: () => instance.lastFrame(),
    line: () => {
      const rows = stripAnsi(instance.lastFrame()).split('\n').map(l => l.replace(/^│ ?/, '').replace(/ ?│$/, '').trim())
      const at = rows.findIndex(l => l.startsWith('window'))
      if (at < 0) return ''
      let out = rows[at]!
      for (let i = at + 1; i < rows.length && !/w cycles$|▍$|not a toggle$/.test(out); i++) out += ` ${rows[i]}`
      return out
    },
    closed: () => closed,
    async key(name: string, sequence = name) {
      const event = new InputEvent({ name, sequence, ctrl: false, shift: false, fn: false, meta: false, option: false, super: false, isPasted: false } as never)
      emitter.emit('input', event)
      await settle()
      return event.didStopImmediatePropagation()
    },
    close: () => instance.unmount(),
  }
}

if (frameDir) mkdirSync(frameDir, { recursive: true })
const save = (name: string, frame: string): void => {
  if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), frame + '\n')
}

for (const geometry of [{ columns: 178, rows: 51, tag: '178x51' }, { columns: 80, rows: 21, tag: '80x21' }]) {
  const wide = geometry.columns >= 100
  w.__resetLocalWindowsForTest()
  w.writeLocalWindowSetting(served, undefined)
  w.writeLocalWindowSetting(unloaded, undefined)
  w.decideLocalWindow(served, 62_000, undefined)

  const board = await mount(geometry.columns, geometry.rows, `local/${SERVED_MODEL}`)
  const fits = (frame: string): boolean => frame.split('\n').every(line => stringWidth(line) <= geometry.columns) && frame.split('\n').length <= geometry.rows
  check(`${geometry.tag}: the served row paints its window line unasked — auto resolved to the fit rung (128k on this 16 GiB box, f16, 1 slot) and held, the served figure the server's word`, board.line() === (wide ? 'window · served 256k · [auto → 128k fit held] · server · 32k · 64k · 128k · max · number · w cycles' : 'window [auto → 128k fit held] · server · 32k · 64k · 128k · max · w cycles') && fits(board.frame()), board.line())
  save(`served-row-choice-${geometry.tag}`, board.frame())
  const steps: Array<{ expect: string; setting: unknown }> = [
    { expect: '[server]', setting: 'server' },
    { expect: '[32k]', setting: 32768 },
    { expect: '[64k]', setting: 65536 },
    { expect: '[128k]', setting: 131072 },
    { expect: REFUSED_MAX, setting: 'max' },
  ]
  let walked = true
  for (const step of steps) {
    const consumed = await board.key('w')
    const line = board.line().replace(/\s+/g, ' ')
    walked &&= consumed && line.includes(step.expect) && w.localWindowSettingOf(served) === step.setting
    if (!walked) {
      check(`${geometry.tag}: w walks the ladder — ${step.expect}`, false, `${board.line()} · setting ${String(w.localWindowSettingOf(served))}`)
      break
    }
  }
  if (walked) check(`${geometry.tag}: w walks the ladder server → 32k → 64k → 128k → max, each persisted as the setting; max refuses politely — ${REFUSED_MAX}`, true)
  check(`${geometry.tag}: the refusal is painted in the failure ink (an SGR opens right before the bracket)`, /\x1b\[[0-9;]*m\[max — /.test(board.raw()), board.raw().slice(Math.max(0, board.raw().indexOf('[max') - 30), board.raw().indexOf('[max') + 8))
  save(`served-row-refused-${geometry.tag}`, board.frame())
  await board.key('w')
  check(`${geometry.tag}: after max, w opens the number prompt (type the tokens · ↵ sets · esc cancels)`, board.line().startsWith('window · type the tokens') && w.localWindowSettingOf(served) === 'max', board.line())
  save(`served-row-typing-${geometry.tag}`, board.frame())
  await board.key('escape', '\x1b')
  check(`${geometry.tag}: esc cancels the prompt without closing the picker and leaves max (still refused)`, board.closed() === 0 && board.line().includes('[max —') && w.localWindowSettingOf(served) === 'max', board.line())
  await board.key('w')
  for (const ch of ['4', '8', 'k']) await board.key(ch)
  check(`${geometry.tag}: the typed tokens echo on the prompt`, board.line().endsWith('48k▍'), board.line())
  await board.key('return', '\r')
  check(`${geometry.tag}: ↵ sets 48k as the number rung and persists 49152; 48k fits so no refusal`, board.line().includes('[48k]') && w.localWindowSettingOf(served) === 49152, board.line())
  save(`served-row-number-${geometry.tag}`, board.frame())
  await board.key('w')
  check(`${geometry.tag}: from a number, w returns to auto (the setting cleared)`, board.line().includes('[auto') && w.localWindowSettingOf(served) === undefined, board.line())
  await board.key('down')
  check(`${geometry.tag}: the unloaded row says so — not loaded, the trained max, auto predicting the fit rung (the 27B on 16 GiB: nothing fits, the 32k floor) with nothing held yet`, board.line() === (wide ? 'window · not loaded · max 256k · [auto → 32k fit] · server · 32k · 64k · 128k · max · number · w cycles' : 'window · not loaded [auto → 32k fit] · server · 32k · 64k · 128k · max · w cycles'), board.line())
  save(`unloaded-row-choice-${geometry.tag}`, board.frame())
  await board.key('w')
  await board.key('w')
  await board.key('w')
  check(`${geometry.tag}: the hybrid 27B at 64k on 16 GiB (f16, no runner read) refuses with the 16-layer sum and says no rung fits — [64k — 20.5 GiB does not fit 12.0 GiB usable · no rung fits], never 32.8 GiB (65 layers)`, board.line().replace(/\s+/g, ' ').includes('[64k — 20.5 GiB does not fit 12.0 GiB usable · no rung fits]') && w.localWindowSettingOf(unloaded) === 65536, board.line())
  save(`unloaded-row-refused-${geometry.tag}`, board.frame())
  w.writeLocalWindowSetting(unloaded, undefined)
  await board.key('up')
  await board.key('up')
  check(`${geometry.tag}: a non-local row paints no window line and w is not consumed there`, board.line() === '' && !(await board.key('w')), board.line())
  board.close()
}

ollama.server.close()
console.log(failures === 0 ? 'local window picker: all green' : `local window picker: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
