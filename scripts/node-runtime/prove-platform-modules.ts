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

import { chmodSync as p02ChmodSync, mkdirSync as p02MkdirSync, mkdtempSync as p02MkdtempSync, rmSync as p02RmSync, writeFileSync as p02WriteFileSync } from 'node:fs'
import { tmpdir as p02Tmpdir } from 'node:os'
import * as p02Path from 'node:path'
import {
  debugpyPythonCommands,
  envPathDirs,
  evalPythonCommands,
  executableName,
  executableSuffixes,
  hostPathDelimiter,
  isExecutableFile,
  isExecutablePath,
  pathDelimiter,
  pathExtensions,
  resolveProgramInPath,
  spawnableCommandSpellings,
  vendoredNodeRelativePath,
  venvPythonPath,
} from '../../src/utils/platform/programs.js'

function withProgramFixture<T>(run: (dir: string) => T): T {
  const dir = p02MkdtempSync(p02Path.join(p02Tmpdir(), 'mercury-p02-'))
  try {
    const execFile = p02Path.join(dir, 'run-x')
    p02WriteFileSync(execFile, '#!/bin/sh\n')
    p02ChmodSync(execFile, 0o755)
    p02WriteFileSync(p02Path.join(dir, 'run-x.exe'), 'mz')
    p02ChmodSync(p02Path.join(dir, 'run-x.exe'), 0o644)
    p02WriteFileSync(p02Path.join(dir, 'only-plain'), 'txt')
    p02ChmodSync(p02Path.join(dir, 'only-plain'), 0o644)
    p02WriteFileSync(p02Path.join(dir, 'shim.cmd'), '@echo ok\r\n')
    p02ChmodSync(p02Path.join(dir, 'shim.cmd'), 0o644)
    p02MkdirSync(p02Path.join(dir, 'subdir'))
    return run(dir)
  } finally {
    p02RmSync(dir, { recursive: true, force: true })
  }
}

const PROGRAMS: Row[] = [
  {
    name: 'programs: spawnableCommandSpellings',
    answers: () => ['', 'git', 'tool.exe', 'C:\\bin\\git'].map(cmd => spawnableCommandSpellings(cmd)),
    recorded: {"win32":[[".exe",".com",".cmd",".bat",""],["git.exe","git.com","git.cmd","git.bat","git"],["tool.exe.exe","tool.exe.com","tool.exe.cmd","tool.exe.bat","tool.exe"],["C:\\bin\\git.exe","C:\\bin\\git.com","C:\\bin\\git.cmd","C:\\bin\\git.bat","C:\\bin\\git"]],"darwin":[[""],["git"],["tool.exe"],["C:\\bin\\git"]],"linux":[[""],["git"],["tool.exe"],["C:\\bin\\git"]],"win32 by process.platform alone":[[".exe",".com",".cmd",".bat",""],["git.exe","git.com","git.cmd","git.bat","git"],["tool.exe.exe","tool.exe.com","tool.exe.cmd","tool.exe.bat","tool.exe"],["C:\\bin\\git.exe","C:\\bin\\git.com","C:\\bin\\git.cmd","C:\\bin\\git.bat","C:\\bin\\git"]],"win32 by getPlatform() alone":[[""],["git"],["tool.exe"],["C:\\bin\\git"]]},
  },
  {
    name: 'programs: pathExtensions and executableSuffixes',
    answers: () => ({
      defaultExts: pathExtensions({}),
      customExts: pathExtensions({ PATHEXT: '.EXE;.CMD' }),
      exeSuffixes: executableSuffixes(['.exe', '']),
      threeSuffixes: executableSuffixes(['.exe', '.cmd', '.bat', '']),
    }),
    recorded: {"win32":{"defaultExts":[".EXE",".CMD",".BAT",".COM"],"customExts":[".EXE",".CMD"],"exeSuffixes":[".exe",""],"threeSuffixes":[".exe",".cmd",".bat",""]},"darwin":{"defaultExts":[""],"customExts":[""],"exeSuffixes":[""],"threeSuffixes":[""]},"linux":{"defaultExts":[""],"customExts":[""],"exeSuffixes":[""],"threeSuffixes":[""]},"win32 by process.platform alone":{"defaultExts":[".EXE",".CMD",".BAT",".COM"],"customExts":[".EXE",".CMD"],"exeSuffixes":[".exe",""],"threeSuffixes":[".exe",".cmd",".bat",""]},"win32 by getPlatform() alone":{"defaultExts":[""],"customExts":[""],"exeSuffixes":[""],"threeSuffixes":[""]}},
  },
  {
    name: 'programs: isExecutableFile and isExecutablePath',
    answers: () =>
      withProgramFixture(dir => {
        const targets = ['run-x', 'run-x.exe', 'only-plain', 'subdir', 'missing'].map(name => p02Path.join(dir, name))
        return {
          file: targets.map(t => isExecutableFile(t)),
          path: targets.map(t => isExecutablePath(t)),
        }
      }),
    recorded: {"win32":{"file":[true,true,true,false,false],"path":[true,true,true,true,false]},"darwin":{"file":[true,false,false,false,false],"path":[true,false,false,true,false]},"linux":{"file":[true,false,false,false,false],"path":[true,false,false,true,false]},"win32 by process.platform alone":{"file":[true,true,true,false,false],"path":[true,true,true,true,false]},"win32 by getPlatform() alone":{"file":[true,false,false,false,false],"path":[true,false,false,true,false]}},
  },
  {
    name: 'programs: resolveProgramInPath',
    answers: () =>
      withProgramFixture(dir => {
        const rel = (found: string | null): string | null => (found === null ? null : p02Path.relative(dir, found))
        const pathValue = process.platform === 'win32' ? `"${dir}";${dir}` : `${dir}:`
        return {
          empty: rel(resolveProgramInPath('', pathValue)),
          both: rel(resolveProgramInPath('run-x', pathValue)),
          shim: rel(resolveProgramInPath('shim', pathValue)),
          plain: rel(resolveProgramInPath('only-plain', pathValue)),
          explicit: rel(resolveProgramInPath(p02Path.join(dir, 'run-x'), '')),
          quotedOnly: rel(resolveProgramInPath('shim', `"${dir}"`)),
          missing: rel(resolveProgramInPath('missing', pathValue)),
        }
      }),
    recorded: {"win32":{"empty":null,"both":"run-x.exe","shim":"shim.cmd","plain":"only-plain","explicit":"run-x.exe","quotedOnly":"shim.cmd","missing":null},"darwin":{"empty":null,"both":"run-x","shim":null,"plain":null,"explicit":"run-x","quotedOnly":null,"missing":null},"linux":{"empty":null,"both":"run-x","shim":null,"plain":null,"explicit":"run-x","quotedOnly":null,"missing":null},"win32 by process.platform alone":{"empty":null,"both":"run-x.exe","shim":"shim.cmd","plain":"only-plain","explicit":"run-x.exe","quotedOnly":"shim.cmd","missing":null},"win32 by getPlatform() alone":{"empty":null,"both":"run-x","shim":null,"plain":null,"explicit":"run-x","quotedOnly":null,"missing":null}},
  },
  {
    name: 'programs: pathDelimiter, hostPathDelimiter and envPathDirs',
    answers: () => {
      const sep = process.platform === 'win32' ? ';' : p02Path.delimiter
      return {
        exactSep: pathDelimiter(),
        hostSepMatches: hostPathDelimiter() === sep,
        upper: envPathDirs({ PATH: `/a${sep}${sep}/b` }),
        mixed: envPathDirs({ Path: `/x${sep}/y` }),
        empty: envPathDirs({}),
      }
    },
    recorded: {"win32":{"exactSep":";","hostSepMatches":true,"upper":["/a","/b"],"mixed":["/x","/y"],"empty":[]},"darwin":{"exactSep":":","hostSepMatches":true,"upper":["/a","/b"],"mixed":["/x","/y"],"empty":[]},"linux":{"exactSep":":","hostSepMatches":true,"upper":["/a","/b"],"mixed":["/x","/y"],"empty":[]},"win32 by process.platform alone":{"exactSep":";","hostSepMatches":true,"upper":["/a","/b"],"mixed":["/x","/y"],"empty":[]},"win32 by getPlatform() alone":{"exactSep":":","hostSepMatches":true,"upper":["/a","/b"],"mixed":["/x","/y"],"empty":[]}},
  },
  {
    name: 'programs: executableName and vendoredNodeRelativePath',
    answers: () => ({
      names: ['llama-server', 'bun', 'rg', 'godot', 'godot4'].map(name => executableName(name)),
      nodeRel: vendoredNodeRelativePath(),
    }),
    recorded: {"win32":{"names":["llama-server.exe","bun.exe","rg.exe","godot.exe","godot4.exe"],"nodeRel":"node.exe"},"darwin":{"names":["llama-server","bun","rg","godot","godot4"],"nodeRel":"bin/node"},"linux":{"names":["llama-server","bun","rg","godot","godot4"],"nodeRel":"bin/node"},"win32 by process.platform alone":{"names":["llama-server.exe","bun.exe","rg.exe","godot.exe","godot4.exe"],"nodeRel":"node.exe"},"win32 by getPlatform() alone":{"names":["llama-server","bun","rg","godot","godot4"],"nodeRel":"bin/node"}},
  },
  {
    name: 'programs: venvPythonPath, evalPythonCommands and debugpyPythonCommands',
    answers: () => ({
      venv: venvPythonPath('/proj/.venv').replaceAll('\\', '/'),
      evalCmds: evalPythonCommands(),
      debugpyCmds: debugpyPythonCommands(),
    }),
    recorded: {"win32":{"venv":"/proj/.venv/Scripts/python.exe","evalCmds":["python3","python","py"],"debugpyCmds":["python3","python","py"]},"darwin":{"venv":"/proj/.venv/bin/python","evalCmds":["python3"],"debugpyCmds":["python3","python","/usr/bin/python3"]},"linux":{"venv":"/proj/.venv/bin/python","evalCmds":["python3"],"debugpyCmds":["python3","python"]},"win32 by process.platform alone":{"venv":"/proj/.venv/Scripts/python.exe","evalCmds":["python3","python","py"],"debugpyCmds":["python3","python","py"]},"win32 by getPlatform() alone":{"venv":"/proj/.venv/bin/python","evalCmds":["python3"],"debugpyCmds":["python3","python"]}},
  },
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
