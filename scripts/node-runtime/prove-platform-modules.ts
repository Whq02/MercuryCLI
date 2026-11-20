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

import { posix as pathPosix, win32 as pathWin32 } from 'node:path'
import { foldPathCase, pathModuleFor, samePathCase, stripExtendedLengthPrefixForPlatform, toPosixSeparators } from '../../src/utils/platform/paths.js'

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
  {
    name: 'paths.pathModuleFor',
    answers: () => {
      const sample = (mod: typeof pathWin32 | typeof pathPosix) => ({
        sep: mod.sep,
        join: mod.join('C:\\Users', 'Alice', 'file.ts'),
        dirname: mod.dirname('C:\\Users\\Alice\\file.ts'),
        absWin: mod.isAbsolute('C:\\Users\\Alice'),
        absPosix: mod.isAbsolute('/Users/Alice'),
        rel: mod.relative('C:\\repo', 'C:\\repo\\src\\a.ts'),
      })
      return {
        default: sample(pathModuleFor()),
        win32: sample(pathModuleFor('win32')),
        darwin: sample(pathModuleFor('darwin')),
        linux: sample(pathModuleFor('linux')),
      }
    },
    recorded: {"win32":{"default":{"sep":"\\","join":"C:\\Users\\Alice\\file.ts","dirname":"C:\\Users\\Alice","absWin":true,"absPosix":true,"rel":"src\\a.ts"},"win32":{"sep":"\\","join":"C:\\Users\\Alice\\file.ts","dirname":"C:\\Users\\Alice","absWin":true,"absPosix":true,"rel":"src\\a.ts"},"darwin":{"sep":"/","join":"C:\\Users/Alice/file.ts","dirname":".","absWin":false,"absPosix":true,"rel":"../C:\\repo\\src\\a.ts"},"linux":{"sep":"/","join":"C:\\Users/Alice/file.ts","dirname":".","absWin":false,"absPosix":true,"rel":"../C:\\repo\\src\\a.ts"}},"darwin":{"default":{"sep":"/","join":"C:\\Users/Alice/file.ts","dirname":".","absWin":false,"absPosix":true,"rel":"../C:\\repo\\src\\a.ts"},"win32":{"sep":"\\","join":"C:\\Users\\Alice\\file.ts","dirname":"C:\\Users\\Alice","absWin":true,"absPosix":true,"rel":"src\\a.ts"},"darwin":{"sep":"/","join":"C:\\Users/Alice/file.ts","dirname":".","absWin":false,"absPosix":true,"rel":"../C:\\repo\\src\\a.ts"},"linux":{"sep":"/","join":"C:\\Users/Alice/file.ts","dirname":".","absWin":false,"absPosix":true,"rel":"../C:\\repo\\src\\a.ts"}},"linux":{"default":{"sep":"/","join":"C:\\Users/Alice/file.ts","dirname":".","absWin":false,"absPosix":true,"rel":"../C:\\repo\\src\\a.ts"},"win32":{"sep":"\\","join":"C:\\Users\\Alice\\file.ts","dirname":"C:\\Users\\Alice","absWin":true,"absPosix":true,"rel":"src\\a.ts"},"darwin":{"sep":"/","join":"C:\\Users/Alice/file.ts","dirname":".","absWin":false,"absPosix":true,"rel":"../C:\\repo\\src\\a.ts"},"linux":{"sep":"/","join":"C:\\Users/Alice/file.ts","dirname":".","absWin":false,"absPosix":true,"rel":"../C:\\repo\\src\\a.ts"}},"win32 by process.platform alone":{"default":{"sep":"\\","join":"C:\\Users\\Alice\\file.ts","dirname":"C:\\Users\\Alice","absWin":true,"absPosix":true,"rel":"src\\a.ts"},"win32":{"sep":"\\","join":"C:\\Users\\Alice\\file.ts","dirname":"C:\\Users\\Alice","absWin":true,"absPosix":true,"rel":"src\\a.ts"},"darwin":{"sep":"/","join":"C:\\Users/Alice/file.ts","dirname":".","absWin":false,"absPosix":true,"rel":"../C:\\repo\\src\\a.ts"},"linux":{"sep":"/","join":"C:\\Users/Alice/file.ts","dirname":".","absWin":false,"absPosix":true,"rel":"../C:\\repo\\src\\a.ts"}},"win32 by getPlatform() alone":{"default":{"sep":"/","join":"C:\\Users/Alice/file.ts","dirname":".","absWin":false,"absPosix":true,"rel":"../C:\\repo\\src\\a.ts"},"win32":{"sep":"\\","join":"C:\\Users\\Alice\\file.ts","dirname":"C:\\Users\\Alice","absWin":true,"absPosix":true,"rel":"src\\a.ts"},"darwin":{"sep":"/","join":"C:\\Users/Alice/file.ts","dirname":".","absWin":false,"absPosix":true,"rel":"../C:\\repo\\src\\a.ts"},"linux":{"sep":"/","join":"C:\\Users/Alice/file.ts","dirname":".","absWin":false,"absPosix":true,"rel":"../C:\\repo\\src\\a.ts"}}},
  },
  {
    name: 'paths.stripExtendedLengthPrefixForPlatform',
    answers: () => {
      const inputs = ['', '\\\\?\\C:\\Users\\Alice\\repo\\', '\\\\?\\UNC\\Server\\Share\\file.txt', '\\\\?\\unc\\Server\\Share', 'C:\\Users\\Alice', '/Users/Alice']
      return {
        default: inputs.map(p => stripExtendedLengthPrefixForPlatform(p)),
        win32: inputs.map(p => stripExtendedLengthPrefixForPlatform(p, 'win32')),
        darwin: inputs.map(p => stripExtendedLengthPrefixForPlatform(p, 'darwin')),
        linux: inputs.map(p => stripExtendedLengthPrefixForPlatform(p, 'linux')),
      }
    },
    recorded: {"win32":{"default":["","C:\\Users\\Alice\\repo\\","\\\\Server\\Share\\file.txt","\\\\Server\\Share","C:\\Users\\Alice","/Users/Alice"],"win32":["","C:\\Users\\Alice\\repo\\","\\\\Server\\Share\\file.txt","\\\\Server\\Share","C:\\Users\\Alice","/Users/Alice"],"darwin":["","\\\\?\\C:\\Users\\Alice\\repo\\","\\\\?\\UNC\\Server\\Share\\file.txt","\\\\?\\unc\\Server\\Share","C:\\Users\\Alice","/Users/Alice"],"linux":["","\\\\?\\C:\\Users\\Alice\\repo\\","\\\\?\\UNC\\Server\\Share\\file.txt","\\\\?\\unc\\Server\\Share","C:\\Users\\Alice","/Users/Alice"]},"darwin":{"default":["","\\\\?\\C:\\Users\\Alice\\repo\\","\\\\?\\UNC\\Server\\Share\\file.txt","\\\\?\\unc\\Server\\Share","C:\\Users\\Alice","/Users/Alice"],"win32":["","C:\\Users\\Alice\\repo\\","\\\\Server\\Share\\file.txt","\\\\Server\\Share","C:\\Users\\Alice","/Users/Alice"],"darwin":["","\\\\?\\C:\\Users\\Alice\\repo\\","\\\\?\\UNC\\Server\\Share\\file.txt","\\\\?\\unc\\Server\\Share","C:\\Users\\Alice","/Users/Alice"],"linux":["","\\\\?\\C:\\Users\\Alice\\repo\\","\\\\?\\UNC\\Server\\Share\\file.txt","\\\\?\\unc\\Server\\Share","C:\\Users\\Alice","/Users/Alice"]},"linux":{"default":["","\\\\?\\C:\\Users\\Alice\\repo\\","\\\\?\\UNC\\Server\\Share\\file.txt","\\\\?\\unc\\Server\\Share","C:\\Users\\Alice","/Users/Alice"],"win32":["","C:\\Users\\Alice\\repo\\","\\\\Server\\Share\\file.txt","\\\\Server\\Share","C:\\Users\\Alice","/Users/Alice"],"darwin":["","\\\\?\\C:\\Users\\Alice\\repo\\","\\\\?\\UNC\\Server\\Share\\file.txt","\\\\?\\unc\\Server\\Share","C:\\Users\\Alice","/Users/Alice"],"linux":["","\\\\?\\C:\\Users\\Alice\\repo\\","\\\\?\\UNC\\Server\\Share\\file.txt","\\\\?\\unc\\Server\\Share","C:\\Users\\Alice","/Users/Alice"]},"win32 by process.platform alone":{"default":["","C:\\Users\\Alice\\repo\\","\\\\Server\\Share\\file.txt","\\\\Server\\Share","C:\\Users\\Alice","/Users/Alice"],"win32":["","C:\\Users\\Alice\\repo\\","\\\\Server\\Share\\file.txt","\\\\Server\\Share","C:\\Users\\Alice","/Users/Alice"],"darwin":["","\\\\?\\C:\\Users\\Alice\\repo\\","\\\\?\\UNC\\Server\\Share\\file.txt","\\\\?\\unc\\Server\\Share","C:\\Users\\Alice","/Users/Alice"],"linux":["","\\\\?\\C:\\Users\\Alice\\repo\\","\\\\?\\UNC\\Server\\Share\\file.txt","\\\\?\\unc\\Server\\Share","C:\\Users\\Alice","/Users/Alice"]},"win32 by getPlatform() alone":{"default":["","\\\\?\\C:\\Users\\Alice\\repo\\","\\\\?\\UNC\\Server\\Share\\file.txt","\\\\?\\unc\\Server\\Share","C:\\Users\\Alice","/Users/Alice"],"win32":["","C:\\Users\\Alice\\repo\\","\\\\Server\\Share\\file.txt","\\\\Server\\Share","C:\\Users\\Alice","/Users/Alice"],"darwin":["","\\\\?\\C:\\Users\\Alice\\repo\\","\\\\?\\UNC\\Server\\Share\\file.txt","\\\\?\\unc\\Server\\Share","C:\\Users\\Alice","/Users/Alice"],"linux":["","\\\\?\\C:\\Users\\Alice\\repo\\","\\\\?\\UNC\\Server\\Share\\file.txt","\\\\?\\unc\\Server\\Share","C:\\Users\\Alice","/Users/Alice"]}},
  },
  {
    name: 'paths.toPosixSeparators',
    answers: () => {
      const inputs = ['', 'C:\\Users\\Alice\\Repo\\', 'src\\utils\\a.ts', '\\\\Server\\Share\\file', '/Users/Alice/file\\name', 'plain']
      return {
        default: inputs.map(p => toPosixSeparators(p)),
        win32: inputs.map(p => toPosixSeparators(p, 'win32')),
        darwin: inputs.map(p => toPosixSeparators(p, 'darwin')),
        linux: inputs.map(p => toPosixSeparators(p, 'linux')),
      }
    },
    recorded: {"win32":{"default":["","C:/Users/Alice/Repo/","src/utils/a.ts","//Server/Share/file","/Users/Alice/file/name","plain"],"win32":["","C:/Users/Alice/Repo/","src/utils/a.ts","//Server/Share/file","/Users/Alice/file/name","plain"],"darwin":["","C:\\Users\\Alice\\Repo\\","src\\utils\\a.ts","\\\\Server\\Share\\file","/Users/Alice/file\\name","plain"],"linux":["","C:\\Users\\Alice\\Repo\\","src\\utils\\a.ts","\\\\Server\\Share\\file","/Users/Alice/file\\name","plain"]},"darwin":{"default":["","C:\\Users\\Alice\\Repo\\","src\\utils\\a.ts","\\\\Server\\Share\\file","/Users/Alice/file\\name","plain"],"win32":["","C:/Users/Alice/Repo/","src/utils/a.ts","//Server/Share/file","/Users/Alice/file/name","plain"],"darwin":["","C:\\Users\\Alice\\Repo\\","src\\utils\\a.ts","\\\\Server\\Share\\file","/Users/Alice/file\\name","plain"],"linux":["","C:\\Users\\Alice\\Repo\\","src\\utils\\a.ts","\\\\Server\\Share\\file","/Users/Alice/file\\name","plain"]},"linux":{"default":["","C:\\Users\\Alice\\Repo\\","src\\utils\\a.ts","\\\\Server\\Share\\file","/Users/Alice/file\\name","plain"],"win32":["","C:/Users/Alice/Repo/","src/utils/a.ts","//Server/Share/file","/Users/Alice/file/name","plain"],"darwin":["","C:\\Users\\Alice\\Repo\\","src\\utils\\a.ts","\\\\Server\\Share\\file","/Users/Alice/file\\name","plain"],"linux":["","C:\\Users\\Alice\\Repo\\","src\\utils\\a.ts","\\\\Server\\Share\\file","/Users/Alice/file\\name","plain"]},"win32 by process.platform alone":{"default":["","C:/Users/Alice/Repo/","src/utils/a.ts","//Server/Share/file","/Users/Alice/file/name","plain"],"win32":["","C:/Users/Alice/Repo/","src/utils/a.ts","//Server/Share/file","/Users/Alice/file/name","plain"],"darwin":["","C:\\Users\\Alice\\Repo\\","src\\utils\\a.ts","\\\\Server\\Share\\file","/Users/Alice/file\\name","plain"],"linux":["","C:\\Users\\Alice\\Repo\\","src\\utils\\a.ts","\\\\Server\\Share\\file","/Users/Alice/file\\name","plain"]},"win32 by getPlatform() alone":{"default":["","C:\\Users\\Alice\\Repo\\","src\\utils\\a.ts","\\\\Server\\Share\\file","/Users/Alice/file\\name","plain"],"win32":["","C:/Users/Alice/Repo/","src/utils/a.ts","//Server/Share/file","/Users/Alice/file/name","plain"],"darwin":["","C:\\Users\\Alice\\Repo\\","src\\utils\\a.ts","\\\\Server\\Share\\file","/Users/Alice/file\\name","plain"],"linux":["","C:\\Users\\Alice\\Repo\\","src\\utils\\a.ts","\\\\Server\\Share\\file","/Users/Alice/file\\name","plain"]}},
  },
]

import { chmodSync as p02ChmodSync, mkdirSync as p02MkdirSync, mkdtempSync as p02MkdtempSync, rmSync as p02RmSync, writeFileSync as p02WriteFileSync } from 'node:fs'
import { tmpdir as p02Tmpdir } from 'node:os'
import * as p02Path from 'node:path'
import {
  executableSuffixes,
  isExecutableFile,
  isExecutablePath,
  pathExtensions,
  resolveProgramInPath,
  spawnableCommandSpellings,
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
]

import {
  commandShellOption,
  hostShellHint,
  shellBinarySpec,
  shellCommandSpec,
} from '../../src/utils/platform/spawn.js'
const SPAWN: Row[] = [
  {
    name: 'spawn.commandShellOption',
    answers: () => commandShellOption(),
    recorded: {"win32":true,"darwin":"/bin/sh","linux":"/bin/sh","win32 by process.platform alone":true,"win32 by getPlatform() alone":"/bin/sh"},
  },
  {
    name: 'spawn.shellCommandSpec',
    answers: () => [
      shellCommandSpec(['winget', 'upgrade', 'Mercury'], undefined),
      shellCommandSpec(['brew', 'upgrade', 'mercury'], 'C:\\Windows\\System32\\cmd.exe'),
      shellCommandSpec([], undefined),
    ],
    recorded: {"win32":[{"file":"cmd.exe","args":["/d","/s","/c","\"winget upgrade Mercury\""],"windowsVerbatimArguments":true},{"file":"C:\\Windows\\System32\\cmd.exe","args":["/d","/s","/c","\"brew upgrade mercury\""],"windowsVerbatimArguments":true},{"file":"cmd.exe","args":["/d","/s","/c","\"\""],"windowsVerbatimArguments":true}],"darwin":[{"file":"winget","args":["upgrade","Mercury"],"windowsVerbatimArguments":false},{"file":"brew","args":["upgrade","mercury"],"windowsVerbatimArguments":false},{"file":"","args":[],"windowsVerbatimArguments":false}],"linux":[{"file":"winget","args":["upgrade","Mercury"],"windowsVerbatimArguments":false},{"file":"brew","args":["upgrade","mercury"],"windowsVerbatimArguments":false},{"file":"","args":[],"windowsVerbatimArguments":false}],"win32 by process.platform alone":[{"file":"cmd.exe","args":["/d","/s","/c","\"winget upgrade Mercury\""],"windowsVerbatimArguments":true},{"file":"C:\\Windows\\System32\\cmd.exe","args":["/d","/s","/c","\"brew upgrade mercury\""],"windowsVerbatimArguments":true},{"file":"cmd.exe","args":["/d","/s","/c","\"\""],"windowsVerbatimArguments":true}],"win32 by getPlatform() alone":[{"file":"winget","args":["upgrade","Mercury"],"windowsVerbatimArguments":false},{"file":"brew","args":["upgrade","mercury"],"windowsVerbatimArguments":false},{"file":"","args":[],"windowsVerbatimArguments":false}]},
  },
  {
    name: 'spawn.shellBinarySpec',
    answers: () => [
      shellBinarySpec('C:\\Program Files\\Mercury\\mercury.cmd', ['--version'], undefined),
      shellBinarySpec('/usr/local/bin/mercury', ['--version'], 'C:\\cmd.exe'),
      shellBinarySpec('mercury', [], undefined),
    ],
    recorded: {"win32":[{"file":"cmd.exe","args":["/d","/s","/c","\"\"C:\\Program Files\\Mercury\\mercury.cmd\" --version\""],"windowsVerbatimArguments":true},{"file":"C:\\cmd.exe","args":["/d","/s","/c","\"\"/usr/local/bin/mercury\" --version\""],"windowsVerbatimArguments":true},{"file":"cmd.exe","args":["/d","/s","/c","\"\"mercury\"\""],"windowsVerbatimArguments":true}],"darwin":[{"file":"C:\\Program Files\\Mercury\\mercury.cmd","args":["--version"],"windowsVerbatimArguments":false},{"file":"/usr/local/bin/mercury","args":["--version"],"windowsVerbatimArguments":false},{"file":"mercury","args":[],"windowsVerbatimArguments":false}],"linux":[{"file":"C:\\Program Files\\Mercury\\mercury.cmd","args":["--version"],"windowsVerbatimArguments":false},{"file":"/usr/local/bin/mercury","args":["--version"],"windowsVerbatimArguments":false},{"file":"mercury","args":[],"windowsVerbatimArguments":false}],"win32 by process.platform alone":[{"file":"cmd.exe","args":["/d","/s","/c","\"\"C:\\Program Files\\Mercury\\mercury.cmd\" --version\""],"windowsVerbatimArguments":true},{"file":"C:\\cmd.exe","args":["/d","/s","/c","\"\"/usr/local/bin/mercury\" --version\""],"windowsVerbatimArguments":true},{"file":"cmd.exe","args":["/d","/s","/c","\"\"mercury\"\""],"windowsVerbatimArguments":true}],"win32 by getPlatform() alone":[{"file":"C:\\Program Files\\Mercury\\mercury.cmd","args":["--version"],"windowsVerbatimArguments":false},{"file":"/usr/local/bin/mercury","args":["--version"],"windowsVerbatimArguments":false},{"file":"mercury","args":[],"windowsVerbatimArguments":false}]},
  },
  {
    name: 'spawn.hostShellHint',
    answers: () => [
      hostShellHint({ PSModulePath: 'C:\\Mods', ComSpec: 'C:\\cmd.exe', SHELL: '/bin/zsh' }),
      hostShellHint({ ComSpec: 'C:\\cmd.exe' }),
      hostShellHint({ SHELL: '/bin/bash' }),
      hostShellHint({}),
      hostShellHint({ PSModulePath: '', ComSpec: 'C:\\cmd.exe', SHELL: '' }),
    ],
    recorded: {"win32":["powershell","cmd","unknown","unknown","cmd"],"darwin":["posix-sh","unknown","posix-sh","unknown","unknown"],"linux":["posix-sh","unknown","posix-sh","unknown","unknown"],"win32 by process.platform alone":["powershell","cmd","unknown","unknown","cmd"],"win32 by getPlatform() alone":["posix-sh","unknown","posix-sh","unknown","unknown"]},
  },
]

import { childGetsOwnProcessGroup } from '../../src/utils/platform/processes.js'
const PROCESSES: Row[] = [
  {
    name: 'childGetsOwnProcessGroup',
    answers: stand => [childGetsOwnProcessGroup(), childGetsOwnProcessGroup(stand.node)],
    recorded: {"win32":[false,false],"darwin":[true,true],"linux":[true,true],"win32 by process.platform alone":[false,false],"win32 by getPlatform() alone":[true,true]},
  },
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
