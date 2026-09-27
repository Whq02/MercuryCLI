#!/usr/bin/env bun
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_)/.test(name)) delete process.env[name]
}
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
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

const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.js')
const { LOCAL_MODEL_GROUP } = await import('../../src/services/providers/local/localCatalogue.js')
const { Box, render, flushPendingSyncWork, EventEmitter } = await import('../../src/ink.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')

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

const ANTHROPIC = 'Anthropic'
const MODELS = [
  { id: 'claude-fable-5-1', name: 'fable', tag: '', ctx: '1M', group: ANTHROPIC },
  { id: 'local/qwen3.5:9b-q4_K_M', name: 'qwen3.5:9b-q4_K_M', tag: '', ctx: '256k', group: LOCAL_MODEL_GROUP },
  { id: 'local/qwen3.5:27b', name: 'qwen3.5:27b', tag: '', ctx: '', group: LOCAL_MODEL_GROUP },
]
const WIDE = {
  served: 'window · served 256k · [auto → 128k held] · server · 32k · 64k · 128k · max · number · w cycles',
  unloaded: 'window · not loaded · max 256k · [auto] · server · 32k · 64k · 128k · max · number · w cycles',
}
const NARROW = {
  served: 'window [auto → 128k held] · server · 32k · 64k · 128k · max · w cycles',
  unloaded: 'window · not loaded [auto] · server · 32k · 64k · 128k · max · w cycles',
}

async function mount(columns: number, rows: number, notice: string, current: string) {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows }) as unknown as NodeJS.WriteStream
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const node = React.createElement(
    StdinContext.Provider,
    { value: context },
    React.createElement(Box, { flexDirection: 'column' }, React.createElement(MercuryModelPicker, { models: MODELS, current, ctxPct: 23, efforts: ['low', 'medium', 'high', 'max'], effort: 'high', notice } as never)),
  )
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  return {
    frame: () => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
    close: () => instance.unmount(),
  }
}

if (frameDir) mkdirSync(frameDir, { recursive: true })
for (const geometry of [{ columns: 178, rows: 51, tag: '178x51' }, { columns: 80, rows: 21, tag: '80x21' }]) {
  const words = geometry.columns >= 100 ? WIDE : NARROW
  for (const leg of [
    { name: 'served-row-choice', current: 'local/qwen3.5:9b-q4_K_M', notice: words.served, expectRow: 'qwen3.5:9b', expectCtx: '256k' },
    { name: 'unloaded-row-choice', current: 'local/qwen3.5:27b', notice: words.unloaded, expectRow: 'qwen3.5:27b', expectCtx: '' },
  ]) {
    const board = await mount(geometry.columns, geometry.rows, leg.notice, leg.current)
    const frame = board.frame()
    const lines = frame.split('\n')
    check(`${geometry.tag} ${leg.name}: every line fits the width`, lines.every(line => stringWidth(line) <= geometry.columns), String(Math.max(...lines.map(line => stringWidth(line)))))
    check(`${geometry.tag} ${leg.name}: the frame fits the height`, lines.length <= geometry.rows, String(lines.length))
    check(`${geometry.tag} ${leg.name}: the local row is on screen`, frame.includes(leg.expectRow))
    check(`${geometry.tag} ${leg.name}: the choice line paints whole (auto · the ladder · w cycles), never truncated`, frame.includes(leg.notice), lines.find(line => line.includes('window')) ?? '')
    if (frameDir) writeFileSync(join(frameDir, `${leg.name}-${geometry.tag}.txt`), frame + '\n')
    board.close()
  }
}
console.log(failures === 0 ? 'local window picker frames: all green' : `local window picker frames: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
