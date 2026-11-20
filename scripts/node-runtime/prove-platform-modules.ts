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
  debugpyPythonCommands,
  envPathDirs,
  evalPythonCommands,
  executableName,
  executableSuffixes,
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
    name: 'programs: pathDelimiter and envPathDirs',
    answers: () => ({
      sep: pathDelimiter(),
      upper: envPathDirs({ PATH: '/a:/b;/c' }),
      mixed: envPathDirs({ Path: 'C:\\a;;C:\\b:/d' }),
      empty: envPathDirs({}),
    }),
    recorded: {"win32":{"sep":";","upper":["/a:/b","/c"],"mixed":["C:\\a","C:\\b:/d"],"empty":[]},"darwin":{"sep":":","upper":["/a","/b;/c"],"mixed":["C","\\a;;C","\\b","/d"],"empty":[]},"linux":{"sep":":","upper":["/a","/b;/c"],"mixed":["C","\\a;;C","\\b","/d"],"empty":[]},"win32 by process.platform alone":{"sep":";","upper":["/a:/b","/c"],"mixed":["C:\\a","C:\\b:/d"],"empty":[]},"win32 by getPlatform() alone":{"sep":":","upper":["/a","/b;/c"],"mixed":["C","\\a;;C","\\b","/d"],"empty":[]}},
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

import {
  commandShellArgv,
  commandShellOption,
  executableNeedsVerbatimArgs,
  hostScriptDialect,
  hostShellHint,
  isBatchShim,
  shellBinarySpec,
  shellCommandSpec,
  shimShellOption,
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
  {
    name: 'spawn.isBatchShim',
    answers: () => [
      isBatchShim('C:\\tools\\code.cmd'),
      isBatchShim('C:\\tools\\RUN.BAT'),
      isBatchShim('C:\\tools\\node.exe'),
      isBatchShim('/usr/bin/code.cmd'),
      isBatchShim(''),
    ],
    recorded: {"win32":[true,true,false,true,false],"darwin":[false,false,false,false,false],"linux":[false,false,false,false,false],"win32 by process.platform alone":[true,true,false,true,false],"win32 by getPlatform() alone":[false,false,false,false,false]},
  },
  {
    name: 'spawn.shimShellOption',
    answers: () => shimShellOption(),
    recorded: {"win32":{"shell":true},"darwin":{},"linux":{},"win32 by process.platform alone":{"shell":true},"win32 by getPlatform() alone":{}},
  },
  {
    name: 'spawn.commandShellArgv',
    answers: () => [commandShellArgv('echo hello'), commandShellArgv('')],
    recorded: {"win32":[["cmd.exe","/d","/s","/c","echo hello"],["cmd.exe","/d","/s","/c",""]],"darwin":[["/bin/sh","-c","echo hello"],["/bin/sh","-c",""]],"linux":[["/bin/sh","-c","echo hello"],["/bin/sh","-c",""]],"win32 by process.platform alone":[["cmd.exe","/d","/s","/c","echo hello"],["cmd.exe","/d","/s","/c",""]],"win32 by getPlatform() alone":[["/bin/sh","-c","echo hello"],["/bin/sh","-c",""]]},
  },
  {
    name: 'spawn.executableNeedsVerbatimArgs',
    answers: () => [
      executableNeedsVerbatimArgs('cmd.exe'),
      executableNeedsVerbatimArgs('C:\\Windows\\System32\\CMD.EXE'),
      executableNeedsVerbatimArgs('cmd'),
      executableNeedsVerbatimArgs('/bin/sh'),
      executableNeedsVerbatimArgs('mycmd.exe'),
    ],
    recorded: {"win32":[true,true,true,false,false],"darwin":[false,false,false,false,false],"linux":[false,false,false,false,false],"win32 by process.platform alone":[true,true,true,false,false],"win32 by getPlatform() alone":[false,false,false,false,false]},
  },
  {
    name: 'spawn.hostScriptDialect',
    answers: () => hostScriptDialect(),
    recorded: {"win32":"powershell","darwin":"posix-sh","linux":"posix-sh","win32 by process.platform alone":"powershell","win32 by getPlatform() alone":"posix-sh"},
  },
]

import {
  childGetsOwnProcessGroup,
  processInstantStartForm,
  processStartFormFor,
  processStartProbeKind,
} from '../../src/utils/platform/processes.js'
const PROCESSES: Row[] = [
  {
    name: 'childGetsOwnProcessGroup',
    answers: stand => [childGetsOwnProcessGroup(), childGetsOwnProcessGroup(stand.node)],
    recorded: {"win32":[false,false],"darwin":[true,true],"linux":[true,true],"win32 by process.platform alone":[false,false],"win32 by getPlatform() alone":[true,true]},
  },
  {
    name: 'processStartFormFor',
    answers: stand => [
      processStartFormFor(true),
      processStartFormFor(false),
      processStartFormFor(true, stand.node),
      processStartFormFor(false, stand.node),
    ],
    recorded: {"win32":["instant","token","instant","token"],"darwin":["token","token","token","token"],"linux":["token","token","token","token"],"win32 by process.platform alone":["instant","token","instant","token"],"win32 by getPlatform() alone":["token","token","token","token"]},
  },
  {
    name: 'processInstantStartForm',
    answers: stand => [processInstantStartForm(), processInstantStartForm(stand.node)],
    recorded: {"win32":["instant","instant"],"darwin":["token","token"],"linux":["token","token"],"win32 by process.platform alone":["instant","instant"],"win32 by getPlatform() alone":["token","token"]},
  },
  {
    name: 'processStartProbeKind',
    answers: stand => [processStartProbeKind(), processStartProbeKind(stand.node)],
    recorded: {"win32":["win32-cim","win32-cim"],"darwin":["posix-ps","posix-ps"],"linux":["linux-proc","linux-proc"],"win32 by process.platform alone":["win32-cim","win32-cim"],"win32 by getPlatform() alone":["linux-proc","linux-proc"]},
  },
]

import { chmodSync, constants as fsConstants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rememberedPlatform } from '../../src/utils/platform/host.js'
import {
  appendNoFollowFlags,
  exclusiveCreateNoFollowFlags,
  isDirAbsentOnRmdirError,
  isOwnedPrivateEntry,
  isPrivateFileMode,
  pathEntryKindSync,
  posixFileModesApply,
  readExposedFileModeSync,
  symlinkDeniedByPrivilege,
  symlinksMayRequirePrivilege,
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
  {
    name: 'files · pathEntryKindSync',
    answers: () => {
      const dir = mkdtempSync(join(tmpdir(), 'mercury-plat-kind-'))
      try {
        const sub = join(dir, 'sub')
        const file = join(dir, 'file')
        mkdirSync(sub)
        writeFileSync(file, 'x')
        return [
          pathEntryKindSync(join(dir, 'missing')),
          pathEntryKindSync(sub),
          pathEntryKindSync(file),
        ]
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    recorded: {
      win32: ['absent', 'directory', 'other'],
      darwin: ['absent', 'directory', 'other'],
      linux: ['absent', 'directory', 'other'],
      'win32 by process.platform alone': ['absent', 'directory', 'other'],
      'win32 by getPlatform() alone': ['absent', 'directory', 'other'],
    },
  },
  {
    name: 'files · isDirAbsentOnRmdirError',
    answers: () => {
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      const enotdir = Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' })
      const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return [
        isDirAbsentOnRmdirError(enoent, 'directory'),
        isDirAbsentOnRmdirError(enoent, 'other'),
        isDirAbsentOnRmdirError(enoent, 'absent'),
        isDirAbsentOnRmdirError(enotdir, 'other'),
        isDirAbsentOnRmdirError(eacces, 'directory'),
        isDirAbsentOnRmdirError(enoent, 'other', 'win32'),
        isDirAbsentOnRmdirError(enoent, 'other', 'linux'),
      ]
    },
    recorded: {
      win32: [true, false, true, false, false, false, true],
      darwin: [true, true, true, false, false, false, true],
      linux: [true, true, true, false, false, false, true],
      'win32 by process.platform alone': [true, false, true, false, false, false, true],
      'win32 by getPlatform() alone': [true, true, true, false, false, false, true],
    },
  },
  {
    name: 'files · exclusiveCreateNoFollowFlags',
    answers: () => {
      const posixBits = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0)
      const label = (v: string | number): string | number => (v === posixBits ? 'posix-excl-nofollow' : v)
      return [
        label(exclusiveCreateNoFollowFlags()),
        label(exclusiveCreateNoFollowFlags(rememberedPlatform())),
        label(exclusiveCreateNoFollowFlags('win32')),
        label(exclusiveCreateNoFollowFlags('linux')),
      ]
    },
    recorded: {
      win32: ['wx', 'wx', 'wx', 'posix-excl-nofollow'],
      darwin: ['posix-excl-nofollow', 'posix-excl-nofollow', 'wx', 'posix-excl-nofollow'],
      linux: ['posix-excl-nofollow', 'posix-excl-nofollow', 'wx', 'posix-excl-nofollow'],
      'win32 by process.platform alone': ['wx', 'posix-excl-nofollow', 'wx', 'posix-excl-nofollow'],
      'win32 by getPlatform() alone': ['posix-excl-nofollow', 'wx', 'wx', 'posix-excl-nofollow'],
    },
  },
  {
    name: 'files · appendNoFollowFlags',
    answers: () => {
      const posixBits = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0)
      const label = (v: string | number): string | number => (v === posixBits ? 'posix-append-nofollow' : v)
      return [
        label(appendNoFollowFlags()),
        label(appendNoFollowFlags('w')),
        label(appendNoFollowFlags('a', 'windows')),
        label(appendNoFollowFlags('w', 'windows')),
        label(appendNoFollowFlags('a', 'macos')),
        label(appendNoFollowFlags('w', 'linux')),
      ]
    },
    recorded: {
      win32: ['a', 'w', 'a', 'w', 'posix-append-nofollow', 'posix-append-nofollow'],
      darwin: ['posix-append-nofollow', 'posix-append-nofollow', 'a', 'w', 'posix-append-nofollow', 'posix-append-nofollow'],
      linux: ['posix-append-nofollow', 'posix-append-nofollow', 'a', 'w', 'posix-append-nofollow', 'posix-append-nofollow'],
      'win32 by process.platform alone': ['posix-append-nofollow', 'posix-append-nofollow', 'a', 'w', 'posix-append-nofollow', 'posix-append-nofollow'],
      'win32 by getPlatform() alone': ['a', 'w', 'a', 'w', 'posix-append-nofollow', 'posix-append-nofollow'],
    },
  },
  {
    name: 'files · symlinksMayRequirePrivilege',
    answers: () => [
      symlinksMayRequirePrivilege(),
      symlinksMayRequirePrivilege(rememberedPlatform()),
      symlinksMayRequirePrivilege('win32'),
      symlinksMayRequirePrivilege('darwin'),
      symlinksMayRequirePrivilege('linux'),
    ],
    recorded: {
      win32: [true, true, true, false, false],
      darwin: [false, false, true, false, false],
      linux: [false, false, true, false, false],
      'win32 by process.platform alone': [true, false, true, false, false],
      'win32 by getPlatform() alone': [false, true, true, false, false],
    },
  },
  {
    name: 'files · symlinkDeniedByPrivilege',
    answers: () => {
      const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' })
      const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' })
      const eexist = Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      return [
        symlinkDeniedByPrivilege(eperm),
        symlinkDeniedByPrivilege(eacces),
        symlinkDeniedByPrivilege(eexist),
        symlinkDeniedByPrivilege(eperm, 'win32'),
        symlinkDeniedByPrivilege(eperm, 'linux'),
      ]
    },
    recorded: {
      win32: [true, true, false, true, false],
      darwin: [false, false, false, true, false],
      linux: [false, false, false, true, false],
      'win32 by process.platform alone': [true, true, false, true, false],
      'win32 by getPlatform() alone': [false, false, false, true, false],
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
