#!/usr/bin/env bun
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'short-take-'))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const model = fileURLToPath(new URL('../../vendor/whisper-models/ggml-base.en-q5_1.bin', import.meta.url))
process.env.MERCURY_WHISPER_MODEL = model

const { loadWhisperAddon } = await import('../../src/services/voice/whisperPack.ts')
const { transcribeWav, unloadLocalModels } = await import('../../src/services/voice/transcribe.ts')
const { encodeWav } = await import('../../src/services/voice/wav.ts')

let failures = 0
let checks = 0
let skipped = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('a take too short for the speech engine to read never reaches it')
const load = loadWhisperAddon()
if (!existsSync(model) || load.state !== 'ok') {
  skipped++
  console.log(`  [SKIP] the engine's road, skipped by name: ${!existsSync(model) ? 'the offline base.en-q5_1 model is absent' : load.state === 'unavailable' ? load.note : 'the engine did not load'}`)
} else {
  const engine = load.addon
  const real = engine.transcribe
  let reached = 0
  engine.transcribe = ((...args: Parameters<typeof real>) => {
    reached++
    return real.apply(engine, args)
  }) as typeof real
  const options = { choice: { kind: 'local', label: 'on-device transcriber', model: 'base.en-q5_1' } } as never
  try {
    const short = await transcribeWav(encodeWav(new Int16Array(200)), options)
    check('a take of 200 samples is answered with no words and no segments, under the model the session resolved', short.text === '' && Array.isArray(short.segments) && short.segments.length === 0 && short.kind === 'local' && short.model.length > 0, JSON.stringify(short))
    check('…and the engine was never handed it', reached === 0, `the engine was called ${reached} time(s)`)
    const before = reached
    const shortest = await transcribeWav(encodeWav(new Int16Array(201)), options)
    check('a take of 201 samples, the shortest the engine reads, reaches it', reached === before + 1 && typeof shortest.text === 'string', `the engine was called ${reached - before} time(s)`)
  } finally {
    engine.transcribe = real
    unloadLocalModels()
  }
}

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? `\n✅ short take: ${checks} checks, 0 failures${skipped > 0 ? `, ${skipped} skipped by name` : ''}` : `\n❌ short take: ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
