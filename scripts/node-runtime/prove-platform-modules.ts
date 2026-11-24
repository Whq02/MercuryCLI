#!/usr/bin/env bun
import { getPlatform, type Platform } from '../../src/platform/environment/platform.js'

type Stand = { name: string; node: NodeJS.Platform; house: Platform }

type Row = {
  name: string
  stands?: readonly Stand[]
  answers: (stand: Stand) => unknown
  old?: (stand: Stand) => unknown
  recorded?: Record<string, unknown>
  hostArm?: 'node' | 'house' | 'either'
}

const HOST_PLATFORM = process.argv.includes('--windows-host') ? 'win32' : process.platform

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
} from '../../src/platform/host-os/paths.js'
import {
  nativeCwdFromShellRecord,
  posixPathToWindowsPath,
  stripExtendedLengthPrefix,
  windowsPathToPosixPath,
} from '../../src/platform/files/windowsPaths.js'

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
      const hostDrive = pathWin32.resolve('\\').slice(0, -1)
      const evalPair = ([cwd, op]: readonly [string, string], platform?: Platform): string => {
        const out = resolveLexicalOperandPath(cwd, op, platform)
        return !/^[A-Za-z]:/.test(cwd) && hostDrive !== '' && out.startsWith(`${hostDrive}\\`) ? out.slice(hostDrive.length) : out
      }
      return {
        default: pairs.map(pair => evalPair(pair)),
        windows: pairs.map(pair => evalPair(pair, 'windows')),
        macos: pairs.map(pair => evalPair(pair, 'macos')),
        linux: pairs.map(pair => evalPair(pair, 'linux')),
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
  {
    name: 'paths.windowsPathsDoorParity',
    answers: () => {
      const records = ['/c/Users/Alice\nC:\\Users\\Alice\n', '/c/Users/Alice\n', '', '/tmp/work\n']
      const prefixed = ['\\\\?\\C:\\x', '\\\\?\\UNC\\server\\share\\x', 'C:\\Users\\Alice', '/tmp/a']
      return {
        cwdOld: records.map(r => nativeCwdFromShellRecord(r)),
        cwdNew: records.map(r => nativeCwdFromRecordedShell(r, true, 'windows')),
        stripOld: prefixed.map(p => stripExtendedLengthPrefix(p)),
        stripNew: prefixed.map(p => stripExtendedLengthPrefixForPlatform(p, 'win32')),
      }
    },
    recorded: {"win32":{"cwdOld":[{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"}],"cwdNew":[{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"}],"stripOld":["C:\\x","\\\\server\\share\\x","C:\\Users\\Alice","/tmp/a"],"stripNew":["C:\\x","\\\\server\\share\\x","C:\\Users\\Alice","/tmp/a"]},"darwin":{"cwdOld":[{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"}],"cwdNew":[{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"}],"stripOld":["C:\\x","\\\\server\\share\\x","C:\\Users\\Alice","/tmp/a"],"stripNew":["C:\\x","\\\\server\\share\\x","C:\\Users\\Alice","/tmp/a"]},"linux":{"cwdOld":[{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"}],"cwdNew":[{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"}],"stripOld":["C:\\x","\\\\server\\share\\x","C:\\Users\\Alice","/tmp/a"],"stripNew":["C:\\x","\\\\server\\share\\x","C:\\Users\\Alice","/tmp/a"]},"win32 by process.platform alone":{"cwdOld":[{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"}],"cwdNew":[{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"}],"stripOld":["C:\\x","\\\\server\\share\\x","C:\\Users\\Alice","/tmp/a"],"stripNew":["C:\\x","\\\\server\\share\\x","C:\\Users\\Alice","/tmp/a"]},"win32 by getPlatform() alone":{"cwdOld":[{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"}],"cwdNew":[{"path":"C:\\Users\\Alice"},{"path":"C:\\Users\\Alice"},{"refused":"the shell recorded no directory (the command may have died before writing it)"},{"refused":"/tmp/work is an MSYS virtual root the converter cannot place (it would become the drive-relative \\tmp\\work); the shell's own Win32 spelling (pwd -W) was not recorded"}],"stripOld":["C:\\x","\\\\server\\share\\x","C:\\Users\\Alice","/tmp/a"],"stripNew":["C:\\x","\\\\server\\share\\x","C:\\Users\\Alice","/tmp/a"]}},
  },
]

import { chmodSync as p02ChmodSync, lstatSync as p02LstatSync, mkdirSync as p02MkdirSync, mkdtempSync as p02MkdtempSync, readdirSync as p02ReaddirSync, rmSync as p02RmSync, statSync as p02StatSync, symlinkSync as p02SymlinkSync, writeFileSync as p02WriteFileSync } from 'node:fs'
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
} from '../../src/platform/host-os/programs.js'

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

const p02HostPlatform = process.platform

function findWindowsAppAlias(): { dir: string; file: string; bare: string } | null {
  if (p02HostPlatform !== 'win32') return null
  const localAppData = process.env.LOCALAPPDATA ?? ''
  if (localAppData === '') return null
  const dir = p02Path.join(localAppData, 'Microsoft', 'WindowsApps')
  let entries: string[]
  try {
    entries = p02ReaddirSync(dir)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.exe')) continue
    const file = p02Path.join(dir, entry)
    try {
      p02StatSync(file)
      continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
    }
    try {
      p02LstatSync(file)
      return { dir, file, bare: entry.slice(0, -4) }
    } catch {
    }
  }
  return null
}

const p02Win32AppAlias = findWindowsAppAlias()
if (p02HostPlatform === 'win32' && p02Win32AppAlias === null) {
  console.log('  not read on Windows: no App Execution Alias here')
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
    hostArm: 'node',
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
    hostArm: 'node',
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
  ...(p02HostPlatform === 'win32' && p02Win32AppAlias === null
    ? []
    : [
        {
          name: 'programs: app execution alias (EACCES statSync, lstatSync succeeds)',
          hostArm: 'node' as const,
          answers: () => {
            if (p02HostPlatform === 'win32' && p02Win32AppAlias !== null) {
              const dir = p02MkdtempSync(p02Path.join(p02Tmpdir(), 'mercury-p02-alias-'))
              try {
                const absent = p02Path.join(dir, 'dangling-alias-306.exe')
                return {
                  aliasExec: isExecutableFile(p02Win32AppAlias.file),
                  danglingExec: isExecutableFile(absent),
                  aliasResolved: resolveProgramInPath(p02Win32AppAlias.bare, p02Win32AppAlias.dir) !== null,
                  danglingResolved: resolveProgramInPath('dangling-alias-306', dir) !== null,
                  aliasMissing: missingSpawnCommandError(p02Win32AppAlias.bare, { Path: p02Win32AppAlias.dir }, dir)?.code ?? null,
                  danglingMissing: missingSpawnCommandError('dangling-alias-306', { Path: dir }, dir)?.code ?? null,
                }
              } finally {
                p02RmSync(dir, { recursive: true, force: true })
              }
            }
            const dir = p02MkdtempSync(p02Path.join(p02Tmpdir(), 'mercury-p02-alias-'))
            const locked = p02Path.join(dir, 'locked')
            try {
              p02MkdirSync(locked)
              const target = p02Path.join(locked, 'target.exe')
              p02WriteFileSync(target, 'mz')
              p02ChmodSync(locked, 0o000)
              const aliasLink = p02Path.join(dir, 'alias.exe')
              p02SymlinkSync(target, aliasLink)
              const danglingLink = p02Path.join(dir, 'dangling.exe')
              p02SymlinkSync(p02Path.join(dir, 'no-such-target.exe'), danglingLink)
              return {
                aliasExec: isExecutableFile(aliasLink),
                danglingExec: isExecutableFile(danglingLink),
                aliasResolved: resolveProgramInPath('alias', dir) !== null,
                danglingResolved: resolveProgramInPath('dangling', dir) !== null,
                aliasMissing: missingSpawnCommandError('alias', { Path: dir }, dir)?.code ?? null,
                danglingMissing: missingSpawnCommandError('dangling', { Path: dir }, dir)?.code ?? null,
              }
            } finally {
              try {
                p02ChmodSync(locked, 0o755)
              } catch {
              }
              p02RmSync(dir, { recursive: true, force: true })
            }
          },
          recorded: {
            win32: { aliasExec: false, danglingExec: false, aliasResolved: false, danglingResolved: false, aliasMissing: null, danglingMissing: 'ENOENT' },
            darwin: { aliasExec: false, danglingExec: false, aliasResolved: false, danglingResolved: false, aliasMissing: null, danglingMissing: null },
            linux: { aliasExec: false, danglingExec: false, aliasResolved: false, danglingResolved: false, aliasMissing: null, danglingMissing: null },
            'win32 by process.platform alone': { aliasExec: false, danglingExec: false, aliasResolved: false, danglingResolved: false, aliasMissing: null, danglingMissing: 'ENOENT' },
            'win32 by getPlatform() alone': { aliasExec: false, danglingExec: false, aliasResolved: false, danglingResolved: false, aliasMissing: null, danglingMissing: null },
          },
        },
        {
          name: 'programs: the lookup answers null for an app execution alias',
          hostArm: 'node' as const,
          answers: () => {
            if (p02HostPlatform === 'win32' && p02Win32AppAlias !== null) {
              return { lookup: resolveProgramInPath(p02Win32AppAlias.bare, p02Win32AppAlias.dir) }
            }
            const dir = p02MkdtempSync(p02Path.join(p02Tmpdir(), 'mercury-p02-alias-'))
            const locked = p02Path.join(dir, 'locked')
            try {
              p02MkdirSync(locked)
              const target = p02Path.join(locked, 'target.exe')
              p02WriteFileSync(target, 'mz')
              p02ChmodSync(locked, 0o000)
              p02SymlinkSync(target, p02Path.join(dir, 'alias.exe'))
              return { lookup: resolveProgramInPath('alias', dir) }
            } finally {
              try {
                p02ChmodSync(locked, 0o755)
              } catch {
              }
              p02RmSync(dir, { recursive: true, force: true })
            }
          },
          recorded: {
            win32: { lookup: null },
            darwin: { lookup: null },
            linux: { lookup: null },
            'win32 by process.platform alone': { lookup: null },
            'win32 by getPlatform() alone': { lookup: null },
          },
        },
      ]),
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
} from '../../src/platform/host-os/spawn.js'
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
      hostShellHint({ PSModulePath: 'C:\\Users\\op\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\Modules;c:\\program files\\powershell\\7\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules', ComSpec: 'C:\\cmd.exe', SHELL: '/bin/zsh' }),
      hostShellHint({ PSModulePath: 'C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules', ComSpec: 'C:\\cmd.exe' }),
      hostShellHint({ PSModulePath: 'C:\\Users\\op\\Documents\\WindowsPowerShell\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules', ComSpec: 'C:\\cmd.exe' }),
      hostShellHint({ PSModulePath: 'C:\\Users\\op\\OneDrive\\Documents\\PowerShell\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules', ComSpec: 'C:\\cmd.exe' }),
      hostShellHint({ ComSpec: 'C:\\cmd.exe' }),
      hostShellHint({ SHELL: '/bin/bash' }),
      hostShellHint({}),
      hostShellHint({ PSModulePath: '', ComSpec: 'C:\\cmd.exe', SHELL: '' }),
    ],
    recorded: {"win32":["powershell","cmd","powershell","powershell","cmd","unknown","unknown","cmd"],"darwin":["posix-sh","unknown","unknown","unknown","unknown","posix-sh","unknown","unknown"],"linux":["posix-sh","unknown","unknown","unknown","unknown","posix-sh","unknown","unknown"],"win32 by process.platform alone":["powershell","cmd","powershell","powershell","cmd","unknown","unknown","cmd"],"win32 by getPlatform() alone":["posix-sh","unknown","unknown","unknown","unknown","posix-sh","unknown","unknown"]},
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
} from '../../src/platform/host-os/processes.js'
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
import { rememberedPlatform } from '../../src/platform/host-os/host.js'
import {
  appendNoFollowFlags,
  boundedProjectTempName,
  canonicalHomePathSpelling,
  defaultMercuryTempBase,
  dirFsyncErrorIsFatal,
  envUserHomeDir,
  exclusiveCreateNoFollowFlags,
  heldFileRetriesApply,
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
} from '../../src/platform/host-os/files.js'

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
    hostArm: 'node',
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
  {
    name: 'files · heldFileRetriesApply',
    answers: () => [
      heldFileRetriesApply(),
      heldFileRetriesApply('win32'),
      heldFileRetriesApply('darwin'),
      heldFileRetriesApply('linux'),
    ],
    recorded: {
      win32: [true, true, false, false],
      darwin: [false, true, false, false],
      linux: [false, true, false, false],
      'win32 by process.platform alone': [true, true, false, false],
      'win32 by getPlatform() alone': [false, true, false, false],
    },
  },
]

import {
  consoleNeedsUtf8Codepage,
  consoleSizeNeedsPolling,
  isLegacyWindowsConsole,
  isModernWindowsTerminalHost,
  isWindowsTerminalHost,
  terminalSupportsJobControl,
  terminalTitleTransport,
} from '../../src/platform/host-os/terminal.js'
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
  {
    name: 'terminal.consoleSizeNeedsPolling',
    answers: () => consoleSizeNeedsPolling(),
    recorded: {"win32":true,"darwin":false,"linux":false,"win32 by process.platform alone":true,"win32 by getPlatform() alone":false},
  },
  {
    name: 'terminal.consoleNeedsUtf8Codepage',
    answers: () => consoleNeedsUtf8Codepage(),
    recorded: {"win32":true,"darwin":false,"linux":false,"win32 by process.platform alone":true,"win32 by getPlatform() alone":false},
  },
]

import { desktopOpenPathCommand, desktopOpenUrlCommand } from '../../src/platform/host-os/desktop.js'

const DESKTOP: Row[] = [
  {
    name: 'desktop: desktopOpenPathCommand and desktopOpenUrlCommand',
    answers: () => {
      const prevBrowser = process.env.BROWSER
      delete process.env.BROWSER
      try {
        return {
          openPath: desktopOpenPathCommand('/tmp/report.pdf'),
          openUrlDefault: desktopOpenUrlCommand('https://example.com', undefined),
          openUrlEmpty: desktopOpenUrlCommand('https://example.com', ''),
          openUrlCustom: desktopOpenUrlCommand('https://example.com', 'firefox'),
        }
      } finally {
        if (prevBrowser !== undefined) process.env.BROWSER = prevBrowser
      }
    },
    recorded: {"win32":{"openPath":{"file":"explorer","args":["/tmp/report.pdf"]},"openUrlDefault":{"file":"rundll32","args":["url,OpenURL","https://example.com"]},"openUrlEmpty":{"file":"rundll32","args":["url,OpenURL","https://example.com"]},"openUrlCustom":{"file":"firefox","args":["https://example.com"]}},"darwin":{"openPath":{"file":"open","args":["/tmp/report.pdf"]},"openUrlDefault":{"file":"open","args":["https://example.com"]},"openUrlEmpty":{"file":"open","args":["https://example.com"]},"openUrlCustom":{"file":"firefox","args":["https://example.com"]}},"linux":{"openPath":{"file":"xdg-open","args":["/tmp/report.pdf"]},"openUrlDefault":{"file":"xdg-open","args":["https://example.com"]},"openUrlEmpty":{"file":"xdg-open","args":["https://example.com"]},"openUrlCustom":{"file":"firefox","args":["https://example.com"]}},"win32 by process.platform alone":{"openPath":{"file":"explorer","args":["/tmp/report.pdf"]},"openUrlDefault":{"file":"rundll32","args":["url,OpenURL","https://example.com"]},"openUrlEmpty":{"file":"rundll32","args":["url,OpenURL","https://example.com"]},"openUrlCustom":{"file":"firefox","args":["https://example.com"]}},"win32 by getPlatform() alone":{"openPath":{"file":"xdg-open","args":["/tmp/report.pdf"]},"openUrlDefault":{"file":"xdg-open","args":["https://example.com"]},"openUrlEmpty":{"file":"xdg-open","args":["https://example.com"]},"openUrlCustom":{"file":"firefox","args":["https://example.com"]}}},
  },
]

import { release as hostOsRelease, type as hostOsType, version as hostOsVersion } from 'node:os'
import {
  tensorFoldHasNativeEngine,
  tensorFoldMachineSupportKind,
  tensorFoldRuntimeDisplayPath,
  tensorFoldSupportsLanBrowse,
} from '../../src/platform/host-os/tensorfold.js'
import {
  asepriteSteamInstallCandidates,
  asepriteWindowsInstallCandidates,
  blenderProgramFilesRoot,
  blenderUserConfigBase,
  browserDiscoveryCandidates,
  chromeForTestingRelativePaths,
  editorCliCandidates,
  godotBinaryNeedsExeSuffix,
  godotWellKnownRootsForPlatform,
  isWinGetGodotPackageDir,
  ollamaWindowsExeCandidate,
  unityEditorExecutablePath,
  unityHubEditorRoots,
} from '../../src/platform/host-os/vendors.js'
import {
  accessDeniedErrorHint,
  brushPackRemedyWords,
  clearEnvVarCommandWords,
  credentialStoreWaitNote,
  desktopGrantWordsForPlatform,
  editorNotConfiguredWords,
  ffmpegInstallCommandWords,
  gdbInstallHintWords,
  homeRepoRemovalCommands,
  mercuryInstallUpdateCommand,
  modelBankCandidateWords,
  ollamaProbeCommandWords,
  platformDisplayName,
  platformKernelLine,
  portListenerLookupCommand,
  quoteResumeTitleForShell,
  selectPlatformRemedy,
  supportedTerminalHintSuffix,
  systemBashLabel,
} from '../../src/platform/host-os/words.js'

const normSlash = (value: string): string => value.replaceAll('\\', '/')

const TENSORFOLD: Row[] = [
  {
    name: 'tensorfold.tensorFoldHasNativeEngine',
    answers: () => ({
      default: tensorFoldHasNativeEngine(),
      win32: tensorFoldHasNativeEngine('win32'),
      darwin: tensorFoldHasNativeEngine('darwin'),
      linux: tensorFoldHasNativeEngine('linux'),
    }),
    recorded: {"win32":{"default":false,"win32":false,"darwin":true,"linux":true},"darwin":{"default":true,"win32":false,"darwin":true,"linux":true},"linux":{"default":true,"win32":false,"darwin":true,"linux":true},"win32 by process.platform alone":{"default":false,"win32":false,"darwin":true,"linux":true},"win32 by getPlatform() alone":{"default":true,"win32":false,"darwin":true,"linux":true}},
  },
  {
    name: 'tensorfold.tensorFoldMachineSupportKind',
    answers: () => ({
      default: tensorFoldMachineSupportKind(),
      win32: tensorFoldMachineSupportKind('win32'),
      darwin: tensorFoldMachineSupportKind('darwin'),
      linux: tensorFoldMachineSupportKind('linux'),
      freebsd: tensorFoldMachineSupportKind('freebsd'),
    }),
    recorded: {"win32":{"default":"windows-adapter","win32":"windows-adapter","darwin":"macos-metal","linux":"linux-nvidia","freebsd":"unsupported"},"darwin":{"default":"macos-metal","win32":"windows-adapter","darwin":"macos-metal","linux":"linux-nvidia","freebsd":"unsupported"},"linux":{"default":"linux-nvidia","win32":"windows-adapter","darwin":"macos-metal","linux":"linux-nvidia","freebsd":"unsupported"},"win32 by process.platform alone":{"default":"windows-adapter","win32":"windows-adapter","darwin":"macos-metal","linux":"linux-nvidia","freebsd":"unsupported"},"win32 by getPlatform() alone":{"default":"linux-nvidia","win32":"windows-adapter","darwin":"macos-metal","linux":"linux-nvidia","freebsd":"unsupported"}},
  },
  {
    name: 'tensorfold.tensorFoldSupportsLanBrowse',
    answers: () => ({
      default: tensorFoldSupportsLanBrowse(),
      win32: tensorFoldSupportsLanBrowse('win32'),
      darwin: tensorFoldSupportsLanBrowse('darwin'),
      linux: tensorFoldSupportsLanBrowse('linux'),
    }),
    recorded: {"win32":{"default":false,"win32":false,"darwin":true,"linux":true},"darwin":{"default":true,"win32":false,"darwin":true,"linux":true},"linux":{"default":true,"win32":false,"darwin":true,"linux":true},"win32 by process.platform alone":{"default":false,"win32":false,"darwin":true,"linux":true},"win32 by getPlatform() alone":{"default":true,"win32":false,"darwin":true,"linux":true}},
  },
  {
    name: 'tensorfold.tensorFoldRuntimeDisplayPath',
    answers: () => ({
      default: tensorFoldRuntimeDisplayPath(['.mercury', 'bin', 'llama-server']),
      win32: tensorFoldRuntimeDisplayPath(['.mercury', 'bin', 'llama-server'], 'win32'),
      darwin: tensorFoldRuntimeDisplayPath(['.mercury', 'bin', 'llama-server'], 'darwin'),
      linux: tensorFoldRuntimeDisplayPath(['.mercury', 'bin', 'llama-server'], 'linux'),
    }),
    recorded: {"win32":{"default":"~\\.mercury\\bin\\llama-server","win32":"~\\.mercury\\bin\\llama-server","darwin":"~/.mercury/bin/llama-server","linux":"~/.mercury/bin/llama-server"},"darwin":{"default":"~/.mercury/bin/llama-server","win32":"~\\.mercury\\bin\\llama-server","darwin":"~/.mercury/bin/llama-server","linux":"~/.mercury/bin/llama-server"},"linux":{"default":"~/.mercury/bin/llama-server","win32":"~\\.mercury\\bin\\llama-server","darwin":"~/.mercury/bin/llama-server","linux":"~/.mercury/bin/llama-server"},"win32 by process.platform alone":{"default":"~\\.mercury\\bin\\llama-server","win32":"~\\.mercury\\bin\\llama-server","darwin":"~/.mercury/bin/llama-server","linux":"~/.mercury/bin/llama-server"},"win32 by getPlatform() alone":{"default":"~/.mercury/bin/llama-server","win32":"~\\.mercury\\bin\\llama-server","darwin":"~/.mercury/bin/llama-server","linux":"~/.mercury/bin/llama-server"}},
  },
]

const VENDORS: Row[] = [
  {
    name: 'vendors.editorCliCandidates',
    answers: () => ({
      default: editorCliCandidates(),
      win32: editorCliCandidates('win32'),
      darwin: editorCliCandidates('darwin'),
      linux: editorCliCandidates('linux'),
    }),
    recorded: {"win32":{"default":{"candidates":["code.cmd","code","code.exe","code-insiders.cmd","cursor.cmd","codium.cmd","windsurf.cmd"],"execShell":true},"win32":{"candidates":["code.cmd","code","code.exe","code-insiders.cmd","cursor.cmd","codium.cmd","windsurf.cmd"],"execShell":true},"darwin":{"candidates":["code","/usr/local/bin/code","/opt/homebrew/bin/code","/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code","code-insiders","/usr/local/bin/code-insiders","/opt/homebrew/bin/code-insiders","/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders","cursor","/usr/local/bin/cursor","/opt/homebrew/bin/cursor","/Applications/Cursor.app/Contents/Resources/app/bin/cursor","codium","/usr/local/bin/codium","/opt/homebrew/bin/codium","/Applications/VSCodium.app/Contents/Resources/app/bin/codium","windsurf","/usr/local/bin/windsurf","/opt/homebrew/bin/windsurf","/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"],"execShell":false},"linux":{"candidates":["code","/usr/local/bin/code","/opt/homebrew/bin/code","code-insiders","/usr/local/bin/code-insiders","/opt/homebrew/bin/code-insiders","cursor","/usr/local/bin/cursor","/opt/homebrew/bin/cursor","codium","/usr/local/bin/codium","/opt/homebrew/bin/codium","windsurf","/usr/local/bin/windsurf","/opt/homebrew/bin/windsurf"],"execShell":false}},"darwin":{"default":{"candidates":["code","/usr/local/bin/code","/opt/homebrew/bin/code","/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code","code-insiders","/usr/local/bin/code-insiders","/opt/homebrew/bin/code-insiders","/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders","cursor","/usr/local/bin/cursor","/opt/homebrew/bin/cursor","/Applications/Cursor.app/Contents/Resources/app/bin/cursor","codium","/usr/local/bin/codium","/opt/homebrew/bin/codium","/Applications/VSCodium.app/Contents/Resources/app/bin/codium","windsurf","/usr/local/bin/windsurf","/opt/homebrew/bin/windsurf","/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"],"execShell":false},"win32":{"candidates":["code.cmd","code","code.exe","code-insiders.cmd","cursor.cmd","codium.cmd","windsurf.cmd"],"execShell":true},"darwin":{"candidates":["code","/usr/local/bin/code","/opt/homebrew/bin/code","/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code","code-insiders","/usr/local/bin/code-insiders","/opt/homebrew/bin/code-insiders","/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders","cursor","/usr/local/bin/cursor","/opt/homebrew/bin/cursor","/Applications/Cursor.app/Contents/Resources/app/bin/cursor","codium","/usr/local/bin/codium","/opt/homebrew/bin/codium","/Applications/VSCodium.app/Contents/Resources/app/bin/codium","windsurf","/usr/local/bin/windsurf","/opt/homebrew/bin/windsurf","/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"],"execShell":false},"linux":{"candidates":["code","/usr/local/bin/code","/opt/homebrew/bin/code","code-insiders","/usr/local/bin/code-insiders","/opt/homebrew/bin/code-insiders","cursor","/usr/local/bin/cursor","/opt/homebrew/bin/cursor","codium","/usr/local/bin/codium","/opt/homebrew/bin/codium","windsurf","/usr/local/bin/windsurf","/opt/homebrew/bin/windsurf"],"execShell":false}},"linux":{"default":{"candidates":["code","/usr/local/bin/code","/opt/homebrew/bin/code","code-insiders","/usr/local/bin/code-insiders","/opt/homebrew/bin/code-insiders","cursor","/usr/local/bin/cursor","/opt/homebrew/bin/cursor","codium","/usr/local/bin/codium","/opt/homebrew/bin/codium","windsurf","/usr/local/bin/windsurf","/opt/homebrew/bin/windsurf"],"execShell":false},"win32":{"candidates":["code.cmd","code","code.exe","code-insiders.cmd","cursor.cmd","codium.cmd","windsurf.cmd"],"execShell":true},"darwin":{"candidates":["code","/usr/local/bin/code","/opt/homebrew/bin/code","/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code","code-insiders","/usr/local/bin/code-insiders","/opt/homebrew/bin/code-insiders","/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders","cursor","/usr/local/bin/cursor","/opt/homebrew/bin/cursor","/Applications/Cursor.app/Contents/Resources/app/bin/cursor","codium","/usr/local/bin/codium","/opt/homebrew/bin/codium","/Applications/VSCodium.app/Contents/Resources/app/bin/codium","windsurf","/usr/local/bin/windsurf","/opt/homebrew/bin/windsurf","/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"],"execShell":false},"linux":{"candidates":["code","/usr/local/bin/code","/opt/homebrew/bin/code","code-insiders","/usr/local/bin/code-insiders","/opt/homebrew/bin/code-insiders","cursor","/usr/local/bin/cursor","/opt/homebrew/bin/cursor","codium","/usr/local/bin/codium","/opt/homebrew/bin/codium","windsurf","/usr/local/bin/windsurf","/opt/homebrew/bin/windsurf"],"execShell":false}},"win32 by process.platform alone":{"default":{"candidates":["code.cmd","code","code.exe","code-insiders.cmd","cursor.cmd","codium.cmd","windsurf.cmd"],"execShell":true},"win32":{"candidates":["code.cmd","code","code.exe","code-insiders.cmd","cursor.cmd","codium.cmd","windsurf.cmd"],"execShell":true},"darwin":{"candidates":["code","/usr/local/bin/code","/opt/homebrew/bin/code","/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code","code-insiders","/usr/local/bin/code-insiders","/opt/homebrew/bin/code-insiders","/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders","cursor","/usr/local/bin/cursor","/opt/homebrew/bin/cursor","/Applications/Cursor.app/Contents/Resources/app/bin/cursor","codium","/usr/local/bin/codium","/opt/homebrew/bin/codium","/Applications/VSCodium.app/Contents/Resources/app/bin/codium","windsurf","/usr/local/bin/windsurf","/opt/homebrew/bin/windsurf","/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"],"execShell":false},"linux":{"candidates":["code","/usr/local/bin/code","/opt/homebrew/bin/code","code-insiders","/usr/local/bin/code-insiders","/opt/homebrew/bin/code-insiders","cursor","/usr/local/bin/cursor","/opt/homebrew/bin/cursor","codium","/usr/local/bin/codium","/opt/homebrew/bin/codium","windsurf","/usr/local/bin/windsurf","/opt/homebrew/bin/windsurf"],"execShell":false}},"win32 by getPlatform() alone":{"default":{"candidates":["code","/usr/local/bin/code","/opt/homebrew/bin/code","code-insiders","/usr/local/bin/code-insiders","/opt/homebrew/bin/code-insiders","cursor","/usr/local/bin/cursor","/opt/homebrew/bin/cursor","codium","/usr/local/bin/codium","/opt/homebrew/bin/codium","windsurf","/usr/local/bin/windsurf","/opt/homebrew/bin/windsurf"],"execShell":false},"win32":{"candidates":["code.cmd","code","code.exe","code-insiders.cmd","cursor.cmd","codium.cmd","windsurf.cmd"],"execShell":true},"darwin":{"candidates":["code","/usr/local/bin/code","/opt/homebrew/bin/code","/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code","code-insiders","/usr/local/bin/code-insiders","/opt/homebrew/bin/code-insiders","/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders","cursor","/usr/local/bin/cursor","/opt/homebrew/bin/cursor","/Applications/Cursor.app/Contents/Resources/app/bin/cursor","codium","/usr/local/bin/codium","/opt/homebrew/bin/codium","/Applications/VSCodium.app/Contents/Resources/app/bin/codium","windsurf","/usr/local/bin/windsurf","/opt/homebrew/bin/windsurf","/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"],"execShell":false},"linux":{"candidates":["code","/usr/local/bin/code","/opt/homebrew/bin/code","code-insiders","/usr/local/bin/code-insiders","/opt/homebrew/bin/code-insiders","cursor","/usr/local/bin/cursor","/opt/homebrew/bin/cursor","codium","/usr/local/bin/codium","/opt/homebrew/bin/codium","windsurf","/usr/local/bin/windsurf","/opt/homebrew/bin/windsurf"],"execShell":false}}},
  },
  {
    name: 'vendors.blenderUserConfigBase',
    answers: () => {
      const env = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', XDG_CONFIG_HOME: '/home/u/.xdg' }
      return {
        defaultWithEnv: normSlash(blenderUserConfigBase('4.2', '/home/u', env)),
        defaultNoEnv: normSlash(blenderUserConfigBase('4.2', '/home/u', {})),
        win32: normSlash(blenderUserConfigBase('4.2', '/home/u', env, 'win32')),
        darwin: normSlash(blenderUserConfigBase('4.2', '/home/u', env, 'darwin')),
        linux: normSlash(blenderUserConfigBase('4.2', '/home/u', env, 'linux')),
      }
    },
    recorded: {"win32":{"defaultWithEnv":"C:/Users/u/AppData/Roaming/Blender Foundation/Blender/4.2","defaultNoEnv":"/home/u/AppData/Roaming/Blender Foundation/Blender/4.2","win32":"C:/Users/u/AppData/Roaming/Blender Foundation/Blender/4.2","darwin":"/home/u/Library/Application Support/Blender/4.2","linux":"/home/u/.xdg/blender/4.2"},"darwin":{"defaultWithEnv":"/home/u/Library/Application Support/Blender/4.2","defaultNoEnv":"/home/u/Library/Application Support/Blender/4.2","win32":"C:/Users/u/AppData/Roaming/Blender Foundation/Blender/4.2","darwin":"/home/u/Library/Application Support/Blender/4.2","linux":"/home/u/.xdg/blender/4.2"},"linux":{"defaultWithEnv":"/home/u/.xdg/blender/4.2","defaultNoEnv":"/home/u/.config/blender/4.2","win32":"C:/Users/u/AppData/Roaming/Blender Foundation/Blender/4.2","darwin":"/home/u/Library/Application Support/Blender/4.2","linux":"/home/u/.xdg/blender/4.2"},"win32 by process.platform alone":{"defaultWithEnv":"C:/Users/u/AppData/Roaming/Blender Foundation/Blender/4.2","defaultNoEnv":"/home/u/AppData/Roaming/Blender Foundation/Blender/4.2","win32":"C:/Users/u/AppData/Roaming/Blender Foundation/Blender/4.2","darwin":"/home/u/Library/Application Support/Blender/4.2","linux":"/home/u/.xdg/blender/4.2"},"win32 by getPlatform() alone":{"defaultWithEnv":"/home/u/.xdg/blender/4.2","defaultNoEnv":"/home/u/.config/blender/4.2","win32":"C:/Users/u/AppData/Roaming/Blender Foundation/Blender/4.2","darwin":"/home/u/Library/Application Support/Blender/4.2","linux":"/home/u/.xdg/blender/4.2"}},
  },
  {
    name: 'vendors.browserDiscoveryCandidates',
    answers: stand => {
      const fam = { darwin: ['/Applications/Chrome.app'], win32: ['C:\\Chrome\\chrome.exe'], linuxBinaries: ['google-chrome'] }
      return {
        stand: browserDiscoveryCandidates(fam, stand.node),
        win32: browserDiscoveryCandidates(fam, 'win32'),
        darwin: browserDiscoveryCandidates(fam, 'darwin'),
        linux: browserDiscoveryCandidates(fam, 'linux'),
      }
    },
    recorded: {"win32":{"stand":{"kind":"paths","candidates":["C:\\Chrome\\chrome.exe"]},"win32":{"kind":"paths","candidates":["C:\\Chrome\\chrome.exe"]},"darwin":{"kind":"paths","candidates":["/Applications/Chrome.app"]},"linux":{"kind":"binaries","binaries":["google-chrome"]}},"darwin":{"stand":{"kind":"paths","candidates":["/Applications/Chrome.app"]},"win32":{"kind":"paths","candidates":["C:\\Chrome\\chrome.exe"]},"darwin":{"kind":"paths","candidates":["/Applications/Chrome.app"]},"linux":{"kind":"binaries","binaries":["google-chrome"]}},"linux":{"stand":{"kind":"binaries","binaries":["google-chrome"]},"win32":{"kind":"paths","candidates":["C:\\Chrome\\chrome.exe"]},"darwin":{"kind":"paths","candidates":["/Applications/Chrome.app"]},"linux":{"kind":"binaries","binaries":["google-chrome"]}},"win32 by process.platform alone":{"stand":{"kind":"paths","candidates":["C:\\Chrome\\chrome.exe"]},"win32":{"kind":"paths","candidates":["C:\\Chrome\\chrome.exe"]},"darwin":{"kind":"paths","candidates":["/Applications/Chrome.app"]},"linux":{"kind":"binaries","binaries":["google-chrome"]}},"win32 by getPlatform() alone":{"stand":{"kind":"binaries","binaries":["google-chrome"]},"win32":{"kind":"paths","candidates":["C:\\Chrome\\chrome.exe"]},"darwin":{"kind":"paths","candidates":["/Applications/Chrome.app"]},"linux":{"kind":"binaries","binaries":["google-chrome"]}}},
  },
  {
    name: 'vendors.chromeForTestingRelativePaths',
    answers: stand => ({
      stand: chromeForTestingRelativePaths(stand.node),
      win32: chromeForTestingRelativePaths('win32'),
      darwin: chromeForTestingRelativePaths('darwin'),
      linux: chromeForTestingRelativePaths('linux'),
    }),
    recorded: {"win32":{"stand":["chrome-win64/chrome.exe","chrome-win32/chrome.exe"],"win32":["chrome-win64/chrome.exe","chrome-win32/chrome.exe"],"darwin":["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing","chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"],"linux":["chrome-linux64/chrome","chrome-linux-arm64/chrome"]},"darwin":{"stand":["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing","chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"],"win32":["chrome-win64/chrome.exe","chrome-win32/chrome.exe"],"darwin":["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing","chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"],"linux":["chrome-linux64/chrome","chrome-linux-arm64/chrome"]},"linux":{"stand":["chrome-linux64/chrome","chrome-linux-arm64/chrome"],"win32":["chrome-win64/chrome.exe","chrome-win32/chrome.exe"],"darwin":["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing","chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"],"linux":["chrome-linux64/chrome","chrome-linux-arm64/chrome"]},"win32 by process.platform alone":{"stand":["chrome-win64/chrome.exe","chrome-win32/chrome.exe"],"win32":["chrome-win64/chrome.exe","chrome-win32/chrome.exe"],"darwin":["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing","chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"],"linux":["chrome-linux64/chrome","chrome-linux-arm64/chrome"]},"win32 by getPlatform() alone":{"stand":["chrome-linux64/chrome","chrome-linux-arm64/chrome"],"win32":["chrome-win64/chrome.exe","chrome-win32/chrome.exe"],"darwin":["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing","chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"],"linux":["chrome-linux64/chrome","chrome-linux-arm64/chrome"]}},
  },
  {
    name: 'vendors.ollamaWindowsExeCandidate',
    answers: () => ({
      default: ollamaWindowsExeCandidate({}, 'C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe'),
      win32: ollamaWindowsExeCandidate({}, 'C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe', 'win32'),
      darwin: ollamaWindowsExeCandidate({}, 'C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe', 'darwin'),
      linux: ollamaWindowsExeCandidate({}, 'C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe', 'linux'),
    }),
    recorded: {"win32":{"default":"C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe","win32":"C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe","darwin":null,"linux":null},"darwin":{"default":null,"win32":"C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe","darwin":null,"linux":null},"linux":{"default":null,"win32":"C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe","darwin":null,"linux":null},"win32 by process.platform alone":{"default":"C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe","win32":"C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe","darwin":null,"linux":null},"win32 by getPlatform() alone":{"default":null,"win32":"C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe","darwin":null,"linux":null}},
  },
  {
    name: 'vendors.godotWellKnownRootsForPlatform',
    answers: () => {
      const env = {
        HOME: '/home/u',
        USERPROFILE: 'C:\\Users\\u',
        LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        ProgramData: 'C:\\ProgramData',
      }
      return {
        default: godotWellKnownRootsForPlatform(undefined, env),
        win32: godotWellKnownRootsForPlatform('win32', env),
        darwin: godotWellKnownRootsForPlatform('darwin', env),
        linux: godotWellKnownRootsForPlatform('linux', env),
      }
    },
    recorded: {"win32":{"default":["C:\\Users\\u\\AppData\\Local\\Programs\\Godot","C:\\Program Files\\Godot","C:\\Program Files (x86)\\Godot","C:\\Program Files (x86)\\Steam\\steamapps\\common\\Godot Engine","C:\\Program Files\\Steam\\steamapps\\common\\Godot Engine","C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links","C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages","C:\\Users\\u\\scoop\\shims","C:\\Users\\u\\scoop\\apps\\godot\\current","C:\\ProgramData\\chocolatey\\bin"],"win32":["C:\\Users\\u\\AppData\\Local\\Programs\\Godot","C:\\Program Files\\Godot","C:\\Program Files (x86)\\Godot","C:\\Program Files (x86)\\Steam\\steamapps\\common\\Godot Engine","C:\\Program Files\\Steam\\steamapps\\common\\Godot Engine","C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links","C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages","C:\\Users\\u\\scoop\\shims","C:\\Users\\u\\scoop\\apps\\godot\\current","C:\\ProgramData\\chocolatey\\bin"],"darwin":["/Applications","/home/u/Applications","/home/u/Library/Application Support/Steam/steamapps/common/Godot Engine","/opt/homebrew/bin","/usr/local/bin"],"linux":["/home/u/.local/bin","/usr/local/bin","/usr/bin","/var/lib/flatpak/exports/bin","/home/u/.local/share/flatpak/exports/bin","/home/u/.steam/steam/steamapps/common/Godot Engine","/home/u/.local/share/Steam/steamapps/common/Godot Engine","/home/u/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Godot Engine"]},"darwin":{"default":["/Applications","/home/u/Applications","/home/u/Library/Application Support/Steam/steamapps/common/Godot Engine","/opt/homebrew/bin","/usr/local/bin"],"win32":["C:\\Users\\u\\AppData\\Local\\Programs\\Godot","C:\\Program Files\\Godot","C:\\Program Files (x86)\\Godot","C:\\Program Files (x86)\\Steam\\steamapps\\common\\Godot Engine","C:\\Program Files\\Steam\\steamapps\\common\\Godot Engine","C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links","C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages","C:\\Users\\u\\scoop\\shims","C:\\Users\\u\\scoop\\apps\\godot\\current","C:\\ProgramData\\chocolatey\\bin"],"darwin":["/Applications","/home/u/Applications","/home/u/Library/Application Support/Steam/steamapps/common/Godot Engine","/opt/homebrew/bin","/usr/local/bin"],"linux":["/home/u/.local/bin","/usr/local/bin","/usr/bin","/var/lib/flatpak/exports/bin","/home/u/.local/share/flatpak/exports/bin","/home/u/.steam/steam/steamapps/common/Godot Engine","/home/u/.local/share/Steam/steamapps/common/Godot Engine","/home/u/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Godot Engine"]},"linux":{"default":["/home/u/.local/bin","/usr/local/bin","/usr/bin","/var/lib/flatpak/exports/bin","/home/u/.local/share/flatpak/exports/bin","/home/u/.steam/steam/steamapps/common/Godot Engine","/home/u/.local/share/Steam/steamapps/common/Godot Engine","/home/u/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Godot Engine"],"win32":["C:\\Users\\u\\AppData\\Local\\Programs\\Godot","C:\\Program Files\\Godot","C:\\Program Files (x86)\\Godot","C:\\Program Files (x86)\\Steam\\steamapps\\common\\Godot Engine","C:\\Program Files\\Steam\\steamapps\\common\\Godot Engine","C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links","C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages","C:\\Users\\u\\scoop\\shims","C:\\Users\\u\\scoop\\apps\\godot\\current","C:\\ProgramData\\chocolatey\\bin"],"darwin":["/Applications","/home/u/Applications","/home/u/Library/Application Support/Steam/steamapps/common/Godot Engine","/opt/homebrew/bin","/usr/local/bin"],"linux":["/home/u/.local/bin","/usr/local/bin","/usr/bin","/var/lib/flatpak/exports/bin","/home/u/.local/share/flatpak/exports/bin","/home/u/.steam/steam/steamapps/common/Godot Engine","/home/u/.local/share/Steam/steamapps/common/Godot Engine","/home/u/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Godot Engine"]},"win32 by process.platform alone":{"default":["C:\\Users\\u\\AppData\\Local\\Programs\\Godot","C:\\Program Files\\Godot","C:\\Program Files (x86)\\Godot","C:\\Program Files (x86)\\Steam\\steamapps\\common\\Godot Engine","C:\\Program Files\\Steam\\steamapps\\common\\Godot Engine","C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links","C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages","C:\\Users\\u\\scoop\\shims","C:\\Users\\u\\scoop\\apps\\godot\\current","C:\\ProgramData\\chocolatey\\bin"],"win32":["C:\\Users\\u\\AppData\\Local\\Programs\\Godot","C:\\Program Files\\Godot","C:\\Program Files (x86)\\Godot","C:\\Program Files (x86)\\Steam\\steamapps\\common\\Godot Engine","C:\\Program Files\\Steam\\steamapps\\common\\Godot Engine","C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links","C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages","C:\\Users\\u\\scoop\\shims","C:\\Users\\u\\scoop\\apps\\godot\\current","C:\\ProgramData\\chocolatey\\bin"],"darwin":["/Applications","/home/u/Applications","/home/u/Library/Application Support/Steam/steamapps/common/Godot Engine","/opt/homebrew/bin","/usr/local/bin"],"linux":["/home/u/.local/bin","/usr/local/bin","/usr/bin","/var/lib/flatpak/exports/bin","/home/u/.local/share/flatpak/exports/bin","/home/u/.steam/steam/steamapps/common/Godot Engine","/home/u/.local/share/Steam/steamapps/common/Godot Engine","/home/u/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Godot Engine"]},"win32 by getPlatform() alone":{"default":["/home/u/.local/bin","/usr/local/bin","/usr/bin","/var/lib/flatpak/exports/bin","/home/u/.local/share/flatpak/exports/bin","/home/u/.steam/steam/steamapps/common/Godot Engine","/home/u/.local/share/Steam/steamapps/common/Godot Engine","/home/u/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Godot Engine"],"win32":["C:\\Users\\u\\AppData\\Local\\Programs\\Godot","C:\\Program Files\\Godot","C:\\Program Files (x86)\\Godot","C:\\Program Files (x86)\\Steam\\steamapps\\common\\Godot Engine","C:\\Program Files\\Steam\\steamapps\\common\\Godot Engine","C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links","C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages","C:\\Users\\u\\scoop\\shims","C:\\Users\\u\\scoop\\apps\\godot\\current","C:\\ProgramData\\chocolatey\\bin"],"darwin":["/Applications","/home/u/Applications","/home/u/Library/Application Support/Steam/steamapps/common/Godot Engine","/opt/homebrew/bin","/usr/local/bin"],"linux":["/home/u/.local/bin","/usr/local/bin","/usr/bin","/var/lib/flatpak/exports/bin","/home/u/.local/share/flatpak/exports/bin","/home/u/.steam/steam/steamapps/common/Godot Engine","/home/u/.local/share/Steam/steamapps/common/Godot Engine","/home/u/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Godot Engine"]}},
  },
  {
    name: 'vendors.godotPackageAndExePredicates',
    answers: () => ({
      wingetDefault: [isWinGetGodotPackageDir('godotengine.godot'), isWinGetGodotPackageDir('godot')],
      wingetWin32: [isWinGetGodotPackageDir('godotengine.godot', 'win32'), isWinGetGodotPackageDir('godot', 'win32')],
      exeDefault: [godotBinaryNeedsExeSuffix('godot'), godotBinaryNeedsExeSuffix('godot.exe')],
      exeWin32: [godotBinaryNeedsExeSuffix('godot', 'win32'), godotBinaryNeedsExeSuffix('godot.exe', 'win32')],
    }),
    recorded: {"win32":{"wingetDefault":[true,false],"wingetWin32":[true,false],"exeDefault":[true,false],"exeWin32":[true,false]},"darwin":{"wingetDefault":[false,false],"wingetWin32":[true,false],"exeDefault":[false,false],"exeWin32":[true,false]},"linux":{"wingetDefault":[false,false],"wingetWin32":[true,false],"exeDefault":[false,false],"exeWin32":[true,false]},"win32 by process.platform alone":{"wingetDefault":[true,false],"wingetWin32":[true,false],"exeDefault":[true,false],"exeWin32":[true,false]},"win32 by getPlatform() alone":{"wingetDefault":[false,false],"wingetWin32":[true,false],"exeDefault":[false,false],"exeWin32":[true,false]}},
  },
  {
    name: 'vendors.asepriteInstallCandidates',
    answers: () => {
      const env = {
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      }
      return {
        steamDefault: asepriteSteamInstallCandidates(undefined, '/home/u', env).map(normSlash),
        winDefault: asepriteWindowsInstallCandidates(undefined, undefined, '/home/u', env).map(c => ({ candidate: normSlash(c.candidate), source: c.source })),
        winOverride: asepriteWindowsInstallCandidates('win32', [{ candidate: 'D:/aseprite.exe', source: 'itch' }], '/home/u', env),
      }
    },
    recorded: {"win32":{"steamDefault":["C:/Program Files (x86)/Steam/steamapps/common/Aseprite/Aseprite.exe","C:/Program Files/Steam/steamapps/common/Aseprite/Aseprite.exe"],"winDefault":[{"candidate":"C:/Program Files/Aseprite/Aseprite.exe","source":"program-files"},{"candidate":"C:/Program Files (x86)/Aseprite/Aseprite.exe","source":"program-files"},{"candidate":"C:/Users/u/AppData/Local/itch/apps/aseprite/Aseprite.exe","source":"itch"}],"winOverride":[{"candidate":"D:/aseprite.exe","source":"itch"}]},"darwin":{"steamDefault":["/home/u/Library/Application Support/Steam/steamapps/common/Aseprite/Aseprite.app/Contents/MacOS/aseprite"],"winDefault":[],"winOverride":[{"candidate":"D:/aseprite.exe","source":"itch"}]},"linux":{"steamDefault":["/home/u/.steam/steam/steamapps/common/Aseprite/aseprite","/home/u/.local/share/Steam/steamapps/common/Aseprite/aseprite"],"winDefault":[],"winOverride":[{"candidate":"D:/aseprite.exe","source":"itch"}]},"win32 by process.platform alone":{"steamDefault":["C:/Program Files (x86)/Steam/steamapps/common/Aseprite/Aseprite.exe","C:/Program Files/Steam/steamapps/common/Aseprite/Aseprite.exe"],"winDefault":[{"candidate":"C:/Program Files/Aseprite/Aseprite.exe","source":"program-files"},{"candidate":"C:/Program Files (x86)/Aseprite/Aseprite.exe","source":"program-files"},{"candidate":"C:/Users/u/AppData/Local/itch/apps/aseprite/Aseprite.exe","source":"itch"}],"winOverride":[{"candidate":"D:/aseprite.exe","source":"itch"}]},"win32 by getPlatform() alone":{"steamDefault":["/home/u/.steam/steam/steamapps/common/Aseprite/aseprite","/home/u/.local/share/Steam/steamapps/common/Aseprite/aseprite"],"winDefault":[],"winOverride":[{"candidate":"D:/aseprite.exe","source":"itch"}]}},
  },
  {
    name: 'vendors.blenderProgramFilesRoot',
    answers: () => {
      const env = { ProgramFiles: 'C:\\Program Files' }
      const raw = blenderProgramFilesRoot(undefined, undefined, env)
      return {
        default: raw === null ? null : normSlash(raw),
        override: blenderProgramFilesRoot(undefined, 'D:/Blender', env),
      }
    },
    recorded: {"win32":{"default":"C:/Program Files/Blender Foundation","override":"D:/Blender"},"darwin":{"default":null,"override":null},"linux":{"default":null,"override":null},"win32 by process.platform alone":{"default":"C:/Program Files/Blender Foundation","override":"D:/Blender"},"win32 by getPlatform() alone":{"default":null,"override":null}},
  },
  {
    name: 'vendors.unityPaths',
    answers: () => {
      const env = { ProgramFiles: 'C:\\Program Files' }
      return {
        rootsDefault: unityHubEditorRoots(undefined, '/home/u', env).map(normSlash),
        exeDefault: normSlash(unityEditorExecutablePath('/opt/unity/6000.0', undefined)),
      }
    },
    recorded: {"win32":{"rootsDefault":["C:/Program Files/Unity/Hub/Editor"],"exeDefault":"/opt/unity/6000.0/Editor/Unity.exe"},"darwin":{"rootsDefault":["/Applications/Unity/Hub/Editor"],"exeDefault":"/opt/unity/6000.0/Unity.app/Contents/MacOS/Unity"},"linux":{"rootsDefault":["/home/u/Unity/Hub/Editor"],"exeDefault":"/opt/unity/6000.0/Editor/Unity"},"win32 by process.platform alone":{"rootsDefault":["C:/Program Files/Unity/Hub/Editor"],"exeDefault":"/opt/unity/6000.0/Editor/Unity.exe"},"win32 by getPlatform() alone":{"rootsDefault":["/home/u/Unity/Hub/Editor"],"exeDefault":"/opt/unity/6000.0/Editor/Unity"}},
  },
]

const WORDS: Row[] = [
  {
    name: 'words.labelsAndHints',
    answers: () => ({
      display: [platformDisplayName(), platformDisplayName('win32'), platformDisplayName('darwin'), platformDisplayName('linux'), platformDisplayName('freebsd')],
      bash: systemBashLabel(),
      termHint: supportedTerminalHintSuffix(),
      credNote: credentialStoreWaitNote(),
      gdb: gdbInstallHintWords(),
      desktopGrant: desktopGrantWordsForPlatform(),
      brush: brushPackRemedyWords(),
      bank: modelBankCandidateWords(),
      ffmpeg: ffmpegInstallCommandWords(),
      remedy: [selectPlatformRemedy('posix-cmd', 'win-cmd'), selectPlatformRemedy('posix-cmd', undefined)],
      accessDenied: accessDeniedErrorHint(),
    }),
    recorded: {"win32":{"display":["Windows","Windows","macOS","Linux","freebsd"],"bash":"an installed bash","termHint":" (the stable Windows Terminal or your editor’s integrated terminal; PowerShell 7 preferred)","credNote":"checking the credential store and managed settings…","gdb":"install gdb 14+ from MSYS2 (pacman -S mingw-w64-ucrt-x86_64-gdb) — the first release with the native -i=dap interpreter","desktopGrant":"run Mercury from an interactive desktop session (not a service, not a locked desktop); input into an elevated window needs an elevated terminal","brush":"Build the pack: bun run scripts/vendor/build-brush.ts, then rebuild — a release archive carries it.","bank":"~\\mercury-model-bank or ~\\models","ffmpeg":"winget install ffmpeg","remedy":["win-cmd","posix-cmd"],"accessDenied":["/\\bEACCES\\b|\\bEPERM\\b|\\bEBUSY\\b/","file in use: on Windows another program often holds a brief lock (antivirus, search indexer, or open handle). Mercury retried; if it persists, close the holder or exclude the folder from real-time scanning"]},"darwin":{"display":["macOS","Windows","macOS","Linux","freebsd"],"bash":"the system's bash","termHint":"","credNote":"checking the system keychain and managed settings…","gdb":"install gdb 14+ (the first release with the native -i=dap interpreter)","desktopGrant":"allow your terminal application under System Settings → Privacy & Security → Screen Recording and → Accessibility, then restart the terminal application","brush":"Fetch the pack: bun run scripts/vendor/fetch-brush.ts, then rebuild.","bank":"~/mercury-model-bank, ~/models, /Volumes/*/mercury-model-bank or /mnt/*/mercury-model-bank","ffmpeg":"brew install ffmpeg","remedy":["posix-cmd","posix-cmd"],"accessDenied":["/\\bEACCES\\b|\\bEPERM\\b/","permission denied — check file modes/ownership"]},"linux":{"display":["Linux","Windows","macOS","Linux","freebsd"],"bash":"the system's bash","termHint":"","credNote":"checking the system keychain and managed settings…","gdb":"install gdb 14+ (the first release with the native -i=dap interpreter)","desktopGrant":"an X11 session with DISPLAY set; Wayland sessions are refused","brush":"Fetch the pack: bun run scripts/vendor/fetch-brush.ts, then rebuild.","bank":"~/mercury-model-bank, ~/models, /Volumes/*/mercury-model-bank or /mnt/*/mercury-model-bank","ffmpeg":"apt install ffmpeg","remedy":["posix-cmd","posix-cmd"],"accessDenied":["/\\bEACCES\\b|\\bEPERM\\b/","permission denied — check file modes/ownership"]},"win32 by process.platform alone":{"display":["Windows","Windows","macOS","Linux","freebsd"],"bash":"an installed bash","termHint":" (the stable Windows Terminal or your editor’s integrated terminal; PowerShell 7 preferred)","credNote":"checking the credential store and managed settings…","gdb":"install gdb 14+ from MSYS2 (pacman -S mingw-w64-ucrt-x86_64-gdb) — the first release with the native -i=dap interpreter","desktopGrant":"run Mercury from an interactive desktop session (not a service, not a locked desktop); input into an elevated window needs an elevated terminal","brush":"Build the pack: bun run scripts/vendor/build-brush.ts, then rebuild — a release archive carries it.","bank":"~\\mercury-model-bank or ~\\models","ffmpeg":"winget install ffmpeg","remedy":["win-cmd","posix-cmd"],"accessDenied":["/\\bEACCES\\b|\\bEPERM\\b|\\bEBUSY\\b/","file in use: on Windows another program often holds a brief lock (antivirus, search indexer, or open handle). Mercury retried; if it persists, close the holder or exclude the folder from real-time scanning"]},"win32 by getPlatform() alone":{"display":["Linux","Windows","macOS","Linux","freebsd"],"bash":"the system's bash","termHint":"","credNote":"checking the system keychain and managed settings…","gdb":"install gdb 14+ (the first release with the native -i=dap interpreter)","desktopGrant":"an X11 session with DISPLAY set; Wayland sessions are refused","brush":"Fetch the pack: bun run scripts/vendor/fetch-brush.ts, then rebuild.","bank":"~/mercury-model-bank, ~/models, /Volumes/*/mercury-model-bank or /mnt/*/mercury-model-bank","ffmpeg":"apt install ffmpeg","remedy":["posix-cmd","posix-cmd"],"accessDenied":["/\\bEACCES\\b|\\bEPERM\\b/","permission denied — check file modes/ownership"]}},
  },
  {
    name: 'words.platformKernelLine',
    answers: () => ({
      defaultIsWinForm: platformKernelLine() === `${hostOsVersion()} ${hostOsRelease()}`,
      defaultIsPosixForm: platformKernelLine() === `${hostOsType()} ${hostOsRelease()}`,
      win32IsWinForm: platformKernelLine('win32') === `${hostOsVersion()} ${hostOsRelease()}`,
      linuxIsPosixForm: platformKernelLine('linux') === `${hostOsType()} ${hostOsRelease()}`,
    }),
    recorded: {"win32":{"defaultIsWinForm":true,"defaultIsPosixForm":false,"win32IsWinForm":true,"linuxIsPosixForm":true},"darwin":{"defaultIsWinForm":false,"defaultIsPosixForm":true,"win32IsWinForm":true,"linuxIsPosixForm":true},"linux":{"defaultIsWinForm":false,"defaultIsPosixForm":true,"win32IsWinForm":true,"linuxIsPosixForm":true},"win32 by process.platform alone":{"defaultIsWinForm":true,"defaultIsPosixForm":false,"win32IsWinForm":true,"linuxIsPosixForm":true},"win32 by getPlatform() alone":{"defaultIsWinForm":false,"defaultIsPosixForm":true,"win32IsWinForm":true,"linuxIsPosixForm":true}},
  },
  {
    name: 'words.commandsAndQuoting',
    answers: () => ({
      clearEnv: clearEnvVarCommandWords('OPENAI_API_KEY'),
      portLookup: portListenerLookupCommand(4321),
      editorHint: editorNotConfiguredWords('/tmp/out.txt'),
      homeRepoRoot: homeRepoRemovalCommands([]),
      homeRepoSub: homeRepoRemovalCommands(['project']),
      quote: quoteResumeTitleForShell("it's a $test \"quote\""),
      ollama: ollamaProbeCommandWords(process.platform, '/home/u', ' · brew list --formula ollama', 'C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe'),
      updateWinget: mercuryInstallUpdateCommand('C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\MercuryCLI.MercuryCLI_abc\\mercury.exe'),
      updateDefault: mercuryInstallUpdateCommand('/usr/local/bin/mercury'),
    }),
    recorded: {"win32":{"clearEnv":"clear OPENAI_API_KEY (PowerShell: Remove-Item Env:\\OPENAI_API_KEY · cmd: set OPENAI_API_KEY=)","portLookup":"netstat -ano | findstr :4321","editorHint":"written to /tmp/out.txt — set EDITOR (or VISUAL) to open it","homeRepoRoot":{"inspect":"git -C $env:USERPROFILE log --oneline","remove":"Remove-Item -Recurse -Force ([IO.Path]::Combine($env:USERPROFILE, '.git'))"},"homeRepoSub":{"inspect":"git -C ([IO.Path]::Combine($env:USERPROFILE, 'project')) log --oneline","remove":"Remove-Item -Recurse -Force ([IO.Path]::Combine($env:USERPROFILE, 'project', '.git'))"},"quote":"'it''s a $test \"quote\"'","ollama":"where ollama · dir \"C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe\"","updateWinget":"winget upgrade MercuryCLI.MercuryCLI","updateDefault":"irm https://mercury-cli.ai/install.ps1 | iex"},"darwin":{"clearEnv":"unset OPENAI_API_KEY","portLookup":"lsof -ti:4321 -sTCP:LISTEN","editorHint":"written to /tmp/out.txt — set $EDITOR to open it","homeRepoRoot":{"inspect":"git -C \"$HOME\" log --oneline","remove":"rm -rf \"$HOME/.git\""},"homeRepoSub":{"inspect":"git -C \"$HOME/project\" log --oneline","remove":"rm -rf \"$HOME/project/.git\""},"quote":"\"it's a \"'$'\"test \\\"quote\\\"\"","ollama":"which ollama · ls /Applications/Ollama.app /home/u/Applications/Ollama.app · brew list --formula ollama","updateWinget":"curl -fsSL https://mercury-cli.ai/install.sh | sh","updateDefault":"curl -fsSL https://mercury-cli.ai/install.sh | sh"},"linux":{"clearEnv":"unset OPENAI_API_KEY","portLookup":"lsof -ti:4321 -sTCP:LISTEN","editorHint":"written to /tmp/out.txt — set $EDITOR to open it","homeRepoRoot":{"inspect":"git -C \"$HOME\" log --oneline","remove":"rm -rf \"$HOME/.git\""},"homeRepoSub":{"inspect":"git -C \"$HOME/project\" log --oneline","remove":"rm -rf \"$HOME/project/.git\""},"quote":"\"it's a \"'$'\"test \\\"quote\\\"\"","ollama":"which ollama · systemctl status ollama · ls /usr/local/bin/ollama /usr/bin/ollama · brew list --formula ollama","updateWinget":"curl -fsSL https://mercury-cli.ai/install.sh | sh","updateDefault":"curl -fsSL https://mercury-cli.ai/install.sh | sh"},"win32 by process.platform alone":{"clearEnv":"clear OPENAI_API_KEY (PowerShell: Remove-Item Env:\\OPENAI_API_KEY · cmd: set OPENAI_API_KEY=)","portLookup":"netstat -ano | findstr :4321","editorHint":"written to /tmp/out.txt — set EDITOR (or VISUAL) to open it","homeRepoRoot":{"inspect":"git -C $env:USERPROFILE log --oneline","remove":"Remove-Item -Recurse -Force ([IO.Path]::Combine($env:USERPROFILE, '.git'))"},"homeRepoSub":{"inspect":"git -C ([IO.Path]::Combine($env:USERPROFILE, 'project')) log --oneline","remove":"Remove-Item -Recurse -Force ([IO.Path]::Combine($env:USERPROFILE, 'project', '.git'))"},"quote":"'it''s a $test \"quote\"'","ollama":"where ollama · dir \"C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe\"","updateWinget":"winget upgrade MercuryCLI.MercuryCLI","updateDefault":"irm https://mercury-cli.ai/install.ps1 | iex"},"win32 by getPlatform() alone":{"clearEnv":"unset OPENAI_API_KEY","portLookup":"lsof -ti:4321 -sTCP:LISTEN","editorHint":"written to /tmp/out.txt — set $EDITOR to open it","homeRepoRoot":{"inspect":"git -C \"$HOME\" log --oneline","remove":"rm -rf \"$HOME/.git\""},"homeRepoSub":{"inspect":"git -C \"$HOME/project\" log --oneline","remove":"rm -rf \"$HOME/project/.git\""},"quote":"\"it's a \"'$'\"test \\\"quote\\\"\"","ollama":"which ollama · systemctl status ollama · ls /usr/local/bin/ollama /usr/bin/ollama · brew list --formula ollama","updateWinget":"curl -fsSL https://mercury-cli.ai/install.sh | sh","updateDefault":"curl -fsSL https://mercury-cli.ai/install.sh | sh"}},
  },
]

import {
  argv0EnvAssignmentBody,
  carriesBashLoginExports,
  isHostPosixBash,
  loginGroupMarkLine,
  loginRunGetsOwnProcessGroup,
  loginRunScriptFilePath,
  loginRunUsesProcessTreeCleanup,
  remembersFailedLoginRun,
  snapshotAliasPipelineFilter,
  snapshotPathNeedsShellProbe,
} from '../../src/platform/host-os/loginShell.js'
import { isCmdDriveSwitchCd, readWorldUsesWindowsForms, shellFolderComparisonKey } from '../../src/platform/host-os/commandForms.js'
import {
  wardEnvHomePath,
  wardExpandMsysDrivePrefix,
  wardNormalizedSlashedPath,
  wardPathFoldsCase,
  wardPosixWorldCwd,
  wardShareSegmentCountIsRoot,
  wardTracksWindowsStandingFolder,
  wardUnresolvedWindowsWordFallsThrough,
  wardUsesWindowsDeletePatterns,
  wardWindowsHomeEnv,
  wardWordIsWindowsShaped,
} from '../../src/platform/host-os/wards.js'
import { hostEnv as row8HostEnv } from '../../src/platform/environment/hostEnv.js'

const ROW8_NODE_PLATFORMS: readonly NodeJS.Platform[] = ['win32', 'darwin', 'linux']
const ROW8_GIVEN_PLATFORMS: ReadonlyArray<string | undefined> = [undefined, 'windows', 'macos', 'linux']
const ROW8_ORIGINS: readonly string[] = ['engine', 'path', 'env']
const ROW8_ZSH: ReadonlyArray<string | null> = [null, '/bin/zsh']
const ROW8_FOLDERS: readonly string[] = ['C:\\Users\\U\\proj\\', 'c:\\users\\u\\proj', 'D:\\', '\\\\server\\share\\x', '/home/u/proj/', '/c/Users/U', 'relative\\dir', '']
const ROW8_OPERANDS: ReadonlyArray<readonly string[]> = [['/d', 'D:\\src'], ['/D', 'D:\\src'], ['/d'], ['D:\\src'], ['/d', 'a', 'b'], ['-', 'x'], []]
const ROW8_TEXTS: readonly string[] = ['C:\\Users\\Other\\Docs', '/c/Users/Other', '/c', '/usr/local', '//server/share', 'Relative\\Path', '~/x', '']
const ROW8_WORDS: readonly string[] = ['C:\\x', 'c:', '%USERPROFILE%\\x', '$env:USERPROFILE', '${env:HOME}', '\\\\server\\share', '/c/Users', '/c', '//server/x', '~', '~/x', '~\\x', '$HOME/x', '${HOME}', '/usr/local', 'docs', '']
const ROW8_ENVS: ReadonlyArray<NodeJS.ProcessEnv> = [{ HOME: '/home/u', USERPROFILE: 'C:\\Users\\U' }, { HOME: '/home/u' }, { USERPROFILE: 'C:\\Users\\U' }, { HOME: '', USERPROFILE: '' }, {}]

const LOGIN_SHELL: Row[] = [
  {
    name: 'loginShell.loginRunGetsOwnProcessGroup',
    answers: () => [true, false].map(login => loginRunGetsOwnProcessGroup(login)),
    old: () => [true, false].map(login => login && getPlatform() !== 'windows'),
  },
  {
    name: 'loginShell.loginRunUsesProcessTreeCleanup',
    answers: () => [true, false].map(login => loginRunUsesProcessTreeCleanup(login)),
    old: () => [true, false].map(login => login && getPlatform() === 'windows'),
  },
  {
    name: 'loginShell.snapshotPathNeedsShellProbe',
    answers: () => ROW8_GIVEN_PLATFORMS.map(given => !snapshotPathNeedsShellProbe(given)),
    old: () =>
      ROW8_GIVEN_PLATFORMS.map(given => {
        const platform = given ?? getPlatform()
        return platform !== 'windows'
      }),
  },
  {
    name: 'loginShell.argv0EnvAssignmentBody',
    answers: () => {
      const [functionName, argv0Name, quotedBinary, prepend] = ['fn', 'argv0', "'/bin/x'", 'a b ']
      const body = argv0EnvAssignmentBody(argv0Name, quotedBinary, prepend) ?? 'BODY'
      return `${functionName}() {
${body}
}`
    },
    old: () => {
      const [functionName, argv0Name, quotedBinary, prepend] = ['fn', 'argv0', "'/bin/x'", 'a b ']
      if (getPlatform() === 'windows') {
        return `${functionName}() {
  ARGV0=${argv0Name} ${quotedBinary} ${prepend}"$@"
}`
      }
      return `${functionName}() {
BODY
}`
    },
  },
  {
    name: 'loginShell.loginGroupMarkLine',
    answers: () => {
      const lines: string[] = []
      const groupMark = loginGroupMarkLine('MERCURY_LOGIN_GROUP')
      if (groupMark !== undefined) lines.push(groupMark)
      return lines
    },
    old: () => {
      const LOGIN_GROUP_MARK = 'MERCURY_LOGIN_GROUP'
      const lines: string[] = []
      if (getPlatform() === 'windows') lines.push(`echo "${LOGIN_GROUP_MARK}=$$"`)
      return lines
    },
  },
  {
    name: 'loginShell.snapshotAliasPipelineFilter',
    answers: () => snapshotAliasPipelineFilter(),
    old: () => (getPlatform() === 'windows' ? ' | grep -v winpty' : ''),
  },
  {
    name: 'loginShell.isHostPosixBash',
    answers: () => ROW8_ORIGINS.map(origin => isHostPosixBash(origin)),
    old: () => ROW8_ORIGINS.map(origin => origin !== 'engine' && getPlatform() !== 'windows'),
  },
  {
    name: 'loginShell.loginRunScriptFilePath',
    answers: () => ROW8_ORIGINS.map(origin => loginRunScriptFilePath('/s/snapshot-bash.sh', origin)),
    old: () =>
      ROW8_ORIGINS.map(origin => {
        const snapshotFilePath = '/s/snapshot-bash.sh'
        return getPlatform() === 'windows' && origin !== 'engine' ? `${snapshotFilePath}.login-run` : undefined
      }),
  },
  {
    name: 'loginShell.carriesBashLoginExports',
    answers: () => [true, false].flatMap(session => ROW8_ZSH.flatMap(zsh => ROW8_ORIGINS.map(origin => carriesBashLoginExports(session, zsh !== null, origin)))),
    old: () => [true, false].flatMap(session => ROW8_ZSH.flatMap(zsh => ROW8_ORIGINS.map(origin => session && zsh === null && !(origin === 'engine' && getPlatform() === 'windows')))),
  },
  {
    name: 'loginShell.remembersFailedLoginRun',
    answers: () => [true, false].map(session => remembersFailedLoginRun(session)),
    old: () => [true, false].map(session => session && getPlatform() === 'windows'),
  },
]

const COMMAND_FORMS: Row[] = [
  {
    name: 'commandForms.isCmdDriveSwitchCd',
    answers: () => ROW8_OPERANDS.map(operands => isCmdDriveSwitchCd(operands)),
    old: () => ROW8_OPERANDS.map(operands => process.platform === 'win32' && operands.length === 2 && /^\/d$/i.test(operands[0]!)),
  },
  {
    name: 'commandForms.readWorldUsesWindowsForms',
    answers: () => ({ windows: readWorldUsesWindowsForms() }),
    old: () => ({ windows: process.platform === 'win32' }),
  },
  {
    name: 'commandForms.shellFolderComparisonKey',
    answers: () => ROW8_FOLDERS.map(path => shellFolderComparisonKey(path)),
    old: () =>
      ROW8_FOLDERS.map(path => {
        if (getPlatform() !== 'windows') return path
        const posix = windowsPathToPosixPath(path).replace(/^\/([A-Za-z])(?=\/|$)/, (_, drive: string) => `/${drive.toLowerCase()}`)
        return posix.length > 1 && posix.endsWith('/') ? posix.slice(0, -1) : posix
      }),
  },
  {
    name: 'paths.nativePathToShell where bashPermissions spells the folder of a cd',
    answers: () => ROW8_FOLDERS.map(cwd => nativePathToShell(cwd)),
    old: () => ROW8_FOLDERS.map(cwd => (getPlatform() === 'windows' ? windowsPathToPosixPath(cwd) : cwd)),
  },
]

const WARDS: Row[] = [
  {
    name: 'wards.wardPathFoldsCase',
    answers: () => [wardPathFoldsCase(), ...ROW8_NODE_PLATFORMS.map(platform => wardPathFoldsCase(platform))],
    old: () => [process.platform === 'darwin' || process.platform === 'win32', ...ROW8_NODE_PLATFORMS.map(platform => platform === 'darwin' || platform === 'win32')],
  },
  {
    name: 'wards.wardNormalizedSlashedPath',
    answers: () => [...ROW8_TEXTS.map(path => wardNormalizedSlashedPath(path)), ...ROW8_NODE_PLATFORMS.flatMap(platform => ROW8_TEXTS.map(text => wardNormalizedSlashedPath(text, platform)))],
    old: () => [
      ...ROW8_TEXTS.map(path => (process.platform === 'win32' ? path.replace(/\\/g, '/').toLowerCase() : path.replace(/\\/g, '/'))),
      ...ROW8_NODE_PLATFORMS.flatMap(platform => ROW8_TEXTS.map(text => (platform === 'win32' ? text.replace(/\\/g, '/').toLowerCase() : text.replace(/\\/g, '/')))),
    ],
  },
  {
    name: 'wards.wardEnvHomePath',
    answers: () => [wardEnvHomePath() === (process.platform === 'win32' ? row8HostEnv().USERPROFILE || row8HostEnv().HOME : row8HostEnv().HOME || row8HostEnv().USERPROFILE), ...ROW8_ENVS.map(env => wardEnvHomePath(env))],
    old: () => [true, ...ROW8_ENVS.map(env => (process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE))],
  },
  {
    name: 'wards.wardWindowsHomeEnv',
    answers: () => ROW8_NODE_PLATFORMS.flatMap(platform => ROW8_ENVS.map(env => wardWindowsHomeEnv(env, platform))),
    old: () => ROW8_NODE_PLATFORMS.flatMap(platform => ROW8_ENVS.map(env => env.USERPROFILE || (platform === 'win32' ? env.HOME : undefined) || undefined)),
  },
  {
    name: 'wards.wardPosixWorldCwd',
    answers: () => ROW8_NODE_PLATFORMS.map(platform => wardPosixWorldCwd('/w/project', platform)),
    old: () =>
      ROW8_NODE_PLATFORMS.map(platform => {
        const cwd = '/w/project'
        return platform === 'win32' ? undefined : cwd
      }),
  },
  {
    name: 'wards.wardUsesWindowsDeletePatterns',
    answers: () => ({ windows: wardUsesWindowsDeletePatterns() }),
    old: () => ({ windows: process.platform === 'win32' }),
  },
  {
    name: 'wards.wardWordIsWindowsShaped',
    answers: () => ROW8_NODE_PLATFORMS.flatMap(platform => [true, false].flatMap(anywhere => ROW8_WORDS.map(word => wardWordIsWindowsShaped(word, anywhere, platform)))),
    old: () =>
      ROW8_NODE_PLATFORMS.flatMap(platform =>
        [true, false].flatMap(anywhere =>
          ROW8_WORDS.map(word => {
            if (/^(?:[A-Za-z]:|%[A-Za-z_()0-9]+%|\$\{?env:|\\\\)/.test(word)) return anywhere || platform === 'win32'
            if (platform !== 'win32') return false
            return /^(?:\/[A-Za-z](?:\/|$)|\/\/[^/]|~(?:$|[/\\])|\$\{?[A-Za-z_])/.test(word)
          }),
        ),
      ),
  },
  {
    name: 'wards.wardExpandMsysDrivePrefix',
    answers: () => ROW8_NODE_PLATFORMS.flatMap(platform => ROW8_TEXTS.map(given => wardExpandMsysDrivePrefix(given, platform))),
    old: () =>
      ROW8_NODE_PLATFORMS.flatMap(platform =>
        ROW8_TEXTS.map(given => {
          let text = given
          const msys = platform === 'win32' ? /^\/([A-Za-z])(\/[\s\S]*)?$/.exec(text) : null
          if (msys !== null) text = `${msys[1]}:${msys[2] ?? '/'}`
          return text
        }),
      ),
  },
  {
    name: 'wards.wardShareSegmentCountIsRoot',
    answers: () => ROW8_NODE_PLATFORMS.flatMap(platform => [0, 1, 2, 3].map(count => wardShareSegmentCountIsRoot(count, platform))),
    old: () => ROW8_NODE_PLATFORMS.flatMap(platform => [0, 1, 2, 3].map(count => count === 2 || (count < 2 && platform === 'win32'))),
  },
  {
    name: 'wards.wardUnresolvedWindowsWordFallsThrough',
    answers: () => ROW8_NODE_PLATFORMS.map(platform => !wardUnresolvedWindowsWordFallsThrough(platform)),
    old: () => ROW8_NODE_PLATFORMS.map(platform => platform !== 'win32'),
  },
  {
    name: 'wards.wardTracksWindowsStandingFolder',
    answers: () => ROW8_NODE_PLATFORMS.map(platform => !wardTracksWindowsStandingFolder(platform)),
    old: () => ROW8_NODE_PLATFORMS.map(platform => platform !== 'win32'),
  },
]

const ROWS = [...PATHS, ...PROGRAMS, ...SPAWN, ...PROCESSES, ...FILES, ...TERMINAL, ...DESKTOP, ...TENSORFOLD, ...VENDORS, ...WORDS, ...LOGIN_SHELL, ...COMMAND_FORMS, ...WARDS]

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
const asksTheHost = (row: Row, stand: Stand): boolean => {
  if (HOST_PLATFORM !== 'win32' || row.hostArm === undefined || row.old !== undefined) return false
  if (row.hostArm === 'node') return stand.node !== 'win32'
  if (row.hostArm === 'house') return stand.house !== 'windows'
  return stand.node !== 'win32' || stand.house !== 'windows'
}
let failed = 0
let unread = 0
for (const row of ROWS) {
  const recording: Record<string, unknown> = {}
  for (const stand of row.stands ?? STANDS) {
    const got = await standIn(stand, row.answers)
    recording[stand.name] = JSON.parse(got)
    if (record) continue
    if (asksTheHost(row, stand)) {
      const threw = got.startsWith('"threw ')
      if (threw) failed++
      else unread++
      console.log(`  [${threw ? 'FAIL' : 'SKIP'}] ${row.name} · ${stand.name} — ${threw ? `the function ${JSON.parse(got) as string}; the function named by this row threw on this stand, so make it return an answer for this platform pair instead of throwing` : 'not read on Windows: this arm asks the host, and the recording was taken on a POSIX host'}`)
      continue
    }
    const want = row.old ? await standIn(stand, row.old) : row.recorded && stand.name in row.recorded ? show(row.recorded[stand.name]) : undefined
    const ok = got === want
    if (!ok) failed++
    const against = want === undefined ? 'the row holds neither the old code nor a recorded answer' : `${row.old ? 'the old code' : 'the recording'} answers ${want}; to fix, change the function this row names (rows named paths.* are in src/platform/host-os/paths.ts) so it answers as expected, or add the row old or recorded answer; if the new answer is intended, run this file with --record and paste the printed recorded line into the row`
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${row.name} · ${stand.name}${ok ? '' : ` — the function answers ${got}, ${against}`}`)
  }
  if (record) console.log(`${row.name}\n    recorded: ${JSON.stringify(recording)},`)
}

console.log(failed === 0 ? `\nALL PLATFORM-MODULE CHECKS PASS (${ROWS.length} rows${unread === 0 ? '' : `, ${unread} stands not read on Windows`})` : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
