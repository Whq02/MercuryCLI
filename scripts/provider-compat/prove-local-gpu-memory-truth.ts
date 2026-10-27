#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'local-gpu-memory-truth-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const truth = await import('../../src/services/localServer/localServerTruth.ts')
const { fitLocalWindowOn } = await import('../../src/services/localServer/localWindowFit.ts')
const { SETUP_PULL_CANDIDATES } = await import('../../src/services/localSetup/setupChoose.ts')
type LocalServerIo = import('../../src/services/localServer/localServerTruth.ts').LocalServerIo

const GIB = 1024 ** 3
const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`
const noServer: typeof fetch = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch

function machine(seam: LocalServerIo & { smi?: Record<string, string>; logs?: Record<string, string>; meminfo?: string }): Promise<import('../../src/services/localServer/localServerTruth.ts').LocalServerTruth> {
  const { smi = {}, logs = {}, meminfo = 'MemAvailable: 6291456 kB\n', ...rest } = seam
  return truth.readLocalMachineTruth(
    {
      env: { MERCURY_LOCAL_PROBE_TARGETS: 'ollama=http://127.0.0.1:9' },
      fetchImpl: noServer,
      totalMemoryBytes: 64 * GIB,
      availableMemoryBytes: 6 * GIB,
      home: '/home/box',
      readText: path => (path === '/proc/meminfo' ? meminfo : undefined),
      readTail: path => logs[path],
      listDir: () => [],
      pathExists: () => false,
      writable: () => false,
      run: async (file: string) => smi[file],
      ...rest,
    },
    'ollama',
  )
}

section('1 · Linux without a systemd log: the card is read from nvidia-smi, never the 64 GiB of system RAM')
{
  const before = truth.defaultMachineTruth('linux', 64 * GIB, 6 * GIB)
  check('the base reading for a Linux box with no GPU line or MemAvailable is free memory, never total RAM', before.usableMemoryBytes === 6 * GIB && before.usableSource === 'free memory (no GPU reading or MemAvailable)')
  const nvidia = await machine({ platform: 'linux', smi: { 'nvidia-smi': '16384\n' } })
  check('nvidia-smi memory.total 16384 MiB reads as 16.0 GiB usable', nvidia.machine.usableMemoryBytes === 16 * GIB, `${gib(nvidia.machine.usableMemoryBytes)} · ${nvidia.machine.usableSource}`)
  check('the source names nvidia-smi', nvidia.machine.usableSource.includes('nvidia-smi'), nvidia.machine.usableSource)
  check('the total stays the system RAM (64 GiB) beside the card', nvidia.machine.totalMemoryBytes === 64 * GIB)
  const two = await machine({ platform: 'linux', smi: { 'nvidia-smi': '24576, 1200\n24576, 0\n' } })
  check('two cards sum (memory.total per line; a trailing memory.used column is ignored)', two.machine.usableMemoryBytes === 48 * GIB, gib(two.machine.usableMemoryBytes))
}

section('2 · AMD: rocm-smi --showmeminfo vram --json')
{
  const rocm = await machine({ platform: 'linux', smi: { 'rocm-smi': JSON.stringify({ card0: { 'VRAM Total Memory (B)': '17163091968', 'VRAM Total Used Memory (B)': '1048576' } }) } })
  check('the VRAM total of the card reads as usable (16.0 GiB)', rocm.machine.usableMemoryBytes === 17163091968 && rocm.machine.usableSource.includes('rocm-smi'), `${gib(rocm.machine.usableMemoryBytes)} · ${rocm.machine.usableSource}`)
  check('nvidia-smi is asked first; rocm-smi only when it answers nothing', truth.parseNvidiaSmiMemory('') === undefined && truth.parseRocmSmiMemory('not json') === undefined && truth.parseRocmSmiMemory('{}') === undefined)
}

section('3 · Windows: Ollama\'s own server.log under %LOCALAPPDATA%\\Ollama is read like the Mac and Linux logs')
{
  const logPath = truth.windowsServerLog({ env: { LOCALAPPDATA: 'C:\\Users\\box\\AppData\\Local' }, home: 'C:\\Users\\box' })
  check('the log path is %LOCALAPPDATA%\\Ollama\\server.log', /Ollama[\\/]server\.log$/.test(logPath) && logPath.startsWith('C:\\Users\\box\\AppData\\Local'), logPath)
  check('without LOCALAPPDATA the home\'s AppData\\Local stands in', /AppData[\\/]Local[\\/]Ollama[\\/]server\.log$/.test(truth.windowsServerLog({ env: {}, home: 'C:\\Users\\box' })))
  const windows = await machine({
    platform: 'win32',
    env: { MERCURY_LOCAL_PROBE_TARGETS: 'ollama=http://127.0.0.1:9', LOCALAPPDATA: 'C:\\Users\\box\\AppData\\Local' },
    home: 'C:\\Users\\box',
    logs: { [logPath]: 'time=2026-10-16T08:00:00Z level=INFO source=gpu.go msg="gpu memory" id=GPU-0 library=cuda available="15.2 GiB"\n' },
    smi: { 'nvidia-smi': '16384\n' },
  })
  check('the launch form on Windows carries the log path', windows.launchForm.kind === 'windows' && windows.launchForm.logPath === logPath, JSON.stringify(windows.launchForm))
  check('the server\'s own gpu memory line wins: 15.2 GiB usable (what the server will actually place)', windows.machine.usableMemoryBytes === truth.parseMemoryWords('15.2 GiB') && windows.machine.usableSource.includes('gpu memory line'), `${gib(windows.machine.usableMemoryBytes)} · ${windows.machine.usableSource}`)
  const noLog = await machine({ platform: 'win32', env: { MERCURY_LOCAL_PROBE_TARGETS: 'ollama=http://127.0.0.1:9', LOCALAPPDATA: 'C:\\Users\\box\\AppData\\Local' }, home: 'C:\\Users\\box', smi: { 'nvidia-smi': '12288\n' } })
  check('no log yet (LM Studio, llama-server, a fresh install): nvidia-smi reads the card (12.0 GiB)', noLog.machine.usableMemoryBytes === 12 * GIB && noLog.machine.usableSource.includes('nvidia-smi'), `${gib(noLog.machine.usableMemoryBytes)} · ${noLog.machine.usableSource}`)
}

section('4 · what stays: a Mac\'s unified memory, and a Linux box with no GPU tool at all')
{
  const mac = await machine({ platform: 'darwin', totalMemoryBytes: 48 * GIB, smi: { sysctl: '36864\n' } })
  check('darwin: the wired limit (iogpu.wired_limit_mb) reads as before; nvidia-smi is never asked on a Mac', mac.machine.usableMemoryBytes === 36864 * 1024 * 1024 && mac.machine.usableSource === 'iogpu.wired_limit_mb', `${gib(mac.machine.usableMemoryBytes)} · ${mac.machine.usableSource}`)
  const macDefault = await machine({ platform: 'darwin', totalMemoryBytes: 48 * GIB, smi: { 'nvidia-smi': '16384\n' } })
  check('darwin without the sysctl answer: the Metal default working set, the system reading (a Mac has no discrete card)', macDefault.machine.usableMemoryBytes === Math.round(48 * GIB * truth.METAL_DEFAULT_WORKING_SET), `${gib(macDefault.machine.usableMemoryBytes)} · ${macDefault.machine.usableSource}`)
  const bare = await machine({ platform: 'linux' })
  check('linux with no GPU tool reads MemAvailable: 6.0 GiB of the 64 GiB box', bare.machine.usableMemoryBytes === 6 * GIB && bare.machine.usableSource === 'MemAvailable in /proc/meminfo', bare.machine.usableSource)
}

section('5 · the sizing follows the card: qwen3.5:27b on a 16 GiB card beside 64 GiB of RAM')
{
  const candidate = SETUP_PULL_CANDIDATES.find(c => c.tag === 'qwen3.5:27b')!
  const ram = await machine({ platform: 'linux', availableMemoryBytes: 64 * GIB, meminfo: 'MemAvailable: 67108864 kB\n' })
  const card = await machine({ platform: 'linux', smi: { 'nvidia-smi': '16384\n' } })
  const onRam = fitLocalWindowOn(ram, { name: candidate.tag, weightsBytes: candidate.sizeBytes, geometry: candidate.geometry, trainedMax: candidate.trainedMax })
  const onCard = fitLocalWindowOn(card, { name: candidate.tag, weightsBytes: candidate.sizeBytes, geometry: candidate.geometry, trainedMax: candidate.trainedMax })
  check('against 64 GiB available the 27B keeps its large window', onRam.fits && onRam.window >= 131072, `${onRam.fits} ${onRam.window}`)
  check('against the 16 GiB card the same model does not fit (17 GB of weights alone)', !onCard.fits, `${onCard.fits} ${onCard.window}`)
  const nine = SETUP_PULL_CANDIDATES.find(c => c.tag === 'qwen3.5:9b')!
  const nineOnCard = fitLocalWindowOn(card, { name: nine.tag, weightsBytes: nine.sizeBytes, geometry: nine.geometry, trainedMax: nine.trainedMax })
  check('the 9B (6.6 GB) fits the card with a window the card can hold', nineOnCard.fits && nineOnCard.window >= 32768 && nineOnCard.window <= nine.trainedMax, `${nineOnCard.fits} ${nineOnCard.window}`)
}

console.log(failures === 0 ? '\nprove-local-gpu-memory-truth: ALL GREEN' : `\nprove-local-gpu-memory-truth: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
