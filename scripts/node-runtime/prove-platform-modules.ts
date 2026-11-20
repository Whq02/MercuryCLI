#!/usr/bin/env bun
import { getPlatform, type Platform } from '../../src/utils/platform.js'

type Stand = { name: string; node: NodeJS.Platform; house: Platform }

type Row = {
  name: string
  stands?: readonly Stand[]
  answers: (stand: Stand) => unknown
  old?: (stand: Stand) => unknown
  recorded?: Record<string, unknown>
}

const STANDS: readonly Stand[] = [
  { name: 'win32', node: 'win32', house: 'windows' },
  { name: 'darwin', node: 'darwin', house: 'macos' },
  { name: 'linux', node: 'linux', house: 'linux' },
  { name: 'win32 by process.platform alone', node: 'win32', house: 'linux' },
  { name: 'win32 by getPlatform() alone', node: 'linux', house: 'windows' },
]

import { foldPathCase, samePathCase } from '../../src/utils/platform/paths.js'

const PATHS: Row[] = [
  {
    name: 'paths.foldPathCase',
    answers: () => {
      const inputs = ['', 'C:\\Users\\Alice\\Repo\\', '\\\\Server\\Share\\Dir', '/Users/Alice/Repo', 'File.TS', 'README']
      return {
        default: inputs.map(p => foldPathCase(p)),
        win32: inputs.map(p => foldPathCase(p, 'win32')),
        darwin: inputs.map(p => foldPathCase(p, 'darwin')),
        linux: inputs.map(p => foldPathCase(p, 'linux')),
      }
    },
    recorded: {"win32":{"default":["","c:\\users\\alice\\repo\\","\\\\server\\share\\dir","/users/alice/repo","file.ts","readme"],"win32":["","c:\\users\\alice\\repo\\","\\\\server\\share\\dir","/users/alice/repo","file.ts","readme"],"darwin":["","C:\\Users\\Alice\\Repo\\","\\\\Server\\Share\\Dir","/Users/Alice/Repo","File.TS","README"],"linux":["","C:\\Users\\Alice\\Repo\\","\\\\Server\\Share\\Dir","/Users/Alice/Repo","File.TS","README"]},"darwin":{"default":["","C:\\Users\\Alice\\Repo\\","\\\\Server\\Share\\Dir","/Users/Alice/Repo","File.TS","README"],"win32":["","c:\\users\\alice\\repo\\","\\\\server\\share\\dir","/users/alice/repo","file.ts","readme"],"darwin":["","C:\\Users\\Alice\\Repo\\","\\\\Server\\Share\\Dir","/Users/Alice/Repo","File.TS","README"],"linux":["","C:\\Users\\Alice\\Repo\\","\\\\Server\\Share\\Dir","/Users/Alice/Repo","File.TS","README"]},"linux":{"default":["","C:\\Users\\Alice\\Repo\\","\\\\Server\\Share\\Dir","/Users/Alice/Repo","File.TS","README"],"win32":["","c:\\users\\alice\\repo\\","\\\\server\\share\\dir","/users/alice/repo","file.ts","readme"],"darwin":["","C:\\Users\\Alice\\Repo\\","\\\\Server\\Share\\Dir","/Users/Alice/Repo","File.TS","README"],"linux":["","C:\\Users\\Alice\\Repo\\","\\\\Server\\Share\\Dir","/Users/Alice/Repo","File.TS","README"]},"win32 by process.platform alone":{"default":["","c:\\users\\alice\\repo\\","\\\\server\\share\\dir","/users/alice/repo","file.ts","readme"],"win32":["","c:\\users\\alice\\repo\\","\\\\server\\share\\dir","/users/alice/repo","file.ts","readme"],"darwin":["","C:\\Users\\Alice\\Repo\\","\\\\Server\\Share\\Dir","/Users/Alice/Repo","File.TS","README"],"linux":["","C:\\Users\\Alice\\Repo\\","\\\\Server\\Share\\Dir","/Users/Alice/Repo","File.TS","README"]},"win32 by getPlatform() alone":{"default":["","C:\\Users\\Alice\\Repo\\","\\\\Server\\Share\\Dir","/Users/Alice/Repo","File.TS","README"],"win32":["","c:\\users\\alice\\repo\\","\\\\server\\share\\dir","/users/alice/repo","file.ts","readme"],"darwin":["","C:\\Users\\Alice\\Repo\\","\\\\Server\\Share\\Dir","/Users/Alice/Repo","File.TS","README"],"linux":["","C:\\Users\\Alice\\Repo\\","\\\\Server\\Share\\Dir","/Users/Alice/Repo","File.TS","README"]}},
  },
  {
    name: 'paths.samePathCase',
    answers: () => {
      const pairs: ReadonlyArray<[string, string]> = [
        ['C:\\Repo\\A.ts', 'c:\\repo\\a.ts'],
        ['/Users/Alice', '/users/alice'],
        ['\\\\Server\\Share', '\\\\server\\share'],
        ['', ''],
        ['C:\\Repo\\', 'C:\\Repo'],
        ['File.TS', 'file.ts'],
      ]
      return {
        default: pairs.map(([a, b]) => samePathCase(a, b)),
        win32: pairs.map(([a, b]) => samePathCase(a, b, 'win32')),
        darwin: pairs.map(([a, b]) => samePathCase(a, b, 'darwin')),
        linux: pairs.map(([a, b]) => samePathCase(a, b, 'linux')),
      }
    },
    recorded: {"win32":{"default":[true,true,true,true,false,true],"win32":[true,true,true,true,false,true],"darwin":[false,false,false,true,false,false],"linux":[false,false,false,true,false,false]},"darwin":{"default":[false,false,false,true,false,false],"win32":[true,true,true,true,false,true],"darwin":[false,false,false,true,false,false],"linux":[false,false,false,true,false,false]},"linux":{"default":[false,false,false,true,false,false],"win32":[true,true,true,true,false,true],"darwin":[false,false,false,true,false,false],"linux":[false,false,false,true,false,false]},"win32 by process.platform alone":{"default":[true,true,true,true,false,true],"win32":[true,true,true,true,false,true],"darwin":[false,false,false,true,false,false],"linux":[false,false,false,true,false,false]},"win32 by getPlatform() alone":{"default":[false,false,false,true,false,false],"win32":[true,true,true,true,false,true],"darwin":[false,false,false,true,false,false],"linux":[false,false,false,true,false,false]}},
  },
]

const PROGRAMS: Row[] = [
]

const SPAWN: Row[] = [
]

const PROCESSES: Row[] = [
]

const FILES: Row[] = [
]

const TERMINAL: Row[] = [
]

const DESKTOP: Row[] = [
]

const ROWS = [...PATHS, ...PROGRAMS, ...SPAWN, ...PROCESSES, ...FILES, ...TERMINAL, ...DESKTOP]

const show = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v === undefined ? 'undefined' : v instanceof RegExp || typeof v === 'bigint' || typeof v === 'function' ? String(v) : v instanceof Map || v instanceof Set ? [...v] : v,
  )

async function standIn(stand: Stand, read: (stand: Stand) => unknown): Promise<string> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...real, value: stand.node })
  getPlatform.cache.set(undefined, stand.house)
  try {
    return show(await read(stand))
  } catch (error) {
    return show(`threw ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    Object.defineProperty(process, 'platform', real)
    getPlatform.cache.delete(undefined)
  }
}

console.log('============================================================')
console.log(' platform modules — each function answers as the inline code it replaced')
console.log('============================================================')

const record = process.argv.includes('--record')
let failed = 0
for (const row of ROWS) {
  const recording: Record<string, unknown> = {}
  for (const stand of row.stands ?? STANDS) {
    const got = await standIn(stand, row.answers)
    recording[stand.name] = JSON.parse(got)
    if (record) continue
    const want = row.old ? await standIn(stand, row.old) : row.recorded && stand.name in row.recorded ? show(row.recorded[stand.name]) : undefined
    const ok = got === want
    if (!ok) failed++
    const against = want === undefined ? 'the row holds neither the old code nor a recorded answer' : `${row.old ? 'the old code' : 'the recording'} answers ${want}`
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${row.name} · ${stand.name}${ok ? '' : ` — the function answers ${got}, ${against}`}`)
  }
  if (record) console.log(`${row.name}\n    recorded: ${JSON.stringify(recording)},`)
}

console.log(failed === 0 ? `\nALL PLATFORM-MODULE CHECKS PASS (${ROWS.length} rows)` : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
