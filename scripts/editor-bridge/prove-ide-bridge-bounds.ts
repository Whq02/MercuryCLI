#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configHome = mkdtempSync(join(tmpdir(), 'ide-bridge-bounds-config-'))
const projDir = mkdtempSync(join(tmpdir(), 'ide-bridge-bounds-proj-'))
process.env.MERCURY_CONFIG_DIR = configHome

const bridge = await import('../../src/services/acp/ideToolBridge.ts')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const settleHeap = async (): Promise<number> => {
  for (let round = 0; round < 3; round++) {
    Bun.gc(true)
    await Bun.sleep(20)
  }
  return process.memoryUsage().heapUsed
}

const doorFor = (read: (path: string) => string) => ({
  capabilities: () => ({ readTextFile: true, writeTextFile: true, terminal: false }),
  readTextFile: async (params: { path: string }) => ({ content: read(params.path) }),
  writeTextFile: async () => ({}),
  terminalCreate: async () => ({ terminal_id: 'none' }),
  terminalOutput: async () => ({ output: '', truncated: false }),
  terminalWaitForExit: async () => ({}),
  terminalKill: async () => ({}),
  terminalRelease: async () => ({}),
})

try {
  section('§1 what the bridge keeps about the files the editor returned')
  {
    const FILES = 40
    const SIZE = 2 * 1024 * 1024
    const body = (i: number): string => `${i}:`.padEnd(SIZE, String.fromCharCode(97 + (i % 26)))
    for (let i = 0; i < FILES; i++) writeFileSync(join(projDir, `f${i}.txt`), 'on disk\n')
    bridge.registerIdeToolDoor(doorFor(path => body(Number(/f(\d+)\.txt$/.exec(path)![1]))))
    const before = await settleHeap()
    for (let i = 0; i < FILES; i++) await bridge.readWholeTextViaIde(join(projDir, `f${i}.txt`))
    const retained = (await settleHeap()) - before
    const read = FILES * SIZE
    check(
      'forty 2 MiB buffers read through the editor leave no copy of their text behind',
      retained < read / 8,
      `${Math.round(retained / 1048576)} MiB retained of ${Math.round(read / 1048576)} MiB read`,
    )
    const gen = bridge.ideFileGeneration(join(projDir, 'f0.txt'))
    check('a generation is still answered for a file the editor returned', typeof gen === 'string' && gen.length > 0, String(gen))
    const again = bridge.ideFileGeneration(join(projDir, 'f0.txt'))
    check('the generation is stable while the buffer and the disk are unchanged', gen === again, `${gen} ${again}`)
    bridge.registerIdeToolDoor(null)
    check('closing the door forgets every generation', bridge.ideFileGeneration(join(projDir, 'f0.txt')) === null)
  }

  section('§2 control: a buffer past the whole-file ceiling is refused, not kept')
  {
    const big = 10 * 1024 * 1024 + 1
    bridge.registerIdeToolDoor(doorFor(() => 'x'.repeat(big)))
    let refused = ''
    try {
      await bridge.readWholeTextViaIde(join(projDir, 'f1.txt'))
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error)
    }
    check('an editor buffer over 10 MiB is refused with its size', /exceeds 10485760 bytes/.test(refused), refused)
    bridge.registerIdeToolDoor(null)
  }
} finally {
  bridge.registerIdeToolDoor(null)
  rmSync(configHome, { recursive: true, force: true })
  rmSync(projDir, { recursive: true, force: true })
}

console.log('')
if (failures > 0) {
  console.error(`❌ prove-ide-bridge-bounds: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ prove-ide-bridge-bounds: all checks pass')
