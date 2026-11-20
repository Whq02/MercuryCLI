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
import {
  ensureDriveRootSeparator,
  expandTildeWithHome,
  extractDoubleSlashPatternRoot,
  extractPatternDriveRoot,
  foldCaseInsensitivePath,
  foldHostCaseInsensitivePath,
  foldHostPathCase,
  foldPathCase,
  hostOrWin32PathModule,
  hostPathSpellings,
  isEscapingRelativePath,
  isWindowsShareRooted,
  msysDrivePathToNative,
  nativeCwdFromRecordedShell,
  nativePathToShell,
  normalizeLocalDevicePath,
  normalizedDriveRoot,
  pathModuleFor,
  pathSeparatorRegex,
  picomatchPathOptions,
  posixToWin32Path,
  preferredHomeEnv,
  resolveLexicalOperandPath,
  samePathCase,
  shellPathToNative,
  splitPathFromRoot,
  stripExtendedLengthPrefixForPlatform,
  toNativeSeparators,
  toPosixSeparators,
  win32ToPosixPath,
} from '../../src/utils/platform/paths.js'
import { posixPathToWindowsPath, windowsPathToPosixPath } from '../../src/utils/windowsPaths.js'

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
        defaultMatchesHost: inputs.every(p => JSON.stringify(splitPathFromRoot(p)) === JSON.stringify(splitPathFromRoot(p, hostPath))),
        win32: inputs.map(p => splitPathFromRoot(p, pathWin32)),
        posix: inputs.map(p => splitPathFromRoot(p, pathPosix)),
      }
    },
    recorded: {"win32":{"defaultMatchesHost":true,"win32":[{"root":"C:\\","segments":["a","b"],"sep":"\\"},{"root":"C:/","segments":["a","b"],"sep":"\\"},{"root":"c:\\","segments":[],"sep":"\\"},{"root":"\\\\server\\share\\","segments":["d"],"sep":"\\"},{"root":"/","segments":["a","b"],"sep":"\\"},{"root":"/","segments":[],"sep":"\\"},{"root":"\\","segments":["rel","path"],"sep":"\\"},{"root":"\\","segments":[],"sep":"\\"}],"posix":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}]},"darwin":{"defaultMatchesHost":true,"win32":[{"root":"C:\\","segments":["a","b"],"sep":"\\"},{"root":"C:/","segments":["a","b"],"sep":"\\"},{"root":"c:\\","segments":[],"sep":"\\"},{"root":"\\\\server\\share\\","segments":["d"],"sep":"\\"},{"root":"/","segments":["a","b"],"sep":"\\"},{"root":"/","segments":[],"sep":"\\"},{"root":"\\","segments":["rel","path"],"sep":"\\"},{"root":"\\","segments":[],"sep":"\\"}],"posix":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}]},"linux":{"defaultMatchesHost":true,"win32":[{"root":"C:\\","segments":["a","b"],"sep":"\\"},{"root":"C:/","segments":["a","b"],"sep":"\\"},{"root":"c:\\","segments":[],"sep":"\\"},{"root":"\\\\server\\share\\","segments":["d"],"sep":"\\"},{"root":"/","segments":["a","b"],"sep":"\\"},{"root":"/","segments":[],"sep":"\\"},{"root":"\\","segments":["rel","path"],"sep":"\\"},{"root":"\\","segments":[],"sep":"\\"}],"posix":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}]},"win32 by process.platform alone":{"defaultMatchesHost":true,"win32":[{"root":"C:\\","segments":["a","b"],"sep":"\\"},{"root":"C:/","segments":["a","b"],"sep":"\\"},{"root":"c:\\","segments":[],"sep":"\\"},{"root":"\\\\server\\share\\","segments":["d"],"sep":"\\"},{"root":"/","segments":["a","b"],"sep":"\\"},{"root":"/","segments":[],"sep":"\\"},{"root":"\\","segments":["rel","path"],"sep":"\\"},{"root":"\\","segments":[],"sep":"\\"}],"posix":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}]},"win32 by getPlatform() alone":{"defaultMatchesHost":true,"win32":[{"root":"C:\\","segments":["a","b"],"sep":"\\"},{"root":"C:/","segments":["a","b"],"sep":"\\"},{"root":"c:\\","segments":[],"sep":"\\"},{"root":"\\\\server\\share\\","segments":["d"],"sep":"\\"},{"root":"/","segments":["a","b"],"sep":"\\"},{"root":"/","segments":[],"sep":"\\"},{"root":"\\","segments":["rel","path"],"sep":"\\"},{"root":"\\","segments":[],"sep":"\\"}],"posix":[{"root":"/","segments":["C:\\a\\b"],"sep":"/"},{"root":"/","segments":["C:","a","b"],"sep":"/"},{"root":"/","segments":["c:\\"],"sep":"/"},{"root":"/","segments":["\\\\server\\share\\d"],"sep":"/"},{"root":"/","segments":["a","b"],"sep":"/"},{"root":"/","segments":[],"sep":"/"},{"root":"/","segments":["rel","path"],"sep":"/"},{"root":"/","segments":[],"sep":"/"}]}},
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
  {
    name: 'paths.foldCaseInsensitivePath',
    answers: () => {
      const inputs = ['', 'C:\\Users\\Alice\\File.TS', '/Users/Alice/File.TS', '/home/alice/File.TS']
      return {
        default: inputs.map(p => foldCaseInsensitivePath(p)),
        win32: inputs.map(p => foldCaseInsensitivePath(p, 'win32')),
        darwin: inputs.map(p => foldCaseInsensitivePath(p, 'darwin')),
        linux: inputs.map(p => foldCaseInsensitivePath(p, 'linux')),
      }
    },
    recorded: {"win32":{"default":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"win32":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"darwin":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"linux":["","C:\\Users\\Alice\\File.TS","/Users/Alice/File.TS","/home/alice/File.TS"]},"darwin":{"default":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"win32":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"darwin":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"linux":["","C:\\Users\\Alice\\File.TS","/Users/Alice/File.TS","/home/alice/File.TS"]},"linux":{"default":["","C:\\Users\\Alice\\File.TS","/Users/Alice/File.TS","/home/alice/File.TS"],"win32":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"darwin":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"linux":["","C:\\Users\\Alice\\File.TS","/Users/Alice/File.TS","/home/alice/File.TS"]},"win32 by process.platform alone":{"default":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"win32":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"darwin":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"linux":["","C:\\Users\\Alice\\File.TS","/Users/Alice/File.TS","/home/alice/File.TS"]},"win32 by getPlatform() alone":{"default":["","C:\\Users\\Alice\\File.TS","/Users/Alice/File.TS","/home/alice/File.TS"],"win32":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"darwin":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"linux":["","C:\\Users\\Alice\\File.TS","/Users/Alice/File.TS","/home/alice/File.TS"]}},
  },
  {
    name: 'paths.foldHostCaseInsensitivePath',
    answers: () => {
      const inputs = ['', 'C:\\Users\\Alice\\File.TS', '/Users/Alice/File.TS', '/home/alice/File.TS']
      return {
        default: inputs.map(p => foldHostCaseInsensitivePath(p)),
        windows: inputs.map(p => foldHostCaseInsensitivePath(p, 'windows')),
        macos: inputs.map(p => foldHostCaseInsensitivePath(p, 'macos')),
        wsl: inputs.map(p => foldHostCaseInsensitivePath(p, 'wsl')),
        linux: inputs.map(p => foldHostCaseInsensitivePath(p, 'linux')),
      }
    },
    recorded: {"win32":{"default":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"windows":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"macos":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"wsl":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"linux":["","C:\\Users\\Alice\\File.TS","/Users/Alice/File.TS","/home/alice/File.TS"]},"darwin":{"default":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"windows":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"macos":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"wsl":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"linux":["","C:\\Users\\Alice\\File.TS","/Users/Alice/File.TS","/home/alice/File.TS"]},"linux":{"default":["","C:\\Users\\Alice\\File.TS","/Users/Alice/File.TS","/home/alice/File.TS"],"windows":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"macos":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"wsl":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"linux":["","C:\\Users\\Alice\\File.TS","/Users/Alice/File.TS","/home/alice/File.TS"]},"win32 by process.platform alone":{"default":["","C:\\Users\\Alice\\File.TS","/Users/Alice/File.TS","/home/alice/File.TS"],"windows":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"macos":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"wsl":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"linux":["","C:\\Users\\Alice\\File.TS","/Users/Alice/File.TS","/home/alice/File.TS"]},"win32 by getPlatform() alone":{"default":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"windows":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"macos":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"wsl":["","c:\\users\\alice\\file.ts","/users/alice/file.ts","/home/alice/file.ts"],"linux":["","C:\\Users\\Alice\\File.TS","/Users/Alice/File.TS","/home/alice/File.TS"]}},
  },
  {
    name: 'paths.shellPathToNative',
    answers: () => {
      const inputs = ['', '/c/Users/Alice', '/cygdrive/d/work/a.ts', '//server/share/dir', '/c', '/tmp/a']
      return {
        default: inputs.map(p => shellPathToNative(p)),
        windows: inputs.map(p => shellPathToNative(p, 'windows')),
        macos: inputs.map(p => shellPathToNative(p, 'macos')),
        linux: inputs.map(p => shellPathToNative(p, 'linux')),
      }
    },
    recorded: {"win32":{"default":["","C:\\Users\\Alice","D:\\work\\a.ts","\\\\server\\share\\dir","C:\\","\\tmp\\a"],"windows":["","C:\\Users\\Alice","D:\\work\\a.ts","\\\\server\\share\\dir","C:\\","\\tmp\\a"],"macos":["","/c/Users/Alice","/cygdrive/d/work/a.ts","//server/share/dir","/c","/tmp/a"],"linux":["","/c/Users/Alice","/cygdrive/d/work/a.ts","//server/share/dir","/c","/tmp/a"]},"darwin":{"default":["","/c/Users/Alice","/cygdrive/d/work/a.ts","//server/share/dir","/c","/tmp/a"],"windows":["","C:\\Users\\Alice","D:\\work\\a.ts","\\\\server\\share\\dir","C:\\","\\tmp\\a"],"macos":["","/c/Users/Alice","/cygdrive/d/work/a.ts","//server/share/dir","/c","/tmp/a"],"linux":["","/c/Users/Alice","/cygdrive/d/work/a.ts","//server/share/dir","/c","/tmp/a"]},"linux":{"default":["","/c/Users/Alice","/cygdrive/d/work/a.ts","//server/share/dir","/c","/tmp/a"],"windows":["","C:\\Users\\Alice","D:\\work\\a.ts","\\\\server\\share\\dir","C:\\","\\tmp\\a"],"macos":["","/c/Users/Alice","/cygdrive/d/work/a.ts","//server/share/dir","/c","/tmp/a"],"linux":["","/c/Users/Alice","/cygdrive/d/work/a.ts","//server/share/dir","/c","/tmp/a"]},"win32 by process.platform alone":{"default":["","/c/Users/Alice","/cygdrive/d/work/a.ts","//server/share/dir","/c","/tmp/a"],"windows":["","C:\\Users\\Alice","D:\\work\\a.ts","\\\\server\\share\\dir","C:\\","\\tmp\\a"],"macos":["","/c/Users/Alice","/cygdrive/d/work/a.ts","//server/share/dir","/c","/tmp/a"],"linux":["","/c/Users/Alice","/cygdrive/d/work/a.ts","//server/share/dir","/c","/tmp/a"]},"win32 by getPlatform() alone":{"default":["","C:\\Users\\Alice","D:\\work\\a.ts","\\\\server\\share\\dir","C:\\","\\tmp\\a"],"windows":["","C:\\Users\\Alice","D:\\work\\a.ts","\\\\server\\share\\dir","C:\\","\\tmp\\a"],"macos":["","/c/Users/Alice","/cygdrive/d/work/a.ts","//server/share/dir","/c","/tmp/a"],"linux":["","/c/Users/Alice","/cygdrive/d/work/a.ts","//server/share/dir","/c","/tmp/a"]}},
  },
  {
    name: 'paths.nativePathToShell',
    answers: () => {
      const inputs = ['', 'C:\\Users\\Alice\\a.ts', 'D:/work/dir', '\\\\server\\share\\file', '/tmp/a']
      return {
        default: inputs.map(p => nativePathToShell(p)),
        windows: inputs.map(p => nativePathToShell(p, 'windows')),
        macos: inputs.map(p => nativePathToShell(p, 'macos')),
        linux: inputs.map(p => nativePathToShell(p, 'linux')),
      }
    },
    recorded: {"win32":{"default":["","/c/Users/Alice/a.ts","/d/work/dir","//server/share/file","/tmp/a"],"windows":["","/c/Users/Alice/a.ts","/d/work/dir","//server/share/file","/tmp/a"],"macos":["","C:\\Users\\Alice\\a.ts","D:/work/dir","\\\\server\\share\\file","/tmp/a"],"linux":["","C:\\Users\\Alice\\a.ts","D:/work/dir","\\\\server\\share\\file","/tmp/a"]},"darwin":{"default":["","C:\\Users\\Alice\\a.ts","D:/work/dir","\\\\server\\share\\file","/tmp/a"],"windows":["","/c/Users/Alice/a.ts","/d/work/dir","//server/share/file","/tmp/a"],"macos":["","C:\\Users\\Alice\\a.ts","D:/work/dir","\\\\server\\share\\file","/tmp/a"],"linux":["","C:\\Users\\Alice\\a.ts","D:/work/dir","\\\\server\\share\\file","/tmp/a"]},"linux":{"default":["","C:\\Users\\Alice\\a.ts","D:/work/dir","\\\\server\\share\\file","/tmp/a"],"windows":["","/c/Users/Alice/a.ts","/d/work/dir","//server/share/file","/tmp/a"],"macos":["","C:\\Users\\Alice\\a.ts","D:/work/dir","\\\\server\\share\\file","/tmp/a"],"linux":["","C:\\Users\\Alice\\a.ts","D:/work/dir","\\\\server\\share\\file","/tmp/a"]},"win32 by process.platform alone":{"default":["","C:\\Users\\Alice\\a.ts","D:/work/dir","\\\\server\\share\\file","/tmp/a"],"windows":["","/c/Users/Alice/a.ts","/d/work/dir","//server/share/file","/tmp/a"],"macos":["","C:\\Users\\Alice\\a.ts","D:/work/dir","\\\\server\\share\\file","/tmp/a"],"linux":["","C:\\Users\\Alice\\a.ts","D:/work/dir","\\\\server\\share\\file","/tmp/a"]},"win32 by getPlatform() alone":{"default":["","/c/Users/Alice/a.ts","/d/work/dir","//server/share/file","/tmp/a"],"windows":["","/c/Users/Alice/a.ts","/d/work/dir","//server/share/file","/tmp/a"],"macos":["","C:\\Users\\Alice\\a.ts","D:/work/dir","\\\\server\\share\\file","/tmp/a"],"linux":["","C:\\Users\\Alice\\a.ts","D:/work/dir","\\\\server\\share\\file","/tmp/a"]}},
  },
  {
    name: 'paths.msysDrivePathToNative',
    answers: () => {
      const inputs = ['', '/c/Users/Alice', '/c', '/tmp/a', 'C:\\Users\\Alice']
      return {
        defaultStrict: inputs.map(p => msysDrivePathToNative(p, false)),
        defaultBare: inputs.map(p => msysDrivePathToNative(p, true)),
        win32Strict: inputs.map(p => msysDrivePathToNative(p, false, 'win32')),
        win32Bare: inputs.map(p => msysDrivePathToNative(p, true, 'win32')),
        linuxBare: inputs.map(p => msysDrivePathToNative(p, true, 'linux')),
      }
    },
    recorded: {"win32":{"defaultStrict":["","C:\\Users\\Alice","/c","/tmp/a","C:\\Users\\Alice"],"defaultBare":["","C:\\Users\\Alice","C:\\","/tmp/a","C:\\Users\\Alice"],"win32Strict":["","C:\\Users\\Alice","/c","/tmp/a","C:\\Users\\Alice"],"win32Bare":["","C:\\Users\\Alice","C:\\","/tmp/a","C:\\Users\\Alice"],"linuxBare":["","/c/Users/Alice","/c","/tmp/a","C:\\Users\\Alice"]},"darwin":{"defaultStrict":["","/c/Users/Alice","/c","/tmp/a","C:\\Users\\Alice"],"defaultBare":["","/c/Users/Alice","/c","/tmp/a","C:\\Users\\Alice"],"win32Strict":["","C:\\Users\\Alice","/c","/tmp/a","C:\\Users\\Alice"],"win32Bare":["","C:\\Users\\Alice","C:\\","/tmp/a","C:\\Users\\Alice"],"linuxBare":["","/c/Users/Alice","/c","/tmp/a","C:\\Users\\Alice"]},"linux":{"defaultStrict":["","/c/Users/Alice","/c","/tmp/a","C:\\Users\\Alice"],"defaultBare":["","/c/Users/Alice","/c","/tmp/a","C:\\Users\\Alice"],"win32Strict":["","C:\\Users\\Alice","/c","/tmp/a","C:\\Users\\Alice"],"win32Bare":["","C:\\Users\\Alice","C:\\","/tmp/a","C:\\Users\\Alice"],"linuxBare":["","/c/Users/Alice","/c","/tmp/a","C:\\Users\\Alice"]},"win32 by process.platform alone":{"defaultStrict":["","C:\\Users\\Alice","/c","/tmp/a","C:\\Users\\Alice"],"defaultBare":["","C:\\Users\\Alice","C:\\","/tmp/a","C:\\Users\\Alice"],"win32Strict":["","C:\\Users\\Alice","/c","/tmp/a","C:\\Users\\Alice"],"win32Bare":["","C:\\Users\\Alice","C:\\","/tmp/a","C:\\Users\\Alice"],"linuxBare":["","/c/Users/Alice","/c","/tmp/a","C:\\Users\\Alice"]},"win32 by getPlatform() alone":{"defaultStrict":["","/c/Users/Alice","/c","/tmp/a","C:\\Users\\Alice"],"defaultBare":["","/c/Users/Alice","/c","/tmp/a","C:\\Users\\Alice"],"win32Strict":["","C:\\Users\\Alice","/c","/tmp/a","C:\\Users\\Alice"],"win32Bare":["","C:\\Users\\Alice","C:\\","/tmp/a","C:\\Users\\Alice"],"linuxBare":["","/c/Users/Alice","/c","/tmp/a","C:\\Users\\Alice"]}},
  },
  {
    name: 'paths.hostPathSpellings',
    answers: () => {
      const inputs = ['C:\\Users\\Alice', '/Users/Alice', '']
      return {
        default: inputs.map(p => hostPathSpellings(p)),
        win32: inputs.map(p => hostPathSpellings(p, 'win32')),
        darwin: inputs.map(p => hostPathSpellings(p, 'darwin')),
        linux: inputs.map(p => hostPathSpellings(p, 'linux')),
      }
    },
    recorded: {"win32":{"default":[["C:\\Users\\Alice","/c/Users/Alice"],["/Users/Alice","/Users/Alice"],["",""]],"win32":[["C:\\Users\\Alice","/c/Users/Alice"],["/Users/Alice","/Users/Alice"],["",""]],"darwin":[["C:\\Users\\Alice"],["/Users/Alice"],[""]],"linux":[["C:\\Users\\Alice"],["/Users/Alice"],[""]]},"darwin":{"default":[["C:\\Users\\Alice"],["/Users/Alice"],[""]],"win32":[["C:\\Users\\Alice","/c/Users/Alice"],["/Users/Alice","/Users/Alice"],["",""]],"darwin":[["C:\\Users\\Alice"],["/Users/Alice"],[""]],"linux":[["C:\\Users\\Alice"],["/Users/Alice"],[""]]},"linux":{"default":[["C:\\Users\\Alice"],["/Users/Alice"],[""]],"win32":[["C:\\Users\\Alice","/c/Users/Alice"],["/Users/Alice","/Users/Alice"],["",""]],"darwin":[["C:\\Users\\Alice"],["/Users/Alice"],[""]],"linux":[["C:\\Users\\Alice"],["/Users/Alice"],[""]]},"win32 by process.platform alone":{"default":[["C:\\Users\\Alice","/c/Users/Alice"],["/Users/Alice","/Users/Alice"],["",""]],"win32":[["C:\\Users\\Alice","/c/Users/Alice"],["/Users/Alice","/Users/Alice"],["",""]],"darwin":[["C:\\Users\\Alice"],["/Users/Alice"],[""]],"linux":[["C:\\Users\\Alice"],["/Users/Alice"],[""]]},"win32 by getPlatform() alone":{"default":[["C:\\Users\\Alice"],["/Users/Alice"],[""]],"win32":[["C:\\Users\\Alice","/c/Users/Alice"],["/Users/Alice","/Users/Alice"],["",""]],"darwin":[["C:\\Users\\Alice"],["/Users/Alice"],[""]],"linux":[["C:\\Users\\Alice"],["/Users/Alice"],[""]]}},
  },
  {
    name: 'paths.nativeCwdFromRecordedShell',
    answers: () => {
      const inputs = ['', '  /tmp/work \n', '/c/Users/Alice\n', '/c/Users/Alice\nC:\\Users\\Alice\n', '/usr/bin\n']
      return {
        defaultTrim: inputs.map(r => nativeCwdFromRecordedShell(r, true)),
        defaultNoTrim: inputs.map(r => nativeCwdFromRecordedShell(r, false)),
        windows: inputs.map(r => nativeCwdFromRecordedShell(r, true, 'windows')),
        linuxNoTrim: inputs.map(r => nativeCwdFromRecordedShell(r, false, 'linux')),
      }
    },
    recorded: {"win32":{"defaultTrim":[{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"},{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"/usr/bin is an MSYS virtual root the converter cannot place (it would become the drive-relative \\usr\\bin); the shell's own Win32 spelling (pwd -W) was not recorded"}],"defaultNoTrim":[{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"},{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"/usr/bin is an MSYS virtual root the converter cannot place (it would become the drive-relative \\usr\\bin); the shell's own Win32 spelling (pwd -W) was not recorded"}],"windows":[{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"},{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"/usr/bin is an MSYS virtual root the converter cannot place (it would become the drive-relative \\usr\\bin); the shell's own Win32 spelling (pwd -W) was not recorded"}],"linuxNoTrim":[{"path":""},{"path":"  /tmp/work \n"},{"path":"/c/Users/Alice\n"},{"path":"/c/Users/Alice\nC:\\Users\\Alice\n"},{"path":"/usr/bin\n"}]},"darwin":{"defaultTrim":[{"path":""},{"path":"/tmp/work"},{"path":"/c/Users/Alice"},{"path":"/c/Users/Alice\nC:\\Users\\Alice"},{"path":"/usr/bin"}],"defaultNoTrim":[{"path":""},{"path":"  /tmp/work \n"},{"path":"/c/Users/Alice\n"},{"path":"/c/Users/Alice\nC:\\Users\\Alice\n"},{"path":"/usr/bin\n"}],"windows":[{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"},{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"/usr/bin is an MSYS virtual root the converter cannot place (it would become the drive-relative \\usr\\bin); the shell's own Win32 spelling (pwd -W) was not recorded"}],"linuxNoTrim":[{"path":""},{"path":"  /tmp/work \n"},{"path":"/c/Users/Alice\n"},{"path":"/c/Users/Alice\nC:\\Users\\Alice\n"},{"path":"/usr/bin\n"}]},"linux":{"defaultTrim":[{"path":""},{"path":"/tmp/work"},{"path":"/c/Users/Alice"},{"path":"/c/Users/Alice\nC:\\Users\\Alice"},{"path":"/usr/bin"}],"defaultNoTrim":[{"path":""},{"path":"  /tmp/work \n"},{"path":"/c/Users/Alice\n"},{"path":"/c/Users/Alice\nC:\\Users\\Alice\n"},{"path":"/usr/bin\n"}],"windows":[{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"},{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"/usr/bin is an MSYS virtual root the converter cannot place (it would become the drive-relative \\usr\\bin); the shell's own Win32 spelling (pwd -W) was not recorded"}],"linuxNoTrim":[{"path":""},{"path":"  /tmp/work \n"},{"path":"/c/Users/Alice\n"},{"path":"/c/Users/Alice\nC:\\Users\\Alice\n"},{"path":"/usr/bin\n"}]},"win32 by process.platform alone":{"defaultTrim":[{"path":""},{"path":"/tmp/work"},{"path":"/c/Users/Alice"},{"path":"/c/Users/Alice\nC:\\Users\\Alice"},{"path":"/usr/bin"}],"defaultNoTrim":[{"path":""},{"path":"  /tmp/work \n"},{"path":"/c/Users/Alice\n"},{"path":"/c/Users/Alice\nC:\\Users\\Alice\n"},{"path":"/usr/bin\n"}],"windows":[{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"},{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"/usr/bin is an MSYS virtual root the converter cannot place (it would become the drive-relative \\usr\\bin); the shell's own Win32 spelling (pwd -W) was not recorded"}],"linuxNoTrim":[{"path":""},{"path":"  /tmp/work \n"},{"path":"/c/Users/Alice\n"},{"path":"/c/Users/Alice\nC:\\Users\\Alice\n"},{"path":"/usr/bin\n"}]},"win32 by getPlatform() alone":{"defaultTrim":[{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"},{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"/usr/bin is an MSYS virtual root the converter cannot place (it would become the drive-relative \\usr\\bin); the shell's own Win32 spelling (pwd -W) was not recorded"}],"defaultNoTrim":[{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"},{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"/usr/bin is an MSYS virtual root the converter cannot place (it would become the drive-relative \\usr\\bin); the shell's own Win32 spelling (pwd -W) was not recorded"}],"windows":[{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"},{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"/usr/bin is an MSYS virtual root the converter cannot place (it would become the drive-relative \\usr\\bin); the shell's own Win32 spelling (pwd -W) was not recorded"}],"linuxNoTrim":[{"path":""},{"path":"  /tmp/work \n"},{"path":"/c/Users/Alice\n"},{"path":"/c/Users/Alice\nC:\\Users\\Alice\n"},{"path":"/usr/bin\n"}]}},
  },
  {
    name: 'paths.normalizeLocalDevicePath',
    answers: () => {
      const inputs = ['', '\\\\?\\c:\\Users\\Alice', '\\\\.\\D:/work', '\\\\localhost\\c$\\Users', '//127.0.0.1/d$/a/b', '///tmp/a', '/tmp/a']
      return {
        default: inputs.map(p => normalizeLocalDevicePath(p)),
        windows: inputs.map(p => normalizeLocalDevicePath(p, 'windows')),
        macos: inputs.map(p => normalizeLocalDevicePath(p, 'macos')),
        linux: inputs.map(p => normalizeLocalDevicePath(p, 'linux')),
      }
    },
    recorded: {"win32":{"default":["","C:\\Users\\Alice","D:\\work","C:\\Users","D:\\a\\b","///tmp/a","/tmp/a"],"windows":["","C:\\Users\\Alice","D:\\work","C:\\Users","D:\\a\\b","///tmp/a","/tmp/a"],"macos":["","\\\\?\\c:\\Users\\Alice","\\\\.\\D:/work","\\\\localhost\\c$\\Users","/127.0.0.1/d$/a/b","/tmp/a","/tmp/a"],"linux":["","\\\\?\\c:\\Users\\Alice","\\\\.\\D:/work","\\\\localhost\\c$\\Users","/127.0.0.1/d$/a/b","/tmp/a","/tmp/a"]},"darwin":{"default":["","\\\\?\\c:\\Users\\Alice","\\\\.\\D:/work","\\\\localhost\\c$\\Users","/127.0.0.1/d$/a/b","/tmp/a","/tmp/a"],"windows":["","C:\\Users\\Alice","D:\\work","C:\\Users","D:\\a\\b","///tmp/a","/tmp/a"],"macos":["","\\\\?\\c:\\Users\\Alice","\\\\.\\D:/work","\\\\localhost\\c$\\Users","/127.0.0.1/d$/a/b","/tmp/a","/tmp/a"],"linux":["","\\\\?\\c:\\Users\\Alice","\\\\.\\D:/work","\\\\localhost\\c$\\Users","/127.0.0.1/d$/a/b","/tmp/a","/tmp/a"]},"linux":{"default":["","\\\\?\\c:\\Users\\Alice","\\\\.\\D:/work","\\\\localhost\\c$\\Users","/127.0.0.1/d$/a/b","/tmp/a","/tmp/a"],"windows":["","C:\\Users\\Alice","D:\\work","C:\\Users","D:\\a\\b","///tmp/a","/tmp/a"],"macos":["","\\\\?\\c:\\Users\\Alice","\\\\.\\D:/work","\\\\localhost\\c$\\Users","/127.0.0.1/d$/a/b","/tmp/a","/tmp/a"],"linux":["","\\\\?\\c:\\Users\\Alice","\\\\.\\D:/work","\\\\localhost\\c$\\Users","/127.0.0.1/d$/a/b","/tmp/a","/tmp/a"]},"win32 by process.platform alone":{"default":["","\\\\?\\c:\\Users\\Alice","\\\\.\\D:/work","\\\\localhost\\c$\\Users","/127.0.0.1/d$/a/b","/tmp/a","/tmp/a"],"windows":["","C:\\Users\\Alice","D:\\work","C:\\Users","D:\\a\\b","///tmp/a","/tmp/a"],"macos":["","\\\\?\\c:\\Users\\Alice","\\\\.\\D:/work","\\\\localhost\\c$\\Users","/127.0.0.1/d$/a/b","/tmp/a","/tmp/a"],"linux":["","\\\\?\\c:\\Users\\Alice","\\\\.\\D:/work","\\\\localhost\\c$\\Users","/127.0.0.1/d$/a/b","/tmp/a","/tmp/a"]},"win32 by getPlatform() alone":{"default":["","C:\\Users\\Alice","D:\\work","C:\\Users","D:\\a\\b","///tmp/a","/tmp/a"],"windows":["","C:\\Users\\Alice","D:\\work","C:\\Users","D:\\a\\b","///tmp/a","/tmp/a"],"macos":["","\\\\?\\c:\\Users\\Alice","\\\\.\\D:/work","\\\\localhost\\c$\\Users","/127.0.0.1/d$/a/b","/tmp/a","/tmp/a"],"linux":["","\\\\?\\c:\\Users\\Alice","\\\\.\\D:/work","\\\\localhost\\c$\\Users","/127.0.0.1/d$/a/b","/tmp/a","/tmp/a"]}},
  },
  {
    name: 'paths.toNativeSeparators',
    answers: () => {
      const inputs = ['', 'C:/Users/Alice/Repo', '/Users/Alice/Repo', 'a/b\\c']
      return {
        default: inputs.map(p => toNativeSeparators(p)),
        win32: inputs.map(p => toNativeSeparators(p, 'win32')),
        darwin: inputs.map(p => toNativeSeparators(p, 'darwin')),
        linux: inputs.map(p => toNativeSeparators(p, 'linux')),
      }
    },
    recorded: {"win32":{"default":["","C:\\Users\\Alice\\Repo","\\Users\\Alice\\Repo","a\\b\\c"],"win32":["","C:\\Users\\Alice\\Repo","\\Users\\Alice\\Repo","a\\b\\c"],"darwin":["","C:/Users/Alice/Repo","/Users/Alice/Repo","a/b\\c"],"linux":["","C:/Users/Alice/Repo","/Users/Alice/Repo","a/b\\c"]},"darwin":{"default":["","C:/Users/Alice/Repo","/Users/Alice/Repo","a/b\\c"],"win32":["","C:\\Users\\Alice\\Repo","\\Users\\Alice\\Repo","a\\b\\c"],"darwin":["","C:/Users/Alice/Repo","/Users/Alice/Repo","a/b\\c"],"linux":["","C:/Users/Alice/Repo","/Users/Alice/Repo","a/b\\c"]},"linux":{"default":["","C:/Users/Alice/Repo","/Users/Alice/Repo","a/b\\c"],"win32":["","C:\\Users\\Alice\\Repo","\\Users\\Alice\\Repo","a\\b\\c"],"darwin":["","C:/Users/Alice/Repo","/Users/Alice/Repo","a/b\\c"],"linux":["","C:/Users/Alice/Repo","/Users/Alice/Repo","a/b\\c"]},"win32 by process.platform alone":{"default":["","C:\\Users\\Alice\\Repo","\\Users\\Alice\\Repo","a\\b\\c"],"win32":["","C:\\Users\\Alice\\Repo","\\Users\\Alice\\Repo","a\\b\\c"],"darwin":["","C:/Users/Alice/Repo","/Users/Alice/Repo","a/b\\c"],"linux":["","C:/Users/Alice/Repo","/Users/Alice/Repo","a/b\\c"]},"win32 by getPlatform() alone":{"default":["","C:/Users/Alice/Repo","/Users/Alice/Repo","a/b\\c"],"win32":["","C:\\Users\\Alice\\Repo","\\Users\\Alice\\Repo","a\\b\\c"],"darwin":["","C:/Users/Alice/Repo","/Users/Alice/Repo","a/b\\c"],"linux":["","C:/Users/Alice/Repo","/Users/Alice/Repo","a/b\\c"]}},
  },
  {
    name: 'paths.isWindowsShareRooted',
    answers: () => {
      const inputs = ['', '\\\\server\\share', '//server/share', '\\/?\\C:\\x', '/\\.\\pipe\\x', '\\/', '/server/share', 'C:\\dir']
      return {
        defaultMixed: inputs.map(p => isWindowsShareRooted(p, true)),
        defaultSamePair: inputs.map(p => isWindowsShareRooted(p, false)),
        windowsMixed: inputs.map(p => isWindowsShareRooted(p, true, 'windows')),
        windowsSamePair: inputs.map(p => isWindowsShareRooted(p, false, 'windows')),
        macosMixed: inputs.map(p => isWindowsShareRooted(p, true, 'macos')),
        linuxSamePair: inputs.map(p => isWindowsShareRooted(p, false, 'linux')),
      }
    },
    recorded: {"win32":{"defaultMixed":[false,true,true,true,true,true,false,false],"defaultSamePair":[false,true,true,false,false,false,false,false],"windowsMixed":[false,true,true,true,true,true,false,false],"windowsSamePair":[false,true,true,false,false,false,false,false],"macosMixed":[false,false,false,false,false,false,false,false],"linuxSamePair":[false,false,false,false,false,false,false,false]},"darwin":{"defaultMixed":[false,false,false,false,false,false,false,false],"defaultSamePair":[false,false,false,false,false,false,false,false],"windowsMixed":[false,true,true,true,true,true,false,false],"windowsSamePair":[false,true,true,false,false,false,false,false],"macosMixed":[false,false,false,false,false,false,false,false],"linuxSamePair":[false,false,false,false,false,false,false,false]},"linux":{"defaultMixed":[false,false,false,false,false,false,false,false],"defaultSamePair":[false,false,false,false,false,false,false,false],"windowsMixed":[false,true,true,true,true,true,false,false],"windowsSamePair":[false,true,true,false,false,false,false,false],"macosMixed":[false,false,false,false,false,false,false,false],"linuxSamePair":[false,false,false,false,false,false,false,false]},"win32 by process.platform alone":{"defaultMixed":[false,false,false,false,false,false,false,false],"defaultSamePair":[false,false,false,false,false,false,false,false],"windowsMixed":[false,true,true,true,true,true,false,false],"windowsSamePair":[false,true,true,false,false,false,false,false],"macosMixed":[false,false,false,false,false,false,false,false],"linuxSamePair":[false,false,false,false,false,false,false,false]},"win32 by getPlatform() alone":{"defaultMixed":[false,true,true,true,true,true,false,false],"defaultSamePair":[false,true,true,false,false,false,false,false],"windowsMixed":[false,true,true,true,true,true,false,false],"windowsSamePair":[false,true,true,false,false,false,false,false],"macosMixed":[false,false,false,false,false,false,false,false],"linuxSamePair":[false,false,false,false,false,false,false,false]}},
  },
  {
    name: 'paths.picomatchPathOptions',
    answers: () => ({
      default: picomatchPathOptions(),
      win32: picomatchPathOptions('win32'),
      darwin: picomatchPathOptions('darwin'),
      linux: picomatchPathOptions('linux'),
    }),
    recorded: {"win32":{"default":{"dot":true,"nocase":true},"win32":{"dot":true,"nocase":true},"darwin":{"dot":true,"nocase":false},"linux":{"dot":true,"nocase":false}},"darwin":{"default":{"dot":true,"nocase":false},"win32":{"dot":true,"nocase":true},"darwin":{"dot":true,"nocase":false},"linux":{"dot":true,"nocase":false}},"linux":{"default":{"dot":true,"nocase":false},"win32":{"dot":true,"nocase":true},"darwin":{"dot":true,"nocase":false},"linux":{"dot":true,"nocase":false}},"win32 by process.platform alone":{"default":{"dot":true,"nocase":true},"win32":{"dot":true,"nocase":true},"darwin":{"dot":true,"nocase":false},"linux":{"dot":true,"nocase":false}},"win32 by getPlatform() alone":{"default":{"dot":true,"nocase":false},"win32":{"dot":true,"nocase":true},"darwin":{"dot":true,"nocase":false},"linux":{"dot":true,"nocase":false}}},
  },
  {
    name: 'paths.normalizedDriveRoot',
    answers: () => {
      const inputs = ['', '/a/b', 'C:/Users/Alice', 'd:/', 'C:', 'rel/path']
      return {
        default: inputs.map(p => normalizedDriveRoot(p)),
        windows: inputs.map(p => normalizedDriveRoot(p, 'windows')),
        macos: inputs.map(p => normalizedDriveRoot(p, 'macos')),
        linux: inputs.map(p => normalizedDriveRoot(p, 'linux')),
      }
    },
    recorded: {"win32":{"default":[null,"/","C:/","d:/",null,null],"windows":[null,"/","C:/","d:/",null,null],"macos":[null,"/",null,null,null,null],"linux":[null,"/",null,null,null,null]},"darwin":{"default":[null,"/",null,null,null,null],"windows":[null,"/","C:/","d:/",null,null],"macos":[null,"/",null,null,null,null],"linux":[null,"/",null,null,null,null]},"linux":{"default":[null,"/",null,null,null,null],"windows":[null,"/","C:/","d:/",null,null],"macos":[null,"/",null,null,null,null],"linux":[null,"/",null,null,null,null]},"win32 by process.platform alone":{"default":[null,"/",null,null,null,null],"windows":[null,"/","C:/","d:/",null,null],"macos":[null,"/",null,null,null,null],"linux":[null,"/",null,null,null,null]},"win32 by getPlatform() alone":{"default":[null,"/","C:/","d:/",null,null],"windows":[null,"/","C:/","d:/",null,null],"macos":[null,"/",null,null,null,null],"linux":[null,"/",null,null,null,null]}},
  },
  {
    name: 'paths.ensureDriveRootSeparator',
    answers: () => {
      const inputs = ['', 'C:', 'd:', 'C:\\', 'C:/dir', '/tmp']
      return {
        default: inputs.map(p => ensureDriveRootSeparator(p)),
        windows: inputs.map(p => ensureDriveRootSeparator(p, 'windows')),
        macos: inputs.map(p => ensureDriveRootSeparator(p, 'macos')),
        linux: inputs.map(p => ensureDriveRootSeparator(p, 'linux')),
      }
    },
    recorded: {"win32":{"default":["","C:\\","d:\\","C:\\","C:/dir","/tmp"],"windows":["","C:\\","d:\\","C:\\","C:/dir","/tmp"],"macos":["","C:","d:","C:\\","C:/dir","/tmp"],"linux":["","C:","d:","C:\\","C:/dir","/tmp"]},"darwin":{"default":["","C:","d:","C:\\","C:/dir","/tmp"],"windows":["","C:\\","d:\\","C:\\","C:/dir","/tmp"],"macos":["","C:","d:","C:\\","C:/dir","/tmp"],"linux":["","C:","d:","C:\\","C:/dir","/tmp"]},"linux":{"default":["","C:","d:","C:\\","C:/dir","/tmp"],"windows":["","C:\\","d:\\","C:\\","C:/dir","/tmp"],"macos":["","C:","d:","C:\\","C:/dir","/tmp"],"linux":["","C:","d:","C:\\","C:/dir","/tmp"]},"win32 by process.platform alone":{"default":["","C:","d:","C:\\","C:/dir","/tmp"],"windows":["","C:\\","d:\\","C:\\","C:/dir","/tmp"],"macos":["","C:","d:","C:\\","C:/dir","/tmp"],"linux":["","C:","d:","C:\\","C:/dir","/tmp"]},"win32 by getPlatform() alone":{"default":["","C:\\","d:\\","C:\\","C:/dir","/tmp"],"windows":["","C:\\","d:\\","C:\\","C:/dir","/tmp"],"macos":["","C:","d:","C:\\","C:/dir","/tmp"],"linux":["","C:","d:","C:\\","C:/dir","/tmp"]}},
  },
  {
    name: 'paths.pathSeparatorRegex',
    answers: () => ({
      default: pathSeparatorRegex(),
      windows: pathSeparatorRegex('windows'),
      macos: pathSeparatorRegex('macos'),
      linux: pathSeparatorRegex('linux'),
    }),
    recorded: {"win32":{"default":"/[/\\\\]/g","windows":"/[/\\\\]/g","macos":"/\\//g","linux":"/\\//g"},"darwin":{"default":"/\\//g","windows":"/[/\\\\]/g","macos":"/\\//g","linux":"/\\//g"},"linux":{"default":"/\\//g","windows":"/[/\\\\]/g","macos":"/\\//g","linux":"/\\//g"},"win32 by process.platform alone":{"default":"/\\//g","windows":"/[/\\\\]/g","macos":"/\\//g","linux":"/\\//g"},"win32 by getPlatform() alone":{"default":"/[/\\\\]/g","windows":"/[/\\\\]/g","macos":"/\\//g","linux":"/\\//g"}},
  },
  {
    name: 'paths.expandTildeWithHome',
    answers: () => {
      const inputs = ['', '~', '~/src', '~\\src', '~other/src', '/tmp']
      return {
        default: inputs.map(p => expandTildeWithHome(p, '/h')),
        windows: inputs.map(p => expandTildeWithHome(p, 'C:\\Users\\Alice', 'windows')),
        macos: inputs.map(p => expandTildeWithHome(p, '/Users/alice', 'macos')),
        linux: inputs.map(p => expandTildeWithHome(p, '/home/alice', 'linux')),
      }
    },
    recorded: {"win32":{"default":["","/h","/h/src","/h\\src","~other/src","/tmp"],"windows":["","C:\\Users\\Alice","C:\\Users\\Alice/src","C:\\Users\\Alice\\src","~other/src","/tmp"],"macos":["","/Users/alice","/Users/alice/src","~\\src","~other/src","/tmp"],"linux":["","/home/alice","/home/alice/src","~\\src","~other/src","/tmp"]},"darwin":{"default":["","/h","/h/src","~\\src","~other/src","/tmp"],"windows":["","C:\\Users\\Alice","C:\\Users\\Alice/src","C:\\Users\\Alice\\src","~other/src","/tmp"],"macos":["","/Users/alice","/Users/alice/src","~\\src","~other/src","/tmp"],"linux":["","/home/alice","/home/alice/src","~\\src","~other/src","/tmp"]},"linux":{"default":["","/h","/h/src","~\\src","~other/src","/tmp"],"windows":["","C:\\Users\\Alice","C:\\Users\\Alice/src","C:\\Users\\Alice\\src","~other/src","/tmp"],"macos":["","/Users/alice","/Users/alice/src","~\\src","~other/src","/tmp"],"linux":["","/home/alice","/home/alice/src","~\\src","~other/src","/tmp"]},"win32 by process.platform alone":{"default":["","/h","/h/src","~\\src","~other/src","/tmp"],"windows":["","C:\\Users\\Alice","C:\\Users\\Alice/src","C:\\Users\\Alice\\src","~other/src","/tmp"],"macos":["","/Users/alice","/Users/alice/src","~\\src","~other/src","/tmp"],"linux":["","/home/alice","/home/alice/src","~\\src","~other/src","/tmp"]},"win32 by getPlatform() alone":{"default":["","/h","/h/src","/h\\src","~other/src","/tmp"],"windows":["","C:\\Users\\Alice","C:\\Users\\Alice/src","C:\\Users\\Alice\\src","~other/src","/tmp"],"macos":["","/Users/alice","/Users/alice/src","~\\src","~other/src","/tmp"],"linux":["","/home/alice","/home/alice/src","~\\src","~other/src","/tmp"]}},
  },
  {
    name: 'paths.preferredHomeEnv',
    answers: () => {
      const envs: NodeJS.ProcessEnv[] = [
        { HOME: '/home/a', USERPROFILE: 'C:\\Users\\A' },
        { HOME: '/home/a' },
        { USERPROFILE: 'C:\\Users\\A' },
        {},
      ]
      return {
        default: envs.map(e => preferredHomeEnv(e)),
        windows: envs.map(e => preferredHomeEnv(e, 'windows')),
        macos: envs.map(e => preferredHomeEnv(e, 'macos')),
        linux: envs.map(e => preferredHomeEnv(e, 'linux')),
      }
    },
    recorded: {"win32":{"default":["C:\\Users\\A","/home/a","C:\\Users\\A",""],"windows":["C:\\Users\\A","/home/a","C:\\Users\\A",""],"macos":["/home/a","/home/a","C:\\Users\\A",""],"linux":["/home/a","/home/a","C:\\Users\\A",""]},"darwin":{"default":["/home/a","/home/a","C:\\Users\\A",""],"windows":["C:\\Users\\A","/home/a","C:\\Users\\A",""],"macos":["/home/a","/home/a","C:\\Users\\A",""],"linux":["/home/a","/home/a","C:\\Users\\A",""]},"linux":{"default":["/home/a","/home/a","C:\\Users\\A",""],"windows":["C:\\Users\\A","/home/a","C:\\Users\\A",""],"macos":["/home/a","/home/a","C:\\Users\\A",""],"linux":["/home/a","/home/a","C:\\Users\\A",""]},"win32 by process.platform alone":{"default":["/home/a","/home/a","C:\\Users\\A",""],"windows":["C:\\Users\\A","/home/a","C:\\Users\\A",""],"macos":["/home/a","/home/a","C:\\Users\\A",""],"linux":["/home/a","/home/a","C:\\Users\\A",""]},"win32 by getPlatform() alone":{"default":["C:\\Users\\A","/home/a","C:\\Users\\A",""],"windows":["C:\\Users\\A","/home/a","C:\\Users\\A",""],"macos":["/home/a","/home/a","C:\\Users\\A",""],"linux":["/home/a","/home/a","C:\\Users\\A",""]}},
  },
  {
    name: 'paths.resolveLexicalOperandPath',
    answers: () => {
      const pairs: ReadonlyArray<[string, string]> = [
        ['/Users/alice/proj', '../other'],
        ['/Users/alice/proj', '/etc/hosts'],
        ['C:\\Users\\Alice\\proj', '..\\other'],
        ['C:\\Users\\Alice\\proj', 'D:\\work\\a'],
        ['C:\\Users\\Alice\\proj', '/tmp'],
      ]
      return {
        default: pairs.map(([cwd, op]) => resolveLexicalOperandPath(cwd, op)),
        windows: pairs.map(([cwd, op]) => resolveLexicalOperandPath(cwd, op, 'windows')),
        macos: pairs.map(([cwd, op]) => resolveLexicalOperandPath(cwd, op, 'macos')),
        linux: pairs.map(([cwd, op]) => resolveLexicalOperandPath(cwd, op, 'linux')),
      }
    },
    recorded: {"win32":{"default":["\\Users\\alice\\other","/etc/hosts","C:\\Users\\Alice\\other","D:\\work\\a","/tmp"],"windows":["\\Users\\alice\\other","/etc/hosts","C:\\Users\\Alice\\other","D:\\work\\a","/tmp"],"macos":["/Users/alice/other","/etc/hosts","/C:\\Users\\Alice\\proj/..\\other","/C:\\Users\\Alice\\proj/D:\\work\\a","/tmp"],"linux":["/Users/alice/other","/etc/hosts","/C:\\Users\\Alice\\proj/..\\other","/C:\\Users\\Alice\\proj/D:\\work\\a","/tmp"]},"darwin":{"default":["/Users/alice/other","/etc/hosts","/C:\\Users\\Alice\\proj/..\\other","/C:\\Users\\Alice\\proj/D:\\work\\a","/tmp"],"windows":["\\Users\\alice\\other","/etc/hosts","C:\\Users\\Alice\\other","D:\\work\\a","/tmp"],"macos":["/Users/alice/other","/etc/hosts","/C:\\Users\\Alice\\proj/..\\other","/C:\\Users\\Alice\\proj/D:\\work\\a","/tmp"],"linux":["/Users/alice/other","/etc/hosts","/C:\\Users\\Alice\\proj/..\\other","/C:\\Users\\Alice\\proj/D:\\work\\a","/tmp"]},"linux":{"default":["/Users/alice/other","/etc/hosts","/C:\\Users\\Alice\\proj/..\\other","/C:\\Users\\Alice\\proj/D:\\work\\a","/tmp"],"windows":["\\Users\\alice\\other","/etc/hosts","C:\\Users\\Alice\\other","D:\\work\\a","/tmp"],"macos":["/Users/alice/other","/etc/hosts","/C:\\Users\\Alice\\proj/..\\other","/C:\\Users\\Alice\\proj/D:\\work\\a","/tmp"],"linux":["/Users/alice/other","/etc/hosts","/C:\\Users\\Alice\\proj/..\\other","/C:\\Users\\Alice\\proj/D:\\work\\a","/tmp"]},"win32 by process.platform alone":{"default":["/Users/alice/other","/etc/hosts","/C:\\Users\\Alice\\proj/..\\other","/C:\\Users\\Alice\\proj/D:\\work\\a","/tmp"],"windows":["\\Users\\alice\\other","/etc/hosts","C:\\Users\\Alice\\other","D:\\work\\a","/tmp"],"macos":["/Users/alice/other","/etc/hosts","/C:\\Users\\Alice\\proj/..\\other","/C:\\Users\\Alice\\proj/D:\\work\\a","/tmp"],"linux":["/Users/alice/other","/etc/hosts","/C:\\Users\\Alice\\proj/..\\other","/C:\\Users\\Alice\\proj/D:\\work\\a","/tmp"]},"win32 by getPlatform() alone":{"default":["\\Users\\alice\\other","/etc/hosts","C:\\Users\\Alice\\other","D:\\work\\a","/tmp"],"windows":["\\Users\\alice\\other","/etc/hosts","C:\\Users\\Alice\\other","D:\\work\\a","/tmp"],"macos":["/Users/alice/other","/etc/hosts","/C:\\Users\\Alice\\proj/..\\other","/C:\\Users\\Alice\\proj/D:\\work\\a","/tmp"],"linux":["/Users/alice/other","/etc/hosts","/C:\\Users\\Alice\\proj/..\\other","/C:\\Users\\Alice\\proj/D:\\work\\a","/tmp"]}},
  },
  {
    name: 'paths.foldHostPathCase',
    answers: () => {
      const inputs = ['', 'C:\\Users\\Alice', '/Users/Alice', 'File.TS']
      return {
        default: inputs.map(p => foldHostPathCase(p)),
        windows: inputs.map(p => foldHostPathCase(p, 'windows')),
        macos: inputs.map(p => foldHostPathCase(p, 'macos')),
        linux: inputs.map(p => foldHostPathCase(p, 'linux')),
      }
    },
    recorded: {"win32":{"default":["","c:\\users\\alice","/users/alice","file.ts"],"windows":["","c:\\users\\alice","/users/alice","file.ts"],"macos":["","C:\\Users\\Alice","/Users/Alice","File.TS"],"linux":["","C:\\Users\\Alice","/Users/Alice","File.TS"]},"darwin":{"default":["","C:\\Users\\Alice","/Users/Alice","File.TS"],"windows":["","c:\\users\\alice","/users/alice","file.ts"],"macos":["","C:\\Users\\Alice","/Users/Alice","File.TS"],"linux":["","C:\\Users\\Alice","/Users/Alice","File.TS"]},"linux":{"default":["","C:\\Users\\Alice","/Users/Alice","File.TS"],"windows":["","c:\\users\\alice","/users/alice","file.ts"],"macos":["","C:\\Users\\Alice","/Users/Alice","File.TS"],"linux":["","C:\\Users\\Alice","/Users/Alice","File.TS"]},"win32 by process.platform alone":{"default":["","C:\\Users\\Alice","/Users/Alice","File.TS"],"windows":["","c:\\users\\alice","/users/alice","file.ts"],"macos":["","C:\\Users\\Alice","/Users/Alice","File.TS"],"linux":["","C:\\Users\\Alice","/Users/Alice","File.TS"]},"win32 by getPlatform() alone":{"default":["","c:\\users\\alice","/users/alice","file.ts"],"windows":["","c:\\users\\alice","/users/alice","file.ts"],"macos":["","C:\\Users\\Alice","/Users/Alice","File.TS"],"linux":["","C:\\Users\\Alice","/Users/Alice","File.TS"]}},
  },
  {
    name: 'paths.isEscapingRelativePath',
    answers: () => {
      const inputs = ['', '..', '../a', '..\\a', '..foo', 'a/../b']
      return {
        default: inputs.map(p => isEscapingRelativePath(p)),
        windows: inputs.map(p => isEscapingRelativePath(p, 'windows')),
        macos: inputs.map(p => isEscapingRelativePath(p, 'macos')),
        linux: inputs.map(p => isEscapingRelativePath(p, 'linux')),
      }
    },
    recorded: {"win32":{"default":[false,true,true,true,false,false],"windows":[false,true,true,true,false,false],"macos":[false,true,true,false,false,false],"linux":[false,true,true,false,false,false]},"darwin":{"default":[false,true,true,false,false,false],"windows":[false,true,true,true,false,false],"macos":[false,true,true,false,false,false],"linux":[false,true,true,false,false,false]},"linux":{"default":[false,true,true,false,false,false],"windows":[false,true,true,true,false,false],"macos":[false,true,true,false,false,false],"linux":[false,true,true,false,false,false]},"win32 by process.platform alone":{"default":[false,true,true,false,false,false],"windows":[false,true,true,true,false,false],"macos":[false,true,true,false,false,false],"linux":[false,true,true,false,false,false]},"win32 by getPlatform() alone":{"default":[false,true,true,true,false,false],"windows":[false,true,true,true,false,false],"macos":[false,true,true,false,false,false],"linux":[false,true,true,false,false,false]}},
  },
  {
    name: 'paths.extractPatternDriveRoot',
    answers: () => {
      const inputs = ['', 'C:\\Users\\Alice/**', '/d:/work/a', '/Users/alice/**', 'src/*.ts']
      return {
        default: inputs.map(p => extractPatternDriveRoot(p, '/')),
        windowsWinSep: inputs.map(p => extractPatternDriveRoot(p, '\\', 'windows')),
        windowsPosixSep: inputs.map(p => extractPatternDriveRoot(p, '/', 'windows')),
        macos: inputs.map(p => extractPatternDriveRoot(p, '/', 'macos')),
        linux: inputs.map(p => extractPatternDriveRoot(p, '/', 'linux')),
      }
    },
    recorded: {"win32":{"default":[null,{"root":"C:/","relative":"Users/Alice/**"},{"root":"D:/","relative":"work/a"},null,null],"windowsWinSep":[null,{"root":"C:\\","relative":"Users/Alice/**"},{"root":"D:\\","relative":"work/a"},null,null],"windowsPosixSep":[null,{"root":"C:/","relative":"Users/Alice/**"},{"root":"D:/","relative":"work/a"},null,null],"macos":[null,null,null,null,null],"linux":[null,null,null,null,null]},"darwin":{"default":[null,null,null,null,null],"windowsWinSep":[null,{"root":"C:\\","relative":"Users/Alice/**"},{"root":"D:\\","relative":"work/a"},null,null],"windowsPosixSep":[null,{"root":"C:/","relative":"Users/Alice/**"},{"root":"D:/","relative":"work/a"},null,null],"macos":[null,null,null,null,null],"linux":[null,null,null,null,null]},"linux":{"default":[null,null,null,null,null],"windowsWinSep":[null,{"root":"C:\\","relative":"Users/Alice/**"},{"root":"D:\\","relative":"work/a"},null,null],"windowsPosixSep":[null,{"root":"C:/","relative":"Users/Alice/**"},{"root":"D:/","relative":"work/a"},null,null],"macos":[null,null,null,null,null],"linux":[null,null,null,null,null]},"win32 by process.platform alone":{"default":[null,null,null,null,null],"windowsWinSep":[null,{"root":"C:\\","relative":"Users/Alice/**"},{"root":"D:\\","relative":"work/a"},null,null],"windowsPosixSep":[null,{"root":"C:/","relative":"Users/Alice/**"},{"root":"D:/","relative":"work/a"},null,null],"macos":[null,null,null,null,null],"linux":[null,null,null,null,null]},"win32 by getPlatform() alone":{"default":[null,{"root":"C:/","relative":"Users/Alice/**"},{"root":"D:/","relative":"work/a"},null,null],"windowsWinSep":[null,{"root":"C:\\","relative":"Users/Alice/**"},{"root":"D:\\","relative":"work/a"},null,null],"windowsPosixSep":[null,{"root":"C:/","relative":"Users/Alice/**"},{"root":"D:/","relative":"work/a"},null,null],"macos":[null,null,null,null,null],"linux":[null,null,null,null,null]}},
  },
  {
    name: 'paths.extractDoubleSlashPatternRoot',
    answers: () => {
      const inputs = ['//c/Users/Alice/**', '//Users/alice/**', '//D/work']
      return {
        default: inputs.map(p => extractDoubleSlashPatternRoot(p, '/')),
        windowsWinSep: inputs.map(p => extractDoubleSlashPatternRoot(p, '\\', 'windows')),
        windowsPosixSep: inputs.map(p => extractDoubleSlashPatternRoot(p, '/', 'windows')),
        macos: inputs.map(p => extractDoubleSlashPatternRoot(p, '/', 'macos')),
        linux: inputs.map(p => extractDoubleSlashPatternRoot(p, '/', 'linux')),
      }
    },
    recorded: {"win32":{"default":[{"root":"C:/","relative":"Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"D:/","relative":"work"}],"windowsWinSep":[{"root":"C:\\","relative":"Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"D:\\","relative":"work"}],"windowsPosixSep":[{"root":"C:/","relative":"Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"D:/","relative":"work"}],"macos":[{"root":"/","relative":"/c/Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"/","relative":"/D/work"}],"linux":[{"root":"/","relative":"/c/Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"/","relative":"/D/work"}]},"darwin":{"default":[{"root":"/","relative":"/c/Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"/","relative":"/D/work"}],"windowsWinSep":[{"root":"C:\\","relative":"Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"D:\\","relative":"work"}],"windowsPosixSep":[{"root":"C:/","relative":"Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"D:/","relative":"work"}],"macos":[{"root":"/","relative":"/c/Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"/","relative":"/D/work"}],"linux":[{"root":"/","relative":"/c/Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"/","relative":"/D/work"}]},"linux":{"default":[{"root":"/","relative":"/c/Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"/","relative":"/D/work"}],"windowsWinSep":[{"root":"C:\\","relative":"Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"D:\\","relative":"work"}],"windowsPosixSep":[{"root":"C:/","relative":"Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"D:/","relative":"work"}],"macos":[{"root":"/","relative":"/c/Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"/","relative":"/D/work"}],"linux":[{"root":"/","relative":"/c/Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"/","relative":"/D/work"}]},"win32 by process.platform alone":{"default":[{"root":"/","relative":"/c/Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"/","relative":"/D/work"}],"windowsWinSep":[{"root":"C:\\","relative":"Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"D:\\","relative":"work"}],"windowsPosixSep":[{"root":"C:/","relative":"Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"D:/","relative":"work"}],"macos":[{"root":"/","relative":"/c/Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"/","relative":"/D/work"}],"linux":[{"root":"/","relative":"/c/Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"/","relative":"/D/work"}]},"win32 by getPlatform() alone":{"default":[{"root":"C:/","relative":"Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"D:/","relative":"work"}],"windowsWinSep":[{"root":"C:\\","relative":"Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"D:\\","relative":"work"}],"windowsPosixSep":[{"root":"C:/","relative":"Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"D:/","relative":"work"}],"macos":[{"root":"/","relative":"/c/Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"/","relative":"/D/work"}],"linux":[{"root":"/","relative":"/c/Users/Alice/**"},{"root":"/","relative":"/Users/alice/**"},{"root":"/","relative":"/D/work"}]}},
  },
  {
    name: 'paths.posixWin32ConversionParity',
    answers: () => {
      const inputs = ['//server/share', '/cygdrive/c/x', '/c', '/c/x', 'relative/x', 'C:\\x', '\\\\server\\share']
      return {
        toWin32: inputs.map(p => posixToWin32Path(p)),
        toWin32Memo: inputs.map(p => posixPathToWindowsPath(p)),
        toPosix: inputs.map(p => win32ToPosixPath(p)),
        toPosixMemo: inputs.map(p => windowsPathToPosixPath(p)),
      }
    },
    recorded: {"win32":{"toWin32":["\\\\server\\share","C:\\x","C:\\","C:\\x","relative\\x","C:\\x","\\\\server\\share"],"toWin32Memo":["\\\\server\\share","C:\\x","C:\\","C:\\x","relative\\x","C:\\x","\\\\server\\share"],"toPosix":["//server/share","/cygdrive/c/x","/c","/c/x","relative/x","/c/x","//server/share"],"toPosixMemo":["//server/share","/cygdrive/c/x","/c","/c/x","relative/x","/c/x","//server/share"]},"darwin":{"toWin32":["\\\\server\\share","C:\\x","C:\\","C:\\x","relative\\x","C:\\x","\\\\server\\share"],"toWin32Memo":["\\\\server\\share","C:\\x","C:\\","C:\\x","relative\\x","C:\\x","\\\\server\\share"],"toPosix":["//server/share","/cygdrive/c/x","/c","/c/x","relative/x","/c/x","//server/share"],"toPosixMemo":["//server/share","/cygdrive/c/x","/c","/c/x","relative/x","/c/x","//server/share"]},"linux":{"toWin32":["\\\\server\\share","C:\\x","C:\\","C:\\x","relative\\x","C:\\x","\\\\server\\share"],"toWin32Memo":["\\\\server\\share","C:\\x","C:\\","C:\\x","relative\\x","C:\\x","\\\\server\\share"],"toPosix":["//server/share","/cygdrive/c/x","/c","/c/x","relative/x","/c/x","//server/share"],"toPosixMemo":["//server/share","/cygdrive/c/x","/c","/c/x","relative/x","/c/x","//server/share"]},"win32 by process.platform alone":{"toWin32":["\\\\server\\share","C:\\x","C:\\","C:\\x","relative\\x","C:\\x","\\\\server\\share"],"toWin32Memo":["\\\\server\\share","C:\\x","C:\\","C:\\x","relative\\x","C:\\x","\\\\server\\share"],"toPosix":["//server/share","/cygdrive/c/x","/c","/c/x","relative/x","/c/x","//server/share"],"toPosixMemo":["//server/share","/cygdrive/c/x","/c","/c/x","relative/x","/c/x","//server/share"]},"win32 by getPlatform() alone":{"toWin32":["\\\\server\\share","C:\\x","C:\\","C:\\x","relative\\x","C:\\x","\\\\server\\share"],"toWin32Memo":["\\\\server\\share","C:\\x","C:\\","C:\\x","relative\\x","C:\\x","\\\\server\\share"],"toPosix":["//server/share","/cygdrive/c/x","/c","/c/x","relative/x","/c/x","//server/share"],"toPosixMemo":["//server/share","/cygdrive/c/x","/c","/c/x","relative/x","/c/x","//server/share"]}},
  },
]

import { chmodSync as p02ChmodSync, mkdirSync as p02MkdirSync, mkdtempSync as p02MkdtempSync, rmSync as p02RmSync, writeFileSync as p02WriteFileSync } from 'node:fs'
import { tmpdir as p02Tmpdir } from 'node:os'
import * as p02Path from 'node:path'
import {
  envPathDirs,
  executableName,
  executableSuffixes,
  hasRequiredProgramExtension,
  hostOsFamily,
  hostPathDelimiter,
  isExecutableFile,
  isExecutablePath,
  missingSpawnCommandError,
  normalizedOsPlatform,
  packPlatformFor,
  pathDelimiter,
  pathExtensions,
  pathExtensionsForName,
  pathLookupExtensions,
  resolveProgramInPath,
  spawnableCommandSpellings,
  vendoredNodeRelativePath,
  vendorPlatformTag,
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
    name: 'programs: venvPythonPath',
    answers: () => venvPythonPath('/proj/.venv').replaceAll('\\', '/'),
    recorded: {"win32":"/proj/.venv/Scripts/python.exe","darwin":"/proj/.venv/bin/python","linux":"/proj/.venv/bin/python","win32 by process.platform alone":"/proj/.venv/Scripts/python.exe","win32 by getPlatform() alone":"/proj/.venv/bin/python"},
  },
  {
    name: 'programs: missingSpawnCommandError',
    answers: () =>
      withProgramFixture(dir => {
        const codeOf = (err: NodeJS.ErrnoException | null): string | null => err?.code ?? null
        const env: NodeJS.ProcessEnv = { Path: dir, PATHEXT: '.EXE;.CMD;.CUSTOM' }
        return {
          missingBare: codeOf(missingSpawnCommandError('definitely-absent-279', env, dir)),
          missingExplicit: codeOf(missingSpawnCommandError(p02Path.join(dir, 'nope'), env, dir)),
          empty: codeOf(missingSpawnCommandError('', env, dir)),
          foundExe: codeOf(missingSpawnCommandError('run-x', env, dir)),
          foundShim: codeOf(missingSpawnCommandError('shim', env, dir)),
          foundExplicit: codeOf(missingSpawnCommandError(p02Path.join(dir, 'run-x.exe'), env, dir)),
        }
      }),
    recorded: {"win32":{"missingBare":"ENOENT","missingExplicit":"ENOENT","empty":"ENOENT","foundExe":null,"foundShim":null,"foundExplicit":null},"darwin":{"missingBare":null,"missingExplicit":null,"empty":null,"foundExe":null,"foundShim":null,"foundExplicit":null},"linux":{"missingBare":null,"missingExplicit":null,"empty":null,"foundExe":null,"foundShim":null,"foundExplicit":null},"win32 by process.platform alone":{"missingBare":"ENOENT","missingExplicit":"ENOENT","empty":"ENOENT","foundExe":null,"foundShim":null,"foundExplicit":null},"win32 by getPlatform() alone":{"missingBare":null,"missingExplicit":null,"empty":null,"foundExe":null,"foundShim":null,"foundExplicit":null}},
  },
  {
    name: 'programs: packPlatformFor, vendorPlatformTag, hostOsFamily and normalizedOsPlatform',
    answers: () => ({
      pack: ['arm64', 'x64', 'ia32'].map(arch => packPlatformFor(process.platform, arch)),
      packExplicit: [packPlatformFor('freebsd', 'x64'), packPlatformFor('win32', 'arm64')],
      vendorTag: ['arm64', 'x64'].map(arch => vendorPlatformTag(process.platform, arch)),
      hostOs: hostOsFamily(),
      hostOsExplicit: [hostOsFamily('freebsd'), hostOsFamily('win32'), hostOsFamily('darwin')],
      normOs: normalizedOsPlatform(),
      normOsExplicit: [normalizedOsPlatform('freebsd'), normalizedOsPlatform('win32'), normalizedOsPlatform('darwin')],
    }),
    recorded: {"win32":{"pack":["win-arm64","win-x64",null],"packExplicit":[null,"win-arm64"],"vendorTag":["win-arm64","win-x64"],"hostOs":"windows","hostOsExplicit":["linux","windows","darwin"],"normOs":"win32","normOsExplicit":["linux","win32","darwin"]},"darwin":{"pack":["darwin-arm64","darwin-x64",null],"packExplicit":[null,"win-arm64"],"vendorTag":["darwin-arm64","darwin-x64"],"hostOs":"darwin","hostOsExplicit":["linux","windows","darwin"],"normOs":"darwin","normOsExplicit":["linux","win32","darwin"]},"linux":{"pack":["linux-arm64","linux-x64",null],"packExplicit":[null,"win-arm64"],"vendorTag":["linux-arm64","linux-x64"],"hostOs":"linux","hostOsExplicit":["linux","windows","darwin"],"normOs":"linux","normOsExplicit":["linux","win32","darwin"]},"win32 by process.platform alone":{"pack":["win-arm64","win-x64",null],"packExplicit":[null,"win-arm64"],"vendorTag":["win-arm64","win-x64"],"hostOs":"windows","hostOsExplicit":["linux","windows","darwin"],"normOs":"win32","normOsExplicit":["linux","win32","darwin"]},"win32 by getPlatform() alone":{"pack":["linux-arm64","linux-x64",null],"packExplicit":[null,"win-arm64"],"vendorTag":["linux-arm64","linux-x64"],"hostOs":"linux","hostOsExplicit":["linux","windows","darwin"],"normOs":"linux","normOsExplicit":["linux","win32","darwin"]}},
  },
  {
    name: 'programs: pathExtensionsForName, pathLookupExtensions and hasRequiredProgramExtension',
    answers: () => ({
      bareDefault: pathExtensionsForName('vitest', {}),
      withExt: pathExtensionsForName('vitest.CMD', {}),
      customPathext: pathExtensionsForName('jest', { PATHEXT: '.EXE;.cmd;;.BAT' }),
      lookupDefault: pathLookupExtensions({}),
      lookupCustom: pathLookupExtensions({ PATHEXT: '.EXE;;.CMD' }),
      hasExt: ['/usr/bin/ls', 'C:\\bin\\ls.exe', 'C:\\bin\\ls'].map(p => hasRequiredProgramExtension(p)),
    }),
    recorded: {"win32":{"bareDefault":[".com",".COM",".exe",".EXE",".bat",".BAT",".cmd",".CMD"],"withExt":[""],"customPathext":[".exe",".EXE",".cmd",".bat",".BAT"],"lookupDefault":[".EXE",".CMD",".BAT",".COM",""],"lookupCustom":[".EXE",".CMD",""],"hasExt":[false,true,false]},"darwin":{"bareDefault":[""],"withExt":[""],"customPathext":[""],"lookupDefault":[""],"lookupCustom":[""],"hasExt":[true,true,true]},"linux":{"bareDefault":[""],"withExt":[""],"customPathext":[""],"lookupDefault":[""],"lookupCustom":[""],"hasExt":[true,true,true]},"win32 by process.platform alone":{"bareDefault":[".com",".COM",".exe",".EXE",".bat",".BAT",".cmd",".CMD"],"withExt":[""],"customPathext":[".exe",".EXE",".cmd",".bat",".BAT"],"lookupDefault":[".EXE",".CMD",".BAT",".COM",""],"lookupCustom":[".EXE",".CMD",""],"hasExt":[false,true,false]},"win32 by getPlatform() alone":{"bareDefault":[""],"withExt":[""],"customPathext":[""],"lookupDefault":[""],"lookupCustom":[""],"hasExt":[true,true,true]}},
  },
]

import {
  commandByteBudget,
  commandShellArgv,
  commandShellOption,
  decodeShellScriptBytes,
  editorInvocationOf,
  editorShellCommandLine,
  envVarKey,
  executableNeedsVerbatimArgs,
  extraToolShellDefaults,
  guiEditorSpawnSpec,
  headlessGitDefaults,
  hostScriptDialect,
  hostShellHint,
  isBatchShim,
  isPlatformAskpassVar,
  loginPathOverride,
  mergeLoginPath,
  parseEditorCommandLine,
  promptEditorSpawnSpec,
  shellBinarySpec,
  shellCommandSpec,
  shimShellOption,
  terminalEditorSpawnSpec,
  toolShellEnvKey,
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
  {
    name: 'spawn.parseEditorCommandLine',
    answers: () => [
      parseEditorCommandLine('"C:\\Program Files\\Code\\code.exe" --wait', { platform: process.platform, path: '' }),
      parseEditorCommandLine("vim -u 'NONE'", { platform: process.platform, path: '' }),
      parseEditorCommandLine('nano', { platform: process.platform, path: '' }),
    ],
    recorded: {"win32":[{"executable":"C:\\Program Files\\Code\\code.exe","args":["--wait"]},{"executable":"vim","args":["-u","'NONE'"]},{"executable":"nano","args":[]}],"darwin":[{"executable":"C:\\Program Files\\Code\\code.exe","args":["--wait"]},{"executable":"vim","args":["-u","NONE"]},{"executable":"nano","args":[]}],"linux":[{"executable":"C:\\Program Files\\Code\\code.exe","args":["--wait"]},{"executable":"vim","args":["-u","NONE"]},{"executable":"nano","args":[]}],"win32 by process.platform alone":[{"executable":"C:\\Program Files\\Code\\code.exe","args":["--wait"]},{"executable":"vim","args":["-u","'NONE'"]},{"executable":"nano","args":[]}],"win32 by getPlatform() alone":[{"executable":"C:\\Program Files\\Code\\code.exe","args":["--wait"]},{"executable":"vim","args":["-u","NONE"]},{"executable":"nano","args":[]}]},
  },
  {
    name: 'spawn.editorInvocationOf',
    answers: () => [
      editorInvocationOf('C:\\Program Files\\ed.exe', 'C:\\Program Files\\ed.exe', { executable: 'C:\\Program Files\\ed.exe', args: ['--wait'] }),
      editorInvocationOf('code', 'code -w', { executable: 'code', args: [] }),
    ],
    recorded: {"win32":[{"executablePath":"C:\\Program Files\\ed.exe","args":["--wait"]},{"executablePath":"code","args":["-w"]}],"darwin":[{"executablePath":"C:Program","args":["Filesed.exe"]},{"executablePath":"code","args":["-w"]}],"linux":[{"executablePath":"C:Program","args":["Filesed.exe"]},{"executablePath":"code","args":["-w"]}],"win32 by process.platform alone":[{"executablePath":"C:\\Program Files\\ed.exe","args":["--wait"]},{"executablePath":"code","args":["-w"]}],"win32 by getPlatform() alone":[{"executablePath":"C:Program","args":["Filesed.exe"]},{"executablePath":"code","args":["-w"]}]},
  },
  {
    name: 'spawn.editorShellCommandLine',
    answers: () => [
      editorShellCommandLine('/usr/bin/vim', ['-n'], "/tmp/a'b.txt"),
      editorShellCommandLine('C:\\bin\\code.cmd', ['-w'], 'C:\\Users\\100%\\a.txt'),
    ],
    recorded: {"win32":["\"/usr/bin/vim\" \"-n\" \"%MERCURY_EDITOR_FILE%\"","\"C:\\bin\\code.cmd\" \"-w\" \"%MERCURY_EDITOR_FILE%\""],"darwin":["\"/usr/bin/vim\" \"-n\" '/tmp/a'\\''b.txt'","\"C:\\bin\\code.cmd\" \"-w\" 'C:\\Users\\100%\\a.txt'"],"linux":["\"/usr/bin/vim\" \"-n\" '/tmp/a'\\''b.txt'","\"C:\\bin\\code.cmd\" \"-w\" 'C:\\Users\\100%\\a.txt'"],"win32 by process.platform alone":["\"/usr/bin/vim\" \"-n\" \"%MERCURY_EDITOR_FILE%\"","\"C:\\bin\\code.cmd\" \"-w\" \"%MERCURY_EDITOR_FILE%\""],"win32 by getPlatform() alone":["\"/usr/bin/vim\" \"-n\" '/tmp/a'\\''b.txt'","\"C:\\bin\\code.cmd\" \"-w\" 'C:\\Users\\100%\\a.txt'"]},
  },
  {
    name: 'spawn.promptEditorSpawnSpec',
    answers: () => [
      promptEditorSpawnSpec('C:\\bin\\code.cmd', ['-w'], 'C:\\tmp\\p.txt', 'C:\\Windows\\System32\\cmd.exe'),
      promptEditorSpawnSpec('C:\\bin\\code.cmd', ['-w'], 'C:\\tmp\\p.txt', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
      promptEditorSpawnSpec('/usr/bin/vim', [], "/tmp/a'b.txt", undefined),
    ],
    recorded: {"win32":[{"shell":false,"file":"C:\\Windows\\System32\\cmd.exe","args":["/d","/v:off","/s","/c","\"\"C:\\bin\\code.cmd\" \"-w\" \"%MERCURY_EDITOR_FILE%\"\""],"windowsVerbatimArguments":true,"extraEnv":{"MERCURY_EDITOR_FILE":"C:\\tmp\\p.txt"}},{"shell":false,"file":"C:\\Program Files\\PowerShell\\7\\pwsh.exe","args":["-NoLogo","-NoProfile","-Command","& 'C:\\bin\\code.cmd' '-w' $env:MERCURY_EDITOR_FILE"],"windowsVerbatimArguments":false,"extraEnv":{"MERCURY_EDITOR_FILE":"C:\\tmp\\p.txt"}},{"shell":false,"file":"cmd.exe","args":["/d","/v:off","/s","/c","\"\"/usr/bin/vim\" \"%MERCURY_EDITOR_FILE%\"\""],"windowsVerbatimArguments":true,"extraEnv":{"MERCURY_EDITOR_FILE":"/tmp/a'b.txt"}}],"darwin":[{"shell":true,"commandLine":"\"C:\\bin\\code.cmd\" \"-w\" 'C:\\tmp\\p.txt'"},{"shell":true,"commandLine":"\"C:\\bin\\code.cmd\" \"-w\" 'C:\\tmp\\p.txt'"},{"shell":true,"commandLine":"\"/usr/bin/vim\" '/tmp/a'\\''b.txt'"}],"linux":[{"shell":true,"commandLine":"\"C:\\bin\\code.cmd\" \"-w\" 'C:\\tmp\\p.txt'"},{"shell":true,"commandLine":"\"C:\\bin\\code.cmd\" \"-w\" 'C:\\tmp\\p.txt'"},{"shell":true,"commandLine":"\"/usr/bin/vim\" '/tmp/a'\\''b.txt'"}],"win32 by process.platform alone":[{"shell":false,"file":"C:\\Windows\\System32\\cmd.exe","args":["/d","/v:off","/s","/c","\"\"C:\\bin\\code.cmd\" \"-w\" \"%MERCURY_EDITOR_FILE%\"\""],"windowsVerbatimArguments":true,"extraEnv":{"MERCURY_EDITOR_FILE":"C:\\tmp\\p.txt"}},{"shell":false,"file":"C:\\Program Files\\PowerShell\\7\\pwsh.exe","args":["-NoLogo","-NoProfile","-Command","& 'C:\\bin\\code.cmd' '-w' $env:MERCURY_EDITOR_FILE"],"windowsVerbatimArguments":false,"extraEnv":{"MERCURY_EDITOR_FILE":"C:\\tmp\\p.txt"}},{"shell":false,"file":"cmd.exe","args":["/d","/v:off","/s","/c","\"\"/usr/bin/vim\" \"%MERCURY_EDITOR_FILE%\"\""],"windowsVerbatimArguments":true,"extraEnv":{"MERCURY_EDITOR_FILE":"/tmp/a'b.txt"}}],"win32 by getPlatform() alone":[{"shell":true,"commandLine":"\"C:\\bin\\code.cmd\" \"-w\" 'C:\\tmp\\p.txt'"},{"shell":true,"commandLine":"\"C:\\bin\\code.cmd\" \"-w\" 'C:\\tmp\\p.txt'"},{"shell":true,"commandLine":"\"/usr/bin/vim\" '/tmp/a'\\''b.txt'"}]},
  },
  {
    name: 'spawn.guiEditorSpawnSpec',
    answers: () => [
      guiEditorSpawnSpec('C:\\Program Files\\Code\\code.exe', 'C:\\Program Files\\Code\\code.exe', [], ['-g', 'f.ts:10'], true),
      guiEditorSpawnSpec('code --reuse-window', 'code', ['--reuse-window'], ['-g', 'f.ts:10'], false),
    ],
    recorded: {"win32":[{"shell":true,"command":"\"C:\\Program Files\\Code\\code.exe\" \"-g\" \"f.ts:10\""},{"shell":true,"command":"\"code\" \"--reuse-window\" \"-g\" \"f.ts:10\""}],"darwin":[{"shell":false,"file":"C:\\Program Files\\Code\\code.exe","args":["-g","f.ts:10"]},{"shell":false,"file":"code","args":["--reuse-window","-g","f.ts:10"]}],"linux":[{"shell":false,"file":"C:\\Program Files\\Code\\code.exe","args":["-g","f.ts:10"]},{"shell":false,"file":"code","args":["--reuse-window","-g","f.ts:10"]}],"win32 by process.platform alone":[{"shell":true,"command":"\"C:\\Program Files\\Code\\code.exe\" \"-g\" \"f.ts:10\""},{"shell":true,"command":"\"code\" \"--reuse-window\" \"-g\" \"f.ts:10\""}],"win32 by getPlatform() alone":[{"shell":false,"file":"C:\\Program Files\\Code\\code.exe","args":["-g","f.ts:10"]},{"shell":false,"file":"code","args":["--reuse-window","-g","f.ts:10"]}]},
  },
  {
    name: 'spawn.terminalEditorSpawnSpec',
    answers: () => [
      terminalEditorSpawnSpec('vim -n', 'vim', ['-n'], ['+42'], '/tmp/a b.ts'),
      terminalEditorSpawnSpec('nano', 'nano', [], [], 'C:\\tmp\\a b.ts'),
    ],
    recorded: {"win32":[{"shell":true,"command":"vim -n +42 \"/tmp/a b.ts\""},{"shell":true,"command":"nano \"C:\\tmp\\a b.ts\""}],"darwin":[{"shell":false,"file":"vim","args":["-n","+42","/tmp/a b.ts"]},{"shell":false,"file":"nano","args":["C:\\tmp\\a b.ts"]}],"linux":[{"shell":false,"file":"vim","args":["-n","+42","/tmp/a b.ts"]},{"shell":false,"file":"nano","args":["C:\\tmp\\a b.ts"]}],"win32 by process.platform alone":[{"shell":true,"command":"vim -n +42 \"/tmp/a b.ts\""},{"shell":true,"command":"nano \"C:\\tmp\\a b.ts\""}],"win32 by getPlatform() alone":[{"shell":false,"file":"vim","args":["-n","+42","/tmp/a b.ts"]},{"shell":false,"file":"nano","args":["C:\\tmp\\a b.ts"]}]},
  },
  {
    name: 'spawn.isPlatformAskpassVar',
    answers: () => [
      isPlatformAskpassVar('DISPLAY', 'needs-to-be-defined'),
      isPlatformAskpassVar('display', 'needs-to-be-defined'),
      isPlatformAskpassVar('DISPLAY', ':0'),
      isPlatformAskpassVar('SSH_ASKPASS', 'C:\\Program Files\\Git\\mingw64\\bin\\git-askpass.exe'),
      isPlatformAskpassVar('git_askpass', '"/usr/libexec/git-core/git-gui--askpass"'),
      isPlatformAskpassVar('SSH_ASKPASS', '/usr/bin/my-askpass'),
      isPlatformAskpassVar('SSH_ASKPASS', undefined),
    ],
    recorded: {"win32":[true,true,false,true,true,false,false],"darwin":[false,false,false,false,false,false,false],"linux":[false,false,false,false,false,false,false],"win32 by process.platform alone":[true,true,false,true,true,false,false],"win32 by getPlatform() alone":[false,false,false,false,false,false,false]},
  },
  {
    name: 'spawn.envVarKey',
    answers: () => [envVarKey('Path'), envVarKey('PATH'), envVarKey('npm_config_yes')],
    recorded: {"win32":["PATH","PATH","NPM_CONFIG_YES"],"darwin":["Path","PATH","npm_config_yes"],"linux":["Path","PATH","npm_config_yes"],"win32 by process.platform alone":["PATH","PATH","NPM_CONFIG_YES"],"win32 by getPlatform() alone":["Path","PATH","npm_config_yes"]},
  },
  {
    name: 'spawn.toolShellEnvKey',
    answers: () => [toolShellEnvKey('Path'), toolShellEnvKey('npm_config_yes'), toolShellEnvKey('PNPM_CONFIG_FOO'), toolShellEnvKey('myVar')],
    recorded: {"win32":["PATH","NPM_CONFIG_YES","PNPM_CONFIG_FOO","MYVAR"],"darwin":["Path","NPM_CONFIG_YES","PNPM_CONFIG_FOO","myVar"],"linux":["Path","NPM_CONFIG_YES","PNPM_CONFIG_FOO","myVar"],"win32 by process.platform alone":["PATH","NPM_CONFIG_YES","PNPM_CONFIG_FOO","MYVAR"],"win32 by getPlatform() alone":["Path","NPM_CONFIG_YES","PNPM_CONFIG_FOO","myVar"]},
  },
  {
    name: 'spawn.extraToolShellDefaults',
    answers: () => extraToolShellDefaults(),
    recorded: {"win32":{"PYTHONIOENCODING":"utf-8","PYTHONUTF8":"1","LANG":"C.UTF-8","LC_ALL":"C.UTF-8","GCM_INTERACTIVE":"never"},"darwin":{},"linux":{},"win32 by process.platform alone":{"PYTHONIOENCODING":"utf-8","PYTHONUTF8":"1","LANG":"C.UTF-8","LC_ALL":"C.UTF-8","GCM_INTERACTIVE":"never"},"win32 by getPlatform() alone":{}},
  },
  {
    name: 'spawn.headlessGitDefaults',
    answers: () => headlessGitDefaults(),
    recorded: {"win32":{"GIT_ASKPASS":"","SSH_ASKPASS":"","GCM_INTERACTIVE":"never"},"darwin":{},"linux":{},"win32 by process.platform alone":{"GIT_ASKPASS":"","SSH_ASKPASS":"","GCM_INTERACTIVE":"never"},"win32 by getPlatform() alone":{}},
  },
  {
    name: 'spawn.mergeLoginPath',
    answers: () => [
      mergeLoginPath('/usr/bin:/bin', { PATH: '/opt/homebrew/bin:/usr/bin' }),
      mergeLoginPath('/custom:/usr/bin', { Path: '/extra:/usr/bin' }),
      mergeLoginPath('', { PATH: '/a:/b' }),
    ],
    recorded: {"win32":["/usr/bin:/bin:/opt/homebrew/bin","/custom:/usr/bin:/extra","/a:/b"],"darwin":["/bin:/opt/homebrew/bin:/usr/bin","/custom:/usr/bin","/a:/b"],"linux":["/bin:/opt/homebrew/bin:/usr/bin","/custom:/usr/bin","/a:/b"],"win32 by process.platform alone":["/usr/bin:/bin:/opt/homebrew/bin","/custom:/usr/bin:/extra","/a:/b"],"win32 by getPlatform() alone":["/bin:/opt/homebrew/bin:/usr/bin","/custom:/usr/bin","/a:/b"]},
  },
  {
    name: 'spawn.loginPathOverride',
    answers: () => loginPathOverride('/usr/bin', { PATH: '/opt/homebrew/bin:/usr/bin' }),
    recorded: {"win32":"undefined","darwin":"/opt/homebrew/bin:/usr/bin","linux":"/opt/homebrew/bin:/usr/bin","win32 by process.platform alone":"undefined","win32 by getPlatform() alone":"/opt/homebrew/bin:/usr/bin"},
  },
  {
    name: 'spawn.commandByteBudget',
    answers: () => commandByteBudget(6400, 4500),
    recorded: {"win32":6400,"darwin":4500,"linux":4500,"win32 by process.platform alone":6400,"win32 by getPlatform() alone":4500},
  },
  {
    name: 'spawn.decodeShellScriptBytes',
    answers: () => [
      decodeShellScriptBytes(Buffer.from('export A=1\r\nexport B=2\r\n', 'utf8')),
      decodeShellScriptBytes(Buffer.from('\uFEFFexport C=3\r\n', 'utf8')),
      decodeShellScriptBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('export D=4\r\n', 'utf16le')])),
    ],
    recorded: {"win32":["export A=1\nexport B=2","export C=3","export D=4"],"darwin":["export A=1\r\nexport B=2","export C=3","\ufffd\ufffde\u0000x\u0000p\u0000o\u0000r\u0000t\u0000 \u0000D\u0000=\u00004\u0000\r\u0000\n\u0000"],"linux":["export A=1\r\nexport B=2","export C=3","\ufffd\ufffde\u0000x\u0000p\u0000o\u0000r\u0000t\u0000 \u0000D\u0000=\u00004\u0000\r\u0000\n\u0000"],"win32 by process.platform alone":["export A=1\nexport B=2","export C=3","export D=4"],"win32 by getPlatform() alone":["export A=1\r\nexport B=2","export C=3","\ufffd\ufffde\u0000x\u0000p\u0000o\u0000r\u0000t\u0000 \u0000D\u0000=\u00004\u0000\r\u0000\n\u0000"]},
  },
]

import {
  ancestorPidsCommand,
  availableMemoryReader,
  canReraiseOwnSignal,
  childGetsOwnProcessGroup,
  isOwnKillExitCode,
  killSignalForChild,
  loadAverageSupported,
  msysSignalExitCode,
  parentPidProbeKind,
  posixExitSignalsCount,
  posixProcessTableSupported,
  processInstantStartForm,
  processListCommand,
  processQueryTool,
  processStartFormFor,
  processStartProbeKind,
  processTreeEndMethod,
  processUserSource,
  supportsGracefulSigterm,
  syncStartTokenSupported,
  wasEndedByProcessTreeKill,
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
  {
    name: 'availableMemoryReader',
    answers: stand => [availableMemoryReader(), availableMemoryReader(stand.node)],
    recorded: {"win32":["counter","counter"],"darwin":["vm_stat","vm_stat"],"linux":["meminfo","meminfo"],"win32 by process.platform alone":["counter","counter"],"win32 by getPlatform() alone":["meminfo","meminfo"]},
  },
  {
    name: 'processListCommand',
    answers: stand => [processListCommand(), processListCommand(stand.node)],
    recorded: {"win32":[{"file":"powershell.exe","args":["-NoProfile","-NonInteractive","-Command","Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }"],"timeoutMs":8000},{"file":"powershell.exe","args":["-NoProfile","-NonInteractive","-Command","Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }"],"timeoutMs":8000}],"darwin":[{"file":"ps","args":["-axo","pid=,command="],"timeoutMs":3000},{"file":"ps","args":["-axo","pid=,command="],"timeoutMs":3000}],"linux":[{"file":"ps","args":["-axo","pid=,command="],"timeoutMs":3000},{"file":"ps","args":["-axo","pid=,command="],"timeoutMs":3000}],"win32 by process.platform alone":[{"file":"powershell.exe","args":["-NoProfile","-NonInteractive","-Command","Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }"],"timeoutMs":8000},{"file":"powershell.exe","args":["-NoProfile","-NonInteractive","-Command","Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }"],"timeoutMs":8000}],"win32 by getPlatform() alone":[{"file":"ps","args":["-axo","pid=,command="],"timeoutMs":3000},{"file":"ps","args":["-axo","pid=,command="],"timeoutMs":3000}]},
  },
  {
    name: 'posixExitSignalsCount',
    answers: stand => [posixExitSignalsCount(), posixExitSignalsCount(stand.node)],
    recorded: {"win32":[false,false],"darwin":[true,true],"linux":[true,true],"win32 by process.platform alone":[false,false],"win32 by getPlatform() alone":[true,true]},
  },
  {
    name: 'isOwnKillExitCode',
    answers: stand => [
      isOwnKillExitCode(true, 1),
      isOwnKillExitCode(true, 137),
      isOwnKillExitCode(true, 0),
      isOwnKillExitCode(false, 1),
      isOwnKillExitCode(true, 1, stand.node),
    ],
    recorded: {"win32":[true,true,false,false,true],"darwin":[false,false,false,false,false],"linux":[false,false,false,false,false],"win32 by process.platform alone":[true,true,false,false,true],"win32 by getPlatform() alone":[false,false,false,false,false]},
  },
  {
    name: 'wasEndedByProcessTreeKill',
    answers: stand => [
      wasEndedByProcessTreeKill('SIGTERM', 0, null),
      wasEndedByProcessTreeKill(null, 1, 1),
      wasEndedByProcessTreeKill(null, 0, 1),
      wasEndedByProcessTreeKill(null, 1, 0),
      wasEndedByProcessTreeKill(null, 2, 1, stand.node),
    ],
    recorded: {"win32":[true,true,false,false,true],"darwin":[true,false,false,false,false],"linux":[true,false,false,false,false],"win32 by process.platform alone":[true,true,false,false,true],"win32 by getPlatform() alone":[true,false,false,false,false]},
  },
  {
    name: 'msysSignalExitCode',
    answers: stand => [
      msysSignalExitCode(9 * 256, true),
      msysSignalExitCode(9 * 256, false),
      msysSignalExitCode(1, true),
      msysSignalExitCode(65 * 256, true),
      msysSignalExitCode(15 * 256, true, stand.node),
    ],
    recorded: {"win32":[137,2304,1,16640,143],"darwin":[2304,2304,1,16640,3840],"linux":[2304,2304,1,16640,3840],"win32 by process.platform alone":[137,2304,1,16640,143],"win32 by getPlatform() alone":[2304,2304,1,16640,3840]},
  },
  {
    name: 'canReraiseOwnSignal',
    answers: stand => [canReraiseOwnSignal(), canReraiseOwnSignal(stand.node)],
    recorded: {"win32":[false,false],"darwin":[true,true],"linux":[true,true],"win32 by process.platform alone":[false,false],"win32 by getPlatform() alone":[true,true]},
  },
  {
    name: 'killSignalForChild',
    answers: stand => [
      killSignalForChild('SIGKILL'),
      killSignalForChild('SIGTERM'),
      killSignalForChild('SIGINT'),
      killSignalForChild('SIGKILL', stand.node),
    ],
    recorded: {"win32":["undefined","undefined","undefined","undefined"],"darwin":["SIGKILL","SIGTERM","SIGINT","SIGKILL"],"linux":["SIGKILL","SIGTERM","SIGINT","SIGKILL"],"win32 by process.platform alone":["undefined","undefined","undefined","undefined"],"win32 by getPlatform() alone":["SIGKILL","SIGTERM","SIGINT","SIGKILL"]},
  },
  {
    name: 'supportsGracefulSigterm',
    answers: stand => [supportsGracefulSigterm(), supportsGracefulSigterm(stand.node)],
    recorded: {"win32":[false,false],"darwin":[true,true],"linux":[true,true],"win32 by process.platform alone":[false,false],"win32 by getPlatform() alone":[true,true]},
  },
  {
    name: 'processTreeEndMethod',
    answers: stand => [processTreeEndMethod(), processTreeEndMethod(stand.node)],
    recorded: {"win32":["win32-taskkill","win32-taskkill"],"darwin":["posix-group","posix-group"],"linux":["posix-group","posix-group"],"win32 by process.platform alone":["win32-taskkill","win32-taskkill"],"win32 by getPlatform() alone":["posix-group","posix-group"]},
  },
  {
    name: 'ripgrep platformDir equal arms',
    answers: () => ['x64', 'arm64'].map(arch => `${arch}-${process.platform}`),
    recorded: {"win32":["x64-win32","arm64-win32"],"darwin":["x64-darwin","arm64-darwin"],"linux":["x64-linux","arm64-linux"],"win32 by process.platform alone":["x64-win32","arm64-win32"],"win32 by getPlatform() alone":["x64-linux","arm64-linux"]},
  },
  {
    name: 'posixProcessTableSupported',
    answers: stand => [posixProcessTableSupported(), posixProcessTableSupported(stand.node)],
    recorded: {"win32":[false,false],"darwin":[true,true],"linux":[true,true],"win32 by process.platform alone":[false,false],"win32 by getPlatform() alone":[true,true]},
  },
  {
    name: 'syncStartTokenSupported',
    answers: stand => [syncStartTokenSupported(), syncStartTokenSupported(stand.node)],
    recorded: {"win32":[false,false],"darwin":[true,true],"linux":[true,true],"win32 by process.platform alone":[false,false],"win32 by getPlatform() alone":[true,true]},
  },
  {
    name: 'loadAverageSupported',
    answers: stand => [loadAverageSupported(), loadAverageSupported(stand.node)],
    recorded: {"win32":[false,false],"darwin":[true,true],"linux":[true,true],"win32 by process.platform alone":[false,false],"win32 by getPlatform() alone":[true,true]},
  },
  {
    name: 'parentPidProbeKind',
    answers: stand => [parentPidProbeKind(), parentPidProbeKind(stand.node)],
    recorded: {"win32":["win32-ancestors","win32-ancestors"],"darwin":["posix-ps","posix-ps"],"linux":["posix-ps","posix-ps"],"win32 by process.platform alone":["win32-ancestors","win32-ancestors"],"win32 by getPlatform() alone":["posix-ps","posix-ps"]},
  },
  {
    name: 'ancestorPidsCommand',
    answers: stand => [ancestorPidsCommand(42, 5), ancestorPidsCommand(42, 5, stand.node)],
    recorded: {"win32":[{"file":"powershell.exe","args":["-NoProfile","-NonInteractive","-Command","$p=42;$out=@();for($i=0;$i -lt 5;$i++){$proc=Get-CimInstance Win32_Process -Filter \"ProcessId=$p\" -ErrorAction SilentlyContinue;if(-not $proc){break};$pp=$proc.ParentProcessId;if(-not $pp -or $pp -eq 0){break};$out+=$pp;$p=$pp};$out -join ','"]},{"file":"powershell.exe","args":["-NoProfile","-NonInteractive","-Command","$p=42;$out=@();for($i=0;$i -lt 5;$i++){$proc=Get-CimInstance Win32_Process -Filter \"ProcessId=$p\" -ErrorAction SilentlyContinue;if(-not $proc){break};$pp=$proc.ParentProcessId;if(-not $pp -or $pp -eq 0){break};$out+=$pp;$p=$pp};$out -join ','"]}],"darwin":[{"file":"sh","args":["-c","p=42; i=0; while [ $i -lt 5 ]; do pp=$(ps -o ppid= -p \"$p\" 2>/dev/null | tr -d ' '); if [ -z \"$pp\" ] || [ \"$pp\" = \"0\" ] || [ \"$pp\" = \"1\" ]; then break; fi; echo \"$pp\"; p=$pp; i=$((i+1)); done"]},{"file":"sh","args":["-c","p=42; i=0; while [ $i -lt 5 ]; do pp=$(ps -o ppid= -p \"$p\" 2>/dev/null | tr -d ' '); if [ -z \"$pp\" ] || [ \"$pp\" = \"0\" ] || [ \"$pp\" = \"1\" ]; then break; fi; echo \"$pp\"; p=$pp; i=$((i+1)); done"]}],"linux":[{"file":"sh","args":["-c","p=42; i=0; while [ $i -lt 5 ]; do pp=$(ps -o ppid= -p \"$p\" 2>/dev/null | tr -d ' '); if [ -z \"$pp\" ] || [ \"$pp\" = \"0\" ] || [ \"$pp\" = \"1\" ]; then break; fi; echo \"$pp\"; p=$pp; i=$((i+1)); done"]},{"file":"sh","args":["-c","p=42; i=0; while [ $i -lt 5 ]; do pp=$(ps -o ppid= -p \"$p\" 2>/dev/null | tr -d ' '); if [ -z \"$pp\" ] || [ \"$pp\" = \"0\" ] || [ \"$pp\" = \"1\" ]; then break; fi; echo \"$pp\"; p=$pp; i=$((i+1)); done"]}],"win32 by process.platform alone":[{"file":"powershell.exe","args":["-NoProfile","-NonInteractive","-Command","$p=42;$out=@();for($i=0;$i -lt 5;$i++){$proc=Get-CimInstance Win32_Process -Filter \"ProcessId=$p\" -ErrorAction SilentlyContinue;if(-not $proc){break};$pp=$proc.ParentProcessId;if(-not $pp -or $pp -eq 0){break};$out+=$pp;$p=$pp};$out -join ','"]},{"file":"powershell.exe","args":["-NoProfile","-NonInteractive","-Command","$p=42;$out=@();for($i=0;$i -lt 5;$i++){$proc=Get-CimInstance Win32_Process -Filter \"ProcessId=$p\" -ErrorAction SilentlyContinue;if(-not $proc){break};$pp=$proc.ParentProcessId;if(-not $pp -or $pp -eq 0){break};$out+=$pp;$p=$pp};$out -join ','"]}],"win32 by getPlatform() alone":[{"file":"sh","args":["-c","p=42; i=0; while [ $i -lt 5 ]; do pp=$(ps -o ppid= -p \"$p\" 2>/dev/null | tr -d ' '); if [ -z \"$pp\" ] || [ \"$pp\" = \"0\" ] || [ \"$pp\" = \"1\" ]; then break; fi; echo \"$pp\"; p=$pp; i=$((i+1)); done"]},{"file":"sh","args":["-c","p=42; i=0; while [ $i -lt 5 ]; do pp=$(ps -o ppid= -p \"$p\" 2>/dev/null | tr -d ' '); if [ -z \"$pp\" ] || [ \"$pp\" = \"0\" ] || [ \"$pp\" = \"1\" ]; then break; fi; echo \"$pp\"; p=$pp; i=$((i+1)); done"]}]},
  },
  {
    name: 'processQueryTool',
    answers: stand => [processQueryTool(), processQueryTool(stand.node)],
    recorded: {"win32":["tasklist","tasklist"],"darwin":["ps","ps"],"linux":["ps","ps"],"win32 by process.platform alone":["tasklist","tasklist"],"win32 by getPlatform() alone":["ps","ps"]},
  },
  {
    name: 'processUserSource',
    answers: stand => [processUserSource(), processUserSource(stand.node)],
    recorded: {"win32":["table","table"],"darwin":["uid","uid"],"linux":["uid","uid"],"win32 by process.platform alone":["table","table"],"win32 by getPlatform() alone":["uid","uid"]},
  },
]

import { chmodSync, constants as fsConstants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { rememberedPlatform } from '../../src/utils/platform/host.js'
import {
  appendNoFollowFlags,
  boundedProjectTempName,
  canonicalHomePathSpelling,
  defaultMercuryTempBase,
  dirFsyncErrorIsFatal,
  envUserHomeDir,
  exclusiveCreateNoFollowFlags,
  heldFileRetryDelayMs,
  isDirAbsentOnRmdirError,
  isOwnedPrivateEntry,
  isPrivateFileMode,
  isTransientHeldFileCode,
  localIpcDoorKind,
  mercuryTempDirName,
  mountedVolumeRoots,
  pathEntryKindSync,
  platformTempRoots,
  posixFileModesApply,
  readExposedFileModeSync,
  symlinkDeniedByPrivilege,
  symlinksMayRequirePrivilege,
  userConfigRoot,
  userHomeDir,
  xdgAndRoamingConfigRoots,
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
  {
    name: 'files · isTransientHeldFileCode',
    answers: () => [
      isTransientHeldFileCode('EPERM'),
      isTransientHeldFileCode('EBUSY'),
      isTransientHeldFileCode('EACCES'),
      isTransientHeldFileCode('ENOENT'),
      isTransientHeldFileCode(undefined),
      isTransientHeldFileCode('EBUSY', 'win32'),
      isTransientHeldFileCode('EBUSY', 'linux'),
    ],
    recorded: {
      win32: [true, true, true, false, false, true, false],
      darwin: [false, false, false, false, false, true, false],
      linux: [false, false, false, false, false, true, false],
      'win32 by process.platform alone': [true, true, true, false, false, true, false],
      'win32 by getPlatform() alone': [false, false, false, false, false, true, false],
    },
  },
  {
    name: 'files · heldFileRetryDelayMs',
    answers: () => [
      heldFileRetryDelayMs('EBUSY', 0),
      heldFileRetryDelayMs('EBUSY', 1),
      heldFileRetryDelayMs('EPERM', 2),
      heldFileRetryDelayMs('EACCES', 3),
      heldFileRetryDelayMs('EBUSY', 4),
      heldFileRetryDelayMs('ENOENT', 1),
      heldFileRetryDelayMs('EBUSY', 1, 'win32'),
      heldFileRetryDelayMs('EBUSY', 1, 'darwin'),
    ],
    recorded: {
      win32: [null, 50, 100, 200, null, null, 50, null],
      darwin: [null, null, null, null, null, null, 50, null],
      linux: [null, null, null, null, null, null, 50, null],
      'win32 by process.platform alone': [null, 50, 100, 200, null, null, 50, null],
      'win32 by getPlatform() alone': [null, null, null, null, null, null, 50, null],
    },
  },
  {
    name: 'files · dirFsyncErrorIsFatal',
    answers: () => [
      dirFsyncErrorIsFatal({ code: 'EINVAL' }),
      dirFsyncErrorIsFatal({ code: 'EISDIR' }),
      dirFsyncErrorIsFatal({ code: 'EPERM' }),
      dirFsyncErrorIsFatal({ code: 'EACCES' }),
      dirFsyncErrorIsFatal({ code: 'ENOTSUP' }),
      dirFsyncErrorIsFatal({ code: 'EBADF' }),
      dirFsyncErrorIsFatal({ code: 'EIO' }),
      dirFsyncErrorIsFatal(new Error('plain')),
      dirFsyncErrorIsFatal({ code: 'EIO' }, 'win32'),
      dirFsyncErrorIsFatal({ code: 'EIO' }, 'linux'),
    ],
    recorded: {
      win32: [false, false, false, false, false, false, false, false, false, true],
      darwin: [false, false, false, false, false, false, true, true, false, true],
      linux: [false, false, false, false, false, false, true, true, false, true],
      'win32 by process.platform alone': [false, false, false, false, false, false, false, false, false, true],
      'win32 by getPlatform() alone': [false, false, false, false, false, false, true, true, false, true],
    },
  },
  {
    name: 'files · localIpcDoorKind',
    answers: () => [
      localIpcDoorKind(),
      localIpcDoorKind('win32'),
      localIpcDoorKind('darwin'),
      localIpcDoorKind('linux'),
    ],
    recorded: {
      win32: ['named-pipe', 'named-pipe', 'unix-socket', 'unix-socket'],
      darwin: ['unix-socket', 'named-pipe', 'unix-socket', 'unix-socket'],
      linux: ['unix-socket', 'named-pipe', 'unix-socket', 'unix-socket'],
      'win32 by process.platform alone': ['named-pipe', 'named-pipe', 'unix-socket', 'unix-socket'],
      'win32 by getPlatform() alone': ['unix-socket', 'named-pipe', 'unix-socket', 'unix-socket'],
    },
  },
  {
    name: 'files · userHomeDir and envUserHomeDir',
    answers: () => {
      const norm = (s: string): string => (s === homedir() ? '<homedir>' : s)
      const both = { HOME: ' /posix/home ', USERPROFILE: 'C:\\Users\\win' }
      const empty = { HOME: '   ', USERPROFILE: '' }
      return [
        norm(userHomeDir(both)),
        norm(userHomeDir(empty)),
        norm(userHomeDir(both, 'win32')),
        norm(userHomeDir(both, 'linux')),
        norm(envUserHomeDir(both)),
        norm(envUserHomeDir(empty)),
        norm(envUserHomeDir(both, 'win32')),
        norm(envUserHomeDir(both, 'linux')),
      ]
    },
    recorded: {
      win32: ['<homedir>', '<homedir>', '<homedir>', '/posix/home', 'C:\\Users\\win', '<homedir>', 'C:\\Users\\win', ' /posix/home '],
      darwin: ['/posix/home', '<homedir>', '<homedir>', '/posix/home', ' /posix/home ', '   ', 'C:\\Users\\win', ' /posix/home '],
      linux: ['/posix/home', '<homedir>', '<homedir>', '/posix/home', ' /posix/home ', '   ', 'C:\\Users\\win', ' /posix/home '],
      'win32 by process.platform alone': ['<homedir>', '<homedir>', '<homedir>', '/posix/home', 'C:\\Users\\win', '<homedir>', 'C:\\Users\\win', ' /posix/home '],
      'win32 by getPlatform() alone': ['/posix/home', '<homedir>', '<homedir>', '/posix/home', ' /posix/home ', '   ', 'C:\\Users\\win', ' /posix/home '],
    },
  },
  {
    name: 'files · mountedVolumeRoots',
    answers: () => [
      mountedVolumeRoots(),
      mountedVolumeRoots('win32'),
      mountedVolumeRoots('darwin'),
      mountedVolumeRoots('linux'),
    ],
    recorded: {
      win32: [[], [], ['/Volumes', '/mnt'], ['/Volumes', '/mnt']],
      darwin: [['/Volumes', '/mnt'], [], ['/Volumes', '/mnt'], ['/Volumes', '/mnt']],
      linux: [['/Volumes', '/mnt'], [], ['/Volumes', '/mnt'], ['/Volumes', '/mnt']],
      'win32 by process.platform alone': [[], [], ['/Volumes', '/mnt'], ['/Volumes', '/mnt']],
      'win32 by getPlatform() alone': [['/Volumes', '/mnt'], [], ['/Volumes', '/mnt'], ['/Volumes', '/mnt']],
    },
  },
  {
    name: 'files · userConfigRoot and xdgAndRoamingConfigRoots',
    answers: () => {
      const norm = (s: string): string => s.replace(/\\/g, '/')
      const withBoth = { XDG_CONFIG_HOME: '/xdg', APPDATA: 'C:\\AppData' }
      const withAppData = { APPDATA: 'C:\\AppData' }
      return [
        norm(userConfigRoot('H')),
        norm(userConfigRoot('H', 'win32')),
        norm(userConfigRoot('H', 'darwin')),
        norm(userConfigRoot('H', 'linux')),
        xdgAndRoamingConfigRoots(withBoth, 'H').map(norm),
        xdgAndRoamingConfigRoots(withAppData, 'H').map(norm),
        xdgAndRoamingConfigRoots({}, 'H').map(norm),
      ]
    },
    recorded: {
      win32: ['H/AppData/Roaming', 'H/AppData/Roaming', 'H/Library/Application Support', 'H/.config', ['/xdg', 'C:/AppData'], ['H/.config', 'C:/AppData'], ['H/.config']],
      darwin: ['H/Library/Application Support', 'H/AppData/Roaming', 'H/Library/Application Support', 'H/.config', ['/xdg'], ['H/.config'], ['H/.config']],
      linux: ['H/.config', 'H/AppData/Roaming', 'H/Library/Application Support', 'H/.config', ['/xdg'], ['H/.config'], ['H/.config']],
      'win32 by process.platform alone': ['H/AppData/Roaming', 'H/AppData/Roaming', 'H/Library/Application Support', 'H/.config', ['/xdg', 'C:/AppData'], ['H/.config', 'C:/AppData'], ['H/.config']],
      'win32 by getPlatform() alone': ['H/.config', 'H/AppData/Roaming', 'H/Library/Application Support', 'H/.config', ['/xdg'], ['H/.config'], ['H/.config']],
    },
  },
  {
    name: 'files · platformTempRoots, mercuryTempDirName, defaultMercuryTempBase, boundedProjectTempName',
    answers: () => {
      const normTmp = (s: string): string => (s === tmpdir() ? '<tmpdir>' : s)
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0
      const normDir = (s: string): string => (s === `mercury-${uid}` ? 'mercury-<uid>' : s)
      const longName = 'a'.repeat(60)
      return [
        platformTempRoots().map(normTmp),
        platformTempRoots(true).map(normTmp),
        platformTempRoots(true, 'win32').map(normTmp),
        platformTempRoots(false, 'linux').map(normTmp),
        normDir(mercuryTempDirName()),
        normDir(mercuryTempDirName('windows')),
        normDir(mercuryTempDirName('linux')),
        normTmp(defaultMercuryTempBase()),
        normTmp(defaultMercuryTempBase('windows')),
        normTmp(defaultMercuryTempBase('macos')),
        boundedProjectTempName('short', 'deadbeef'),
        boundedProjectTempName(longName, 'deadbeef'),
        boundedProjectTempName(longName, 'deadbeef', 48, 'windows'),
        boundedProjectTempName(longName, 'deadbeef', 48, 'linux'),
      ]
    },
    recorded: {
      win32: [['<tmpdir>'], ['<tmpdir>'], ['<tmpdir>'], ['<tmpdir>', '/tmp'], 'mercury', 'mercury', 'mercury-<uid>', '<tmpdir>', '<tmpdir>', '/tmp', 'short', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-deadbeef', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-deadbeef', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      darwin: [['<tmpdir>', '/tmp'], ['<tmpdir>', '/tmp', '/private/tmp'], ['<tmpdir>'], ['<tmpdir>', '/tmp'], 'mercury-<uid>', 'mercury', 'mercury-<uid>', '/tmp', '<tmpdir>', '/tmp', 'short', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-deadbeef', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      linux: [['<tmpdir>', '/tmp'], ['<tmpdir>', '/tmp', '/private/tmp'], ['<tmpdir>'], ['<tmpdir>', '/tmp'], 'mercury-<uid>', 'mercury', 'mercury-<uid>', '/tmp', '<tmpdir>', '/tmp', 'short', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-deadbeef', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      'win32 by process.platform alone': [['<tmpdir>'], ['<tmpdir>'], ['<tmpdir>'], ['<tmpdir>', '/tmp'], 'mercury-<uid>', 'mercury', 'mercury-<uid>', '/tmp', '<tmpdir>', '/tmp', 'short', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-deadbeef', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      'win32 by getPlatform() alone': [['<tmpdir>', '/tmp'], ['<tmpdir>', '/tmp', '/private/tmp'], ['<tmpdir>'], ['<tmpdir>', '/tmp'], 'mercury', 'mercury', 'mercury-<uid>', '<tmpdir>', '<tmpdir>', '/tmp', 'short', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-deadbeef', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-deadbeef', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    },
  },
  {
    name: 'files · canonicalHomePathSpelling',
    answers: () => [
      canonicalHomePathSpelling('c:/Users/Alice/'),
      canonicalHomePathSpelling('C:\\'),
      canonicalHomePathSpelling('\\\\server\\share\\'),
      canonicalHomePathSpelling('/Users/alice///'),
      canonicalHomePathSpelling('/'),
      canonicalHomePathSpelling(''),
      canonicalHomePathSpelling('c:/Users/Alice/', 'win32'),
      canonicalHomePathSpelling('/Users/alice/', 'linux'),
    ],
    recorded: {
      win32: ['C:\\Users\\Alice', 'C:\\', '\\\\server\\share\\', '\\Users\\alice', '/', '', 'C:\\Users\\Alice', '/Users/alice'],
      darwin: ['c:/Users/Alice', 'C:\\', '\\\\server\\share\\', '/Users/alice', '/', '', 'C:\\Users\\Alice', '/Users/alice'],
      linux: ['c:/Users/Alice', 'C:\\', '\\\\server\\share\\', '/Users/alice', '/', '', 'C:\\Users\\Alice', '/Users/alice'],
      'win32 by process.platform alone': ['C:\\Users\\Alice', 'C:\\', '\\\\server\\share\\', '\\Users\\alice', '/', '', 'C:\\Users\\Alice', '/Users/alice'],
      'win32 by getPlatform() alone': ['c:/Users/Alice', 'C:\\', '\\\\server\\share\\', '/Users/alice', '/', '', 'C:\\Users\\Alice', '/Users/alice'],
    },
  },
]

import {
  isLegacyWindowsConsole,
  isModernWindowsTerminalHost,
  isWindowsTerminalHost,
  terminalSupportsJobControl,
  terminalTitleTransport,
} from '../../src/utils/platform/terminal.js'
const TERMINAL: Row[] = [
  {
    name: 'terminal.terminalSupportsJobControl',
    answers: () => terminalSupportsJobControl(),
    recorded: {"win32":false,"darwin":true,"linux":true,"win32 by process.platform alone":false,"win32 by getPlatform() alone":true},
  },
  {
    name: 'terminal.terminalTitleTransport',
    answers: () => terminalTitleTransport(),
    recorded: {"win32":"process-title","darwin":"osc","linux":"osc","win32 by process.platform alone":"process-title","win32 by getPlatform() alone":"osc"},
  },
  {
    name: 'terminal.isModernWindowsTerminalHost',
    answers: () => [
      isModernWindowsTerminalHost({}),
      isModernWindowsTerminalHost({ WT_SESSION: 'wt-1' }),
      isModernWindowsTerminalHost({ WT_SESSION: '' }),
      isModernWindowsTerminalHost({ TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.90.0' }),
      isModernWindowsTerminalHost({ TERM_PROGRAM: 'vscode' }),
      isModernWindowsTerminalHost({ TERM_PROGRAM: 'mintty' }),
      isModernWindowsTerminalHost({ MSYSTEM: 'MINGW64' }),
    ],
    recorded: {"win32":[false,true,false,true,false,true,true],"darwin":[false,false,false,false,false,false,false],"linux":[false,false,false,false,false,false,false],"win32 by process.platform alone":[false,true,false,true,false,true,true],"win32 by getPlatform() alone":[false,false,false,false,false,false,false]},
  },
  {
    name: 'terminal.isLegacyWindowsConsole',
    answers: () => [
      isLegacyWindowsConsole({}),
      isLegacyWindowsConsole({ WT_SESSION: 'wt-1' }),
      isLegacyWindowsConsole({ TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.90.0' }),
      isLegacyWindowsConsole({ MSYSTEM: 'MINGW64' }),
    ],
    recorded: {"win32":[true,false,false,false],"darwin":[false,false,false,false],"linux":[false,false,false,false],"win32 by process.platform alone":[true,false,false,false],"win32 by getPlatform() alone":[false,false,false,false]},
  },
  {
    name: 'terminal.isWindowsTerminalHost',
    answers: () => [
      isWindowsTerminalHost({}),
      isWindowsTerminalHost({ WT_SESSION: 'wt-1' }),
      isWindowsTerminalHost({ WT_SESSION: '' }),
    ],
    recorded: {"win32":[true,true,true],"darwin":[false,true,false],"linux":[false,true,false],"win32 by process.platform alone":[true,true,true],"win32 by getPlatform() alone":[false,true,false]},
  },
]

import { desktopOpenPathCommand, desktopOpenUrlCommand } from '../../src/utils/platform/desktop.js'

const DESKTOP: Row[] = [
  {
    name: 'desktop: desktopOpenPathCommand and desktopOpenUrlCommand',
    answers: () => ({
      openPath: desktopOpenPathCommand('/tmp/report.pdf'),
      openUrlDefault: desktopOpenUrlCommand('https://example.com', undefined),
      openUrlEmpty: desktopOpenUrlCommand('https://example.com', ''),
      openUrlCustom: desktopOpenUrlCommand('https://example.com', 'firefox'),
    }),
    recorded: {"win32":{"openPath":{"file":"explorer","args":["/tmp/report.pdf"]},"openUrlDefault":{"file":"rundll32","args":["url,OpenURL","https://example.com"]},"openUrlEmpty":{"file":"rundll32","args":["url,OpenURL","https://example.com"]},"openUrlCustom":{"file":"firefox","args":["https://example.com"]}},"darwin":{"openPath":{"file":"open","args":["/tmp/report.pdf"]},"openUrlDefault":{"file":"open","args":["https://example.com"]},"openUrlEmpty":{"file":"open","args":["https://example.com"]},"openUrlCustom":{"file":"firefox","args":["https://example.com"]}},"linux":{"openPath":{"file":"xdg-open","args":["/tmp/report.pdf"]},"openUrlDefault":{"file":"xdg-open","args":["https://example.com"]},"openUrlEmpty":{"file":"xdg-open","args":["https://example.com"]},"openUrlCustom":{"file":"firefox","args":["https://example.com"]}},"win32 by process.platform alone":{"openPath":{"file":"explorer","args":["/tmp/report.pdf"]},"openUrlDefault":{"file":"rundll32","args":["url,OpenURL","https://example.com"]},"openUrlEmpty":{"file":"rundll32","args":["url,OpenURL","https://example.com"]},"openUrlCustom":{"file":"firefox","args":["https://example.com"]}},"win32 by getPlatform() alone":{"openPath":{"file":"xdg-open","args":["/tmp/report.pdf"]},"openUrlDefault":{"file":"xdg-open","args":["https://example.com"]},"openUrlEmpty":{"file":"xdg-open","args":["https://example.com"]},"openUrlCustom":{"file":"firefox","args":["https://example.com"]}}},
  },
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
