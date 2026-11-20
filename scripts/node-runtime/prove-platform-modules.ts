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

const PATHS: Row[] = [
]

const PROGRAMS: Row[] = [
]

const SPAWN: Row[] = [
]

const PROCESSES: Row[] = [
]

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isOwnedPrivateEntry,
  isPrivateFileMode,
  posixFileModesApply,
  readExposedFileModeSync,
} from '../../src/utils/platform/files.js'

const FILES: Row[] = [
  {
    name: 'files · posixFileModesApply',
    answers: () => [
      posixFileModesApply(),
      posixFileModesApply('win32'),
      posixFileModesApply('darwin'),
      posixFileModesApply('linux'),
    ],
    recorded: {
      win32: [false, false, true, true],
      darwin: [true, false, true, true],
      linux: [true, false, true, true],
      'win32 by process.platform alone': [false, false, true, true],
      'win32 by getPlatform() alone': [true, false, true, true],
    },
  },
  {
    name: 'files · isPrivateFileMode',
    answers: () => [
      isPrivateFileMode(0o100600),
      isPrivateFileMode(0o100644),
      isPrivateFileMode(0o100611),
      isPrivateFileMode(0o100611, 0o066),
      isPrivateFileMode(0o100640, 0o066),
      isPrivateFileMode(0o100644, 0o077, 'win32'),
      isPrivateFileMode(0o100644, 0o077, 'linux'),
    ],
    recorded: {
      win32: [true, true, true, true, true, true, false],
      darwin: [true, false, false, true, false, true, false],
      linux: [true, false, false, true, false, true, false],
      'win32 by process.platform alone': [true, true, true, true, true, true, false],
      'win32 by getPlatform() alone': [true, false, false, true, false, true, false],
    },
  },
  {
    name: 'files · readExposedFileModeSync',
    answers: () => {
      const dir = mkdtempSync(join(tmpdir(), 'mercury-plat-files-'))
      try {
        const wide = join(dir, 'wide')
        writeFileSync(wide, 'x')
        chmodSync(wide, 0o666)
        const missing = join(dir, 'missing')
        let missingAnswer: number | null | string
        try {
          missingAnswer = readExposedFileModeSync(missing)
        } catch (err) {
          missingAnswer = (err as NodeJS.ErrnoException).code ?? 'err'
        }
        return [
          readExposedFileModeSync(wide),
          readExposedFileModeSync(wide, 0o066),
          readExposedFileModeSync(wide, 0o077, 'win32'),
          missingAnswer,
        ]
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    recorded: {
      win32: [null, null, null, null],
      darwin: [438, 438, null, 'ENOENT'],
      linux: [438, 438, null, 'ENOENT'],
      'win32 by process.platform alone': [null, null, null, null],
      'win32 by getPlatform() alone': [438, 438, null, 'ENOENT'],
    },
  },
  {
    name: 'files · isOwnedPrivateEntry',
    answers: () => {
      const selfUid = process.getuid?.() as number
      const otherUid = (process.getuid?.() ?? 0) + 1
      return [
        isOwnedPrivateEntry({ mode: 0o100600, uid: selfUid }),
        isOwnedPrivateEntry({ mode: 0o100644, uid: selfUid }),
        isOwnedPrivateEntry({ mode: 0o100600, uid: otherUid }),
        isOwnedPrivateEntry({ mode: 0o100644, uid: otherUid }, 'win32'),
        isOwnedPrivateEntry({ mode: 0o100644, uid: selfUid }, 'linux'),
      ]
    },
    recorded: {
      win32: [true, true, true, true, false],
      darwin: [true, false, false, true, false],
      linux: [true, false, false, true, false],
      'win32 by process.platform alone': [true, true, true, true, false],
      'win32 by getPlatform() alone': [true, false, false, true, false],
    },
  },
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
