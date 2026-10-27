#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'local-available-memory.'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${!condition && detail ? ` — ${detail}` : ''}`)
}
function section(label: string): void {
  console.log(`\n${label}`)
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const truth = await import('../../src/services/localServer/localServerTruth.ts')
const { fitLocalWindowOn } = await import('../../src/services/localServer/localWindowFit.ts')
const windows = await import('../../src/services/providers/local/localWindow.ts')
const { localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.ts')
const { compatFaultToTypedError } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')

const GIB = 1024 ** 3
const TOTAL = Math.round(15.6 * GIB)
const AVAILABLE = 6 * GIB
const NAME = 'llama3.2:3b'
const model = {
  name: NAME,
  weightsBytes: Math.round(1.9 * GIB),
  geometry: { kvHeads: 224, keyLength: 128, valueLength: 128, attentionLayers: 28, blockCount: 28 },
  trainedMax: 131072,
}
const record = { id: NAME, server: 'ollama' as const, baseUrl: 'http://fixture.invalid/v1', modelMaxContext: model.trainedMax, weightsBytes: model.weightsBytes, geometry: model.geometry }
const noServer = (async () => new Response('{}', { status: 404 })) as typeof fetch

async function machine(platform: NodeJS.Platform, availableBytes: number, run: (file: string, args: string[]) => Promise<string | undefined> = async () => undefined) {
  return truth.readLocalMachineTruth(
    {
      env: { MERCURY_LOCAL_PROBE_TARGETS: 'ollama=http://127.0.0.1:9' },
      fetchImpl: noServer,
      platform,
      totalMemoryBytes: TOTAL,
      availableMemoryBytes: availableBytes,
      home: '/fixture/home',
      readText: path => (path === '/proc/meminfo' ? `MemTotal: ${Math.round(TOTAL / 1024)} kB\nMemAvailable: ${Math.round(availableBytes / 1024)} kB\n` : undefined),
      readTail: () => undefined,
      listDir: () => [],
      pathExists: () => false,
      writable: () => false,
      run,
    },
    'ollama',
  )
}

try {
  section('1 · available memory, not total RAM')
  const six = await machine('linux', AVAILABLE)
  check('Linux reads MemAvailable: 15.6 GiB total, 6.0 GiB available', six.machine.usableMemoryBytes === AVAILABLE && six.machine.usableIsAvailable === true, JSON.stringify(six.machine))
  const auto = windows.chooseLocalWindow(record, 0, undefined, six)
  check('the 3B on 6 GiB picks 32k (1.9 GiB weights + 3.5 GiB cache), not 64k', auto.window === 32768 && auto.fit?.totalBytes === Math.round(5.4 * GIB), `${auto.window} · ${auto.words}`)
  const decisionLine = windows.localWindowDecisionLine(record, auto)
  check('[local-window] names the 32k rung and the honest 6.0 GiB figure', decisionLine.includes(`${NAME}: 32768`) && decisionLine.includes('3.5 GiB cache of 6.0 GiB usable (15.6 GiB box)'), decisionLine)

  const all = await machine('linux', TOTAL)
  check('total == available keeps the former 64k answer', windows.chooseLocalWindow(record, 0, undefined, all).window === 65536)

  windows.__resetLocalWindowsForTest()
  const held = windows.decideLocalWindow(record, 0, 65536, six)
  const planned = windows.localPlannedWindow(record, 65536, six)
  check('a hand-held 64k above the honest figure is honoured, never capped', held.window === 65536 && planned?.tokens === 65536 && planned.source === 'held', JSON.stringify({ held: held.window, planned }))
  windows.__resetLocalWindowsForTest()

  const residentBytes = auto.fit?.ladder.find(rung => rung.window === 32768)?.totalBytes ?? 0
  const resident = fitLocalWindowOn({ ...six, loaded: [{ name: NAME, sizeBytes: residentBytes, contextLength: 32768 }] }, model)
  check('the same model already resident adds its weights and cache back to the memory available for a resize', resident.availableBytes === AVAILABLE && resident.usableBytes === AVAILABLE + residentBytes && resident.ladder[0]?.totalBytes === residentBytes, JSON.stringify({ available: resident.availableBytes, usable: resident.usableBytes, residentBytes }))

  section('2 · the other platform roads')
  const gpu = await machine('linux', AVAILABLE, async file => (file === 'nvidia-smi' ? '16384\n' : undefined))
  check('an existing GPU reading still wins over MemAvailable', gpu.machine.usableMemoryBytes === 16 * GIB && gpu.machine.usableSource.includes('nvidia-smi'), JSON.stringify(gpu.machine))
  const win = await machine('win32', 7 * GIB)
  check('Windows without a GPU reading uses available memory, not total RAM', win.machine.usableMemoryBytes === 7 * GIB && win.machine.usableIsAvailable === true, JSON.stringify(win.machine))
  const mac = await machine('darwin', 7 * GIB)
  check('macOS keeps the Metal unified-memory working set', mac.machine.usableMemoryBytes === Math.round(TOTAL * truth.METAL_DEFAULT_WORKING_SET) && mac.machine.usableIsAvailable !== true, JSON.stringify(mac.machine))

  section('3 · a killed runner names the requested load and free memory')
  windows.__resetLocalWindowsForTest()
  windows.decideLocalWindow(record, 0, 65536, six)
  const profile = localLaneProfileFor(record as never)
  const transport = profile.streamTransport?.(
    {
      url: 'http://fixture.invalid/api/chat',
      request: { model: NAME, messages: [{ role: 'user', content: 'hello' }] },
      fetchImpl: (async () => new Response(JSON.stringify({ error: 'llama-server process has terminated: signal: killed' }), { status: 500, headers: { 'content-type': 'application/json' } })) as typeof fetch,
    },
    [],
  )
  const events = []
  if (transport) for await (const event of transport.events) events.push(event)
  const fault = events.find(event => event.type === 'stream-fault') as { fault: { code: string; message: string; retryable: boolean; classification?: string } } | undefined
  const sentence = 'the local runner was killed, probably out of memory (needed about 8.9 GiB, 6.0 GiB free) · a smaller window in /model fits'
  check('the Ollama 500 maps to the local-runner-killed class and the exact sentence', fault?.fault.code === 'local-runner-killed' && fault.fault.classification === 'server_error' && fault.fault.retryable === false && fault.fault.message === sentence, JSON.stringify(fault?.fault))
  check('the plain class remains a server error downstream', fault !== undefined && compatFaultToTypedError(fault.fault as never) === 'server_error')
} finally {
  windows.__resetLocalWindowsForTest()
  rmSync(HOME, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-local-available-memory: ALL GREEN' : `\nprove-local-available-memory: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
