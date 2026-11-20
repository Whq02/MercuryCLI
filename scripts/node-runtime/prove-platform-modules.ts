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

import * as hostPath from 'node:path'
import { posix as pathPosix, win32 as pathWin32 } from 'node:path'
import { foldPathCase, hostOrWin32PathModule, pathModuleFor, samePathCase, splitPathFromRoot, stripExtendedLengthPrefixForPlatform, toPosixSeparators } from '../../src/utils/platform/paths.js'

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
  {
    name: 'paths.splitPathFromRoot',
    answers: () => {
      const inputs = ['C:\\a\\b', 'C:/a/b', 'c:\\', '\\\\server\\share\\d', '/a/b', '/', 'rel/path', '']
      return {
        default: inputs.map(p => splitPathFromRoot(p)),
        win32: inputs.map(p => splitPathFromRoot(p, 'win32')),
        darwin: inputs.map(p => splitPathFromRoot(p, 'darwin')),
        linux: inputs.map(p => splitPathFromRoot(p, 'linux')),
      }
    },
    recorded: {"win32":{"default":[{"root":"C:\\","segments":["a","b"],"sep":"\\"},{"root":"C:/","segments":["a","b"],"sep":"\\"},{"root":"c:\\","segments":[],"sep":"\\"},{"root":"\\\\server\\share\\","segments":["d"],"sep":"\\"},{"root":"/","segments":["a","b"],"sep":"\\"},{"root":"/","segments":[],"sep":"\\"},{"root":"\\","segments":["rel","path"],"sep":"\\"},{"root":"\\","segments":[],"sep":"\\"}],"win32":[{"root":"C:\\","segments":["a","b"],"sep":"\\"},{"root":"C:/","segments":["a","b"],"sep":"\\"},{"root":"c:\\","segments":[],"sep":"\\"},{"root":"\\\\server\\share\\","segments":["d"],"sep":"\\"},{"root":"/","segments":["a","b"],"sep":"\\"},{"root":"/","segments":[],"sep":"\\"},{"root":"\\","segments":["rel","path"],"sep":"\\"},{"root":"\\","segments":[],"sep":"\\"}],"darwin":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}],"linux":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}]},"darwin":{"default":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}],"win32":[{"root":"C:\\","segments":["a","b"],"sep":"\\"},{"root":"C:/","segments":["a","b"],"sep":"\\"},{"root":"c:\\","segments":[],"sep":"\\"},{"root":"\\\\server\\share\\","segments":["d"],"sep":"\\"},{"root":"/","segments":["a","b"],"sep":"\\"},{"root":"/","segments":[],"sep":"\\"},{"root":"\\","segments":["rel","path"],"sep":"\\"},{"root":"\\","segments":[],"sep":"\\"}],"darwin":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}],"linux":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}]},"linux":{"default":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}],"win32":[{"root":"C:\\","segments":["a","b"],"sep":"\\"},{"root":"C:/","segments":["a","b"],"sep":"\\"},{"root":"c:\\","segments":[],"sep":"\\"},{"root":"\\\\server\\share\\","segments":["d"],"sep":"\\"},{"root":"/","segments":["a","b"],"sep":"\\"},{"root":"/","segments":[],"sep":"\\"},{"root":"\\","segments":["rel","path"],"sep":"\\"},{"root":"\\","segments":[],"sep":"\\"}],"darwin":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}],"linux":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}]},"win32 by process.platform alone":{"default":[{"root":"C:\\","segments":["a","b"],"sep":"\\"},{"root":"C:/","segments":["a","b"],"sep":"\\"},{"root":"c:\\","segments":[],"sep":"\\"},{"root":"\\\\server\\share\\","segments":["d"],"sep":"\\"},{"root":"/","segments":["a","b"],"sep":"\\"},{"root":"/","segments":[],"sep":"\\"},{"root":"\\","segments":["rel","path"],"sep":"\\"},{"root":"\\","segments":[],"sep":"\\"}],"win32":[{"root":"C:\\","segments":["a","b"],"sep":"\\"},{"root":"C:/","segments":["a","b"],"sep":"\\"},{"root":"c:\\","segments":[],"sep":"\\"},{"root":"\\\\server\\share\\","segments":["d"],"sep":"\\"},{"root":"/","segments":["a","b"],"sep":"\\"},{"root":"/","segments":[],"sep":"\\"},{"root":"\\","segments":["rel","path"],"sep":"\\"},{"root":"\\","segments":[],"sep":"\\"}],"darwin":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}],"linux":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}]},"win32 by getPlatform() alone":{"default":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}],"win32":[{"root":"C:\\","segments":["a","b"],"sep":"\\"},{"root":"C:/","segments":["a","b"],"sep":"\\"},{"root":"c:\\","segments":[],"sep":"\\"},{"root":"\\\\server\\share\\","segments":["d"],"sep":"\\"},{"root":"/","segments":["a","b"],"sep":"\\"},{"root":"/","segments":[],"sep":"\\"},{"root":"\\","segments":["rel","path"],"sep":"\\"},{"root":"\\","segments":[],"sep":"\\"}],"darwin":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}],"linux":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}]}},
  },
  {
    name: 'paths.hostOrWin32PathModule',
    answers: stand => ({
      defaultMatchesExpected: hostOrWin32PathModule() === (stand.node === 'win32' ? pathWin32 : hostPath),
      win32IsWin32: hostOrWin32PathModule('win32') === pathWin32,
      darwinIsHost: hostOrWin32PathModule('darwin') === hostPath,
      linuxIsHost: hostOrWin32PathModule('linux') === hostPath,
      win32Resolve: hostOrWin32PathModule('win32').resolve('C:\\Users', 'Alice'),
    }),
    recorded: {"win32":{"defaultMatchesExpected":true,"win32IsWin32":true,"darwinIsHost":true,"linuxIsHost":true,"win32Resolve":"C:\\Users\\Alice"},"darwin":{"defaultMatchesExpected":true,"win32IsWin32":true,"darwinIsHost":true,"linuxIsHost":true,"win32Resolve":"C:\\Users\\Alice"},"linux":{"defaultMatchesExpected":true,"win32IsWin32":true,"darwinIsHost":true,"linuxIsHost":true,"win32Resolve":"C:\\Users\\Alice"},"win32 by process.platform alone":{"defaultMatchesExpected":true,"win32IsWin32":true,"darwinIsHost":true,"linuxIsHost":true,"win32Resolve":"C:\\Users\\Alice"},"win32 by getPlatform() alone":{"defaultMatchesExpected":true,"win32IsWin32":true,"darwinIsHost":true,"linuxIsHost":true,"win32Resolve":"C:\\Users\\Alice"}},
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
