import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import { REFUSAL_WARDS, countWardWork, evaluateWards, ownHomeNames, shellTextOutsideFileHeredocs, wardHomes, type PendingToolCall, type ResolvedPath, type WardVerdict, type WardWork } from './wards.js'
import { UNREAD_PART, absolutePath, layersOf, printedBy, programOf, readShellCommands, readShellCommandsFromText, stdinProgram, wordKnown, type Layer, type ReadCommand, type ReadWorld, type ShellRead } from './wardsShellRead.js'
import { oldFolderReturn } from '../permissions/decision/commandAnalysis.js'
import { passedOver } from '../passedOver.js'
import { hostEnv } from '../hostEnv.js'
import { withDeadline } from '../deadline.js'
import {
  wardExpandMsysDrivePrefix,
  wardNormalizedSlashedPath,
  wardPathFoldsCase,
  wardPosixWorldCwd,
  wardShareSegmentCountIsRoot,
  wardTracksWindowsStandingFolder,
  wardUnresolvedWindowsWordFallsThrough,
  wardWindowsHomeEnv,
  wardWordIsWindowsShaped,
} from '../platform/wards.js'
import { notBuilt } from '../../pi/holes.js'

type RefusalWorld = ReadWorld & {
  platform: NodeJS.Platform
  homes: readonly string[]
  windowsHome: string | undefined
  startingFolder: string | undefined
  resolvePath: ((path: string) => ResolvedPath) | undefined
  toolName: string
  standing?: ReadonlyMap<ReadCommand, string>
}

type Hit = { ward: string; at: number; excerpt: string; line: number; unread?: string }

const READ_DEADLINE_MS = 2500
const WARD_ORDER = [...new Set(REFUSAL_WARDS.map(rule => rule.name))]
const DELETE_PROGRAMS = new Set(['rm', 'unlink', 'rmdir', 'rd', 'ri', 'del', 'erase', 'remove-item'])
const SLASH_DELETES = new Set(['rd', 'rmdir', 'del', 'erase'])
const LISTERS = new Set(['get-childitem', 'gci', 'dir', 'ls'])
const FETCHERS = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm'])
const SCRIPT_RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'mksh', 'yash', 'csh', 'tcsh', 'eval', 'source', '.', 'invoke-expression', 'iex'])
const SYSTEM_TREES = ['etc', 'usr', 'bin', 'sbin', 'lib', 'lib64', 'opt', 'boot', 'dev', 'proc', 'sys', 'System', 'Library', 'Applications', 'cores']
const WINDOWS_SYSTEM_FOLDERS = new Set(['windows', 'program files', 'program files (x86)', 'programdata'])
const SHORT_NAMES: Record<string, string> = { 'progra~1': 'program files', 'progra~2': 'program files (x86)', 'progra~3': 'programdata' }
const EVERYTHING = /^[*?.]*\*[*?.]*$/
const RECURSIVE_LONG = /^--r(?:e(?:c(?:u(?:r(?:s(?:i(?:v(?:e)?)?)?)?)?)?)?)?$/
const RECURSE_PARAMETER = /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i
const POSIX_RM_CLUSTER = /^-[dfiIPRrvWx]+$/
const DISK_NODE = /^\/dev\/(?:r?disk\d|sd[a-z]|hd[a-z]|nvme\d|mmcblk\d|vd[a-z]|xvd[a-z]|loop\d|dm-\d|md\d|mapper\/)/
const SAFE_NODE = /^\/dev\/(?:null\b|zero\b|full\b|random\b|urandom\b|stdout\b|stderr\b|stdin\b|tty|fd\/|shm\/)/
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '>&'])
const FIND_NARROWING = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-newer', '-anewer', '-cnewer', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-size', '-empty', '-user', '-group', '-uid', '-gid', '-perm', '-inum', '-samefile', '-links', '-lname', '-ilname'])
const PINNED_AT = /^git\+\S+@[0-9a-f]{7,40}(?:#\S*)?$/i
const PINNED_HASH = /^(?:git\+\S+|git:\/\/\S+|ssh:\/\/\S+|https?:\/\/\S+|(?:github|gitlab|bitbucket|gist):\S+|[\w.-]+\/[\w.-]+)#(?:commit=)?[0-9a-f]{7,40}$/i
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path'])
const CONFIG_VALUED = new Set(['--file', '-f', '--blob', '--type', '-t', '--default', '--comment', '--value', '--url'])
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--get-color', '--get-colorbool'])
const CONFIG_WRITES = new Set(['--add', '--unset', '--unset-all', '--replace-all', '--remove-section', '--rename-section', '--edit', '-e'])
const CONFIG_VERBS_READ = new Set(['get', 'list'])
const CONFIG_VERBS_WRITE = new Set(['set', 'unset', 'edit', 'remove-section', 'rename-section'])
const NPX_VALUED = new Set(['-p', '--package', '-c', '--call', '--registry', '-w', '--workspace', '--prefix', '--cache', '--userconfig', '--node-options'])
const MENTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<![\w.-])(sudo|doas|pkexec)(?:\.exe)?(?![\w.-])/i, 'no-sudo'],
  [/(?<![\w.-])(shutdown|reboot|halt|poweroff|telinit|stop-computer|restart-computer)(?:\.exe)?(?![\w.-])/i, 'no-system-halt'],
  [/(?<![\w.-])(mkfs(?:\.\w+)?|mke2fs|mkswap|wipefs|fdisk|sfdisk|gdisk|cfdisk|sgdisk|parted|newfs\w*|diskutil|diskpart|format-volume|clear-disk|initialize-disk|remove-partition)(?:\.exe)?(?![\w.-])/i, 'no-disk-format'],
  [/(?<![\w.-])(crontab)(?![\w.-])/i, 'cron-persist'],
  [/(?<![\w.-])(systemctl)(?![\w.-])|(systemd\/(?:system|user))|(\/etc\/init\.d)/i, 'systemd-persist'],
  [/(?<![\w.-])(launchctl)(?![\w.-])|(Library\/Launch(?:Agents|Daemons))|(\.config\/autostart)/i, 'autostart-persist'],
  [/(?<![\w.-])(nohup|setsid|disown)(?![\w.-])/i, 'self-daemonize'],
  [/(?<![\w.-])(npx|bunx|dlx)(?![\w.-])/i, 'npm-exec-yes'],
  [/(\.git\/(?:hooks|config))/i, 'git-internals-write'],
  [/(core\.hookspath)/i, 'git-hooks-path'],
  [/(\.gitconfig)/i, 'git-config-global'],
  [/(\/dev\/(?:r?disk\d|sd[a-z]|hd[a-z]|nvme\d|mmcblk\d|vd[a-z]|xvd[a-z]|loop\d|dm-\d|md\d|mapper\/)\S*)/i, 'no-device-write'],
]

function folds(world: RefusalWorld): boolean {
  return wardPathFoldsCase(world.platform)
}

function folded(text: string): string {
  return text.normalize('NFD').toUpperCase().toLowerCase()
}

function same(a: string | undefined, b: string, world: RefusalWorld): boolean {
  if (a === undefined) return false
  return folds(world) ? folded(a) === folded(b) : a === b
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter(Boolean)
}

function posixPath(word: string, cwd: string | undefined, world: RefusalWorld): string | undefined {
  if (word === '' || word.includes(UNREAD_PART)) return undefined
  const homed = world.home === undefined ? word : word.replace(/^\$\{?(?:env:)?(?:HOME|USERPROFILE)\}?(?=$|[/\\])/i, world.home)
  let path = absolutePath(homed, cwd, world)
  if (path === undefined) return undefined
  if (world.platform === 'darwin') {
    path = path.replace(/^\/System\/Volumes\/Data(?=\/|$)/i, '') || '/'
    path = path.replace(/^\/private(?=\/(?:etc|var|tmp)(?:\/|$))/i, '')
  }
  return path
}

function homesRoots(world: RefusalWorld): string[] {
  const roots = ['/Users', '/home']
  for (const home of world.homes) {
    const segments = segmentsOf(posixPath(home, undefined, world) ?? home)
    const parent = segments[segments.length - 2]
    if (segments.length >= 2 && (same(parent, 'Users', world) || same(parent, 'home', world))) roots.push(`/${segments.slice(0, -1).join('/')}`)
  }
  return roots
}

function underStart(path: string, world: RefusalWorld, content: boolean): boolean {
  if (world.startingFolder === undefined) return false
  const start = posixPath(world.startingFolder, undefined, world)
  if (start === undefined || start === '/') return false
  const fold = (text: string): string => (folds(world) ? folded(text) : text)
  return fold(path).startsWith(`${fold(start)}/`) || (content && fold(path) === fold(start))
}

function protectedRoot(path: string, world: RefusalWorld): string | null {
  const segments = segmentsOf(path)
  const scratch = (at: number): boolean => segments.length > at + 1
  const content = segments.length > 0 && EVERYTHING.test(segments[segments.length - 1]!)
  const varScratch = same(segments[0], 'var', world) && (segments[1] === 'tmp' || segments[1] === 'folders') && scratch(1)
  const privateScratch = same(segments[0], 'private', world) && ((segments[1] === 'tmp' && scratch(1)) || (segments[1] === 'var' && (segments[2] === 'tmp' || segments[2] === 'folders') && scratch(2)))
  if (content) segments.pop()
  const whole = `${path.startsWith('/') ? '/' : ''}${segments.join('/')}`
  if (segments.length === 0) return '/'
  for (const home of world.homes) if (same(whole, posixPath(home, undefined, world) ?? home, world)) return whole
  for (const root of homesRoots(world)) {
    const base = segmentsOf(root)
    if (segments.length >= base.length && segments.length <= base.length + 1 && base.every((segment, at) => same(segments[at], segment, world))) return whole
  }
  const head = segments[0]
  if (same(head, 'root', world) && segments.length === 1) return whole
  if (same(head, 'Volumes', world) && segments.length <= 2) return whole
  const tree = SYSTEM_TREES.some(name => same(head, name, world)) || (same(head, 'var', world) && !varScratch) || (same(head, 'private', world) && !privateScratch)
  if (!tree) return null
  return underStart(whole, world, content) ? null : whole
}

function otherUserHome(path: string, world: RefusalWorld): boolean {
  const segments = segmentsOf(path)
  for (const root of homesRoots(world)) {
    const base = segmentsOf(root)
    if (segments.length <= base.length || !base.every((segment, at) => same(segments[at], segment, world))) continue
    return !world.ownNames.some(name => same(segments[base.length], name, world))
  }
  return false
}

function windowsVariable(name: string, world: RefusalWorld): string | undefined {
  const drive = (hostEnv().SystemDrive ?? 'C:').slice(0, 2)
  const home = world.windowsHome
  switch (name.toLowerCase()) {
    case 'systemdrive':
    case 'homedrive':
      return drive
    case 'userprofile':
    case 'home':
      return home
    case 'homepath':
      return home?.replace(/^[A-Za-z]:/, '')
    case 'systemroot':
    case 'windir':
      return `${drive}/Windows`
    case 'programfiles':
    case 'programw6432':
      return `${drive}/Program Files`
    case 'programfiles(x86)':
      return `${drive}/Program Files (x86)`
    case 'programdata':
    case 'allusersprofile':
      return `${drive}/ProgramData`
    default:
      return undefined
  }
}

function windowsShaped(word: string, world: RefusalWorld, anywhere: boolean): boolean {
  return wardWordIsWindowsShaped(word, anywhere, world.platform)
}

function windowsPath(word: string, world: RefusalWorld): string | undefined {
  let text = word.replace(/%([A-Za-z_()0-9]+)%|\$\{?env:([A-Za-z_()0-9]+)\}?|\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (all, percent: string | undefined, env: string | undefined, plain: string | undefined) => windowsVariable(percent ?? env ?? plain ?? '', world) ?? all)
  text = text.replace(/\\/g, '/')
  if (/^\/\/[?.]\//.test(text)) text = text.slice(4)
  const share = /^\/\/[^/]+\/([A-Za-z])\$(\/[\s\S]*)?$/.exec(text)
  if (share !== null) text = `${share[1]}:${share[2] ?? '/'}`
  text = wardExpandMsysDrivePrefix(text, world.platform)
  if ((text === '~' || text.startsWith('~/')) && world.windowsHome !== undefined) text = world.windowsHome.replace(/\\/g, '/') + text.slice(1)
  const unc = text.startsWith('//')
  if (!unc && !/^[A-Za-z]:/.test(text)) return undefined
  const head = unc ? '/' : text.slice(0, 2)
  const out: string[] = []
  for (const segment of (unc ? text : text.slice(2)).split(/[\\/]/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(SHORT_NAMES[segment.toLowerCase()] ?? segment)
  }
  return `${head}/${out.join('/')}`.toLowerCase()
}

function windowsSegments(path: string): { share: boolean; segments: string[]; content: boolean } {
  const share = path.startsWith('//')
  const segments = (share ? path : path.slice(2)).split(/[\\/]/).filter(Boolean)
  const content = segments.length > 0 && EVERYTHING.test(segments[segments.length - 1]!)
  if (content) segments.pop()
  return { share, segments, content }
}

function windowsRoot(path: string, world: RefusalWorld): string | null {
  const { share, segments } = windowsSegments(path)
  if (share) return wardShareSegmentCountIsRoot(segments.length, world.platform) ? path : null
  const home = world.windowsHome === undefined ? undefined : windowsPath(world.windowsHome, world)
  if (segments.length === 0) return path
  if (home !== undefined && `${path.slice(0, 2)}/${segments.join('/')}` === home) return path
  if (segments[0] === 'users' && segments.length <= 2) return path
  return WINDOWS_SYSTEM_FOLDERS.has(segments[0]!) ? path : null
}

function windowsOtherUser(path: string, world: RefusalWorld): boolean {
  const { share, segments } = windowsSegments(path)
  if (share || segments[0] !== 'users' || segments.length < 2) return false
  return !world.ownNames.some(name => name.toLowerCase() === segments[1])
}

function namedDriveHome(word: string, world: RefusalWorld): string | undefined {
  if (!word.startsWith('~') || !/^[A-Za-z]:\//.test(world.home ?? '')) return undefined
  return posixPath(word.replace(/\\/g, '/'), undefined, { ...world, windows: true })
}

function rootNamed(word: string, command: ReadCommand, world: RefusalWorld, anywhere = false): string | null {
  if (windowsShaped(word, world, anywhere)) {
    const path = windowsPath(word, world)
    if (path !== undefined) return windowsRoot(path, world)
    if (!wardUnresolvedWindowsWordFallsThrough(world.platform)) return null
  }
  const stands = world.standing?.get(command)
  if (stands !== undefined && wordKnown(word) && !/^[\\/~%]/.test(word)) {
    const path = windowsPath(`${stands}/${word}`, world)
    if (path !== undefined) return windowsRoot(path, world)
  }
  const named = namedDriveHome(word, world)
  if (named !== undefined && protectedRoot(named, world) !== null) return named
  const path = posixPath(command.dialect === 'powershell' ? word.replace(/\\/g, '/') : word, command.cwd, world)
  return path === undefined ? null : protectedRoot(path, world)
}

function insideStartingFolder(path: string, world: RefusalWorld): boolean {
  if (world.resolvePath === undefined || world.startingFolder === undefined) return false
  const slashed = (text: string): string => wardNormalizedSlashedPath(text, world.platform)
  const base = `${slashed(world.startingFolder).replace(/\/+$/, '')}/`
  try {
    return slashed(world.resolvePath(path).path).startsWith(base)
  } catch (error) {
    passedOver(error)
    return false
  }
}

function otherUserNamed(word: string, command: ReadCommand, world: RefusalWorld): boolean {
  if (windowsShaped(word, world, false)) {
    const path = windowsPath(word, world)
    if (path !== undefined) return windowsOtherUser(path, world) && !insideStartingFolder(word, world)
    if (!wardUnresolvedWindowsWordFallsThrough(world.platform)) return false
  }
  const stands = world.standing?.get(command)
  if (stands !== undefined && wordKnown(word) && !/^[\\/~%]/.test(word)) {
    const path = windowsPath(`${stands}/${word}`, world)
    if (path !== undefined && windowsOtherUser(path, world) && !insideStartingFolder(path, world)) return true
  }
  const named = namedDriveHome(word, world)
  if (named !== undefined && otherUserHome(named, world) && !insideStartingFolder(named, world)) return true
  const path = posixPath(command.dialect === 'powershell' ? word.replace(/\\/g, '/') : word, command.cwd, world)
  return path !== undefined && otherUserHome(path, world) && !insideStartingFolder(path, world)
}

type Delete = { recursive: boolean; preview: boolean; operands: string[] }

function operandsOf(argv: string[], valued: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = []
  let ended = false
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!
    if (!ended && word === '--') ended = true
    else if (!ended && word.startsWith('-') && word !== '-') {
      if (valued.has(word)) i++
    } else out.push(word)
  }
  return out
}

function optionValue(argv: string[], short: string | undefined, long: string): string[] {
  const out: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!
    if ((word === long || (short !== undefined && word === short)) && argv[i + 1] !== undefined) out.push(argv[++i]!)
    else if (word.startsWith(`${long}=`)) out.push(word.slice(long.length + 1))
    else if (short !== undefined && word.startsWith(short) && word.length > short.length && !word.startsWith('--')) out.push(word.slice(short.length))
  }
  return out
}

function pair(segments: string[], first: string, second: string, world: RefusalWorld): boolean {
  for (let i = 0; i + 1 < segments.length; i++) if (same(segments[i], first, world) && same(segments[i + 1], second, world)) return true
  return false
}

function leads(segments: string[], head: readonly string[], world: RefusalWorld): boolean {
  return segments.length >= head.length && head.every((segment, at) => same(segments[at], segment, world))
}

function underSomeHome(segments: string[], world: RefusalWorld): string[] | undefined {
  for (const home of world.homes) {
    const base = segmentsOf(posixPath(home, undefined, world) ?? home)
    if (leads(segments, base, world)) return segments.slice(base.length)
  }
  for (const root of homesRoots(world)) {
    const base = segmentsOf(root)
    if (segments.length > base.length && leads(segments, base, world)) return segments.slice(base.length + 1)
  }
  return leads(segments, ['root'], world) ? segments.slice(1) : undefined
}

const UNIT_FOLDERS: ReadonlyArray<readonly string[]> = [
  ['etc', 'systemd', 'system'],
  ['etc', 'systemd', 'user'],
  ['etc', 'init.d'],
  ['usr', 'lib', 'systemd', 'system'],
  ['usr', 'lib', 'systemd', 'user'],
  ['usr', 'local', 'lib', 'systemd', 'system'],
  ['usr', 'local', 'lib', 'systemd', 'user'],
  ['lib', 'systemd', 'system'],
  ['lib', 'systemd', 'user'],
  ['run', 'systemd', 'system'],
]
const HOME_UNIT_FOLDERS: ReadonlyArray<readonly string[]> = [
  ['.config', 'systemd', 'user'],
  ['.local', 'share', 'systemd', 'user'],
]
const AUTOSTART_FOLDERS: ReadonlyArray<readonly string[]> = [
  ['Library', 'LaunchAgents'],
  ['Library', 'LaunchDaemons'],
  ['System', 'Library', 'LaunchAgents'],
  ['System', 'Library', 'LaunchDaemons'],
  ['etc', 'xdg', 'autostart'],
]
const HOME_AUTOSTART_FOLDERS: ReadonlyArray<readonly string[]> = [
  ['.config', 'autostart'],
  ['Library', 'LaunchAgents'],
  ['Library', 'LaunchDaemons'],
]

function wardOfWrite(word: string, command: ReadCommand, world: RefusalWorld): string | undefined {
  if (/^\$\{?XDG_CONFIG_HOME\}?\/git\/config$/.test(word)) return 'git-config-global'
  if (/^\$\{?XDG_(?:CONFIG|DATA)_HOME\}?\/systemd\/user(?:\/|$)/.test(word)) return 'systemd-persist'
  if (/^\$\{?XDG_CONFIG_HOME\}?\/autostart(?:\/|$)/.test(word)) return 'autostart-persist'
  const path = posixPath(command.dialect === 'powershell' ? word.replace(/\\/g, '/') : word, command.cwd, world)
  if (path === undefined) return undefined
  if (DISK_NODE.test(path)) return 'no-device-write'
  const segments = segmentsOf(path)
  if (pair(segments, '.git', 'hooks', world)) return 'git-internals-write'
  if (segments.length >= 2 && same(segments[segments.length - 2], '.git', world) && same(segments[segments.length - 1], 'config', world)) return 'git-internals-write'
  const homed = underSomeHome(segments, world)
  if (UNIT_FOLDERS.some(folder => leads(segments, folder, world)) || (homed !== undefined && HOME_UNIT_FOLDERS.some(folder => leads(homed, folder, world)))) return 'systemd-persist'
  if (AUTOSTART_FOLDERS.some(folder => leads(segments, folder, world)) || (homed !== undefined && HOME_AUTOSTART_FOLDERS.some(folder => leads(homed, folder, world)))) return 'autostart-persist'
  if (globalGitConfig(path, world)) return 'git-config-global'
  return undefined
}

function globalGitConfig(path: string, world: RefusalWorld): boolean {
  if (path === '/etc/gitconfig') return true
  for (const home of world.homes) {
    const base = posixPath(home, undefined, world) ?? home
    if (same(path, `${base}/.gitconfig`, world) || same(path, `${base}/.config/git/config`, world)) return true
  }
  return false
}

function gitConfigWard(layer: Layer, command: ReadCommand, world: RefusalWorld): string | undefined {
  const argv = layer.argv
  let i = 1
  while (i < argv.length && argv[i]!.startsWith('-')) i += GIT_VALUED.has(argv[i]!) ? 2 : 1
  if (argv[i]?.toLowerCase() !== 'config') return undefined
  const flags: string[] = []
  const positionals: string[] = []
  const files: string[] = []
  for (i++; i < argv.length; i++) {
    const word = argv[i]!
    if (!word.startsWith('-')) {
      positionals.push(word)
      continue
    }
    const equals = word.indexOf('=')
    const name = word.startsWith('--') && equals > 0 ? word.slice(0, equals) : word
    flags.push(name)
    if (name === '--file' || name === '-f') files.push(equals > 0 && word.startsWith('--') ? word.slice(equals + 1) : (argv[i + 1] ?? ''))
    if (CONFIG_VALUED.has(word)) i++
  }
  const verb = positionals[0]?.toLowerCase() ?? ''
  const verbed = CONFIG_VERBS_READ.has(verb) || CONFIG_VERBS_WRITE.has(verb)
  const reads = flags.some(flag => CONFIG_READS.has(flag)) || CONFIG_VERBS_READ.has(verb)
  const writes = !reads && (flags.some(flag => CONFIG_WRITES.has(flag)) || CONFIG_VERBS_WRITE.has(verb) || positionals.length >= 2)
  if (!writes) return undefined
  const global = flags.includes('--global') || flags.includes('--system') || files.some(file => wardOfWrite(file, command, world) === 'git-config-global')
  if (global) return 'git-config-global'
  const key = (verbed ? positionals[1] : positionals[0])?.toLowerCase()
  return key === 'core.hookspath' ? 'git-hooks-path' : undefined
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && /^(?:true|1|yes|on)$/i.test(value)
}

function localBinary(name: string, cwd: string | undefined): boolean {
  const plain = name.startsWith('@') ? name.replace(/^(@[^/]+\/[^@]+).*$/, '$1') : name.replace(/@.*$/, '')
  const bin = plain.slice(plain.lastIndexOf('/') + 1)
  if (cwd === undefined || bin === '') return false
  let folder = cwd
  for (let turn = 0; turn < 64; turn++) {
    if (existsSync(`${folder}/node_modules/.bin/${bin}`)) return true
    const parent = folder.slice(0, folder.lastIndexOf('/')) || '/'
    if (parent === folder) return false
    folder = parent
  }
  return false
}

function firstVerb(argv: string[], valued: ReadonlySet<string>): string {
  return operandsOf(argv, valued)[0]?.toLowerCase() ?? ''
}

const SYSTEMCTL_VALUED = new Set(['-t', '--type', '-H', '--host', '-M', '--machine', '-p', '--property', '-s', '--signal', '-n', '--lines', '-o', '--output', '--root', '--state', '--job-mode'])

function haltWard(layer: Layer): boolean {
  const { program, argv } = layer
  if (['shutdown', 'reboot', 'halt', 'poweroff', 'stop-computer', 'restart-computer'].includes(program)) return true
  if (program === 'init' || program === 'telinit') return argv[1] === '0' || argv[1] === '6'
  if (program === 'launchctl') return argv[1]?.toLowerCase() === 'reboot'
  return program === 'systemctl' && ['poweroff', 'reboot', 'halt', 'kexec'].includes(firstVerb(argv, SYSTEMCTL_VALUED))
}

function mention(text: string): { ward: string; word: string } | undefined {
  for (const [pattern, ward] of MENTIONS) {
    const found = pattern.exec(text)
    if (found !== null) return { ward, word: found.slice(1).find(group => group !== undefined) ?? found[0] }
  }
  return undefined
}

function sharesEarlier(earlier: ReadCommand, later: ReadCommand): boolean {
  for (const a of earlier.stages) for (const b of later.stages) if (a.pipeline === b.pipeline && a.stage < b.stage) return true
  return false
}

function innerCommands(command: ReadCommand, commands: readonly ReadCommand[]): ReadCommand[] {
  const out: ReadCommand[] = []
  const seen = new Set<number>()
  const visit = (indexes: readonly number[]): void => {
    for (const at of indexes) {
      const inner = commands[at]
      if (inner === undefined || seen.has(at)) continue
      seen.add(at)
      out.push(inner)
      visit(inner.inner.flat())
      visit(inner.inputInner)
    }
  }
  visit(command.inner.flat())
  visit(command.inputInner)
  return out
}

function judgeShellRead(read: ShellRead, world: RefusalWorld, textReading: (text: string) => WardVerdict, work?: WardWork): Hit | undefined {
  return notBuilt('src/utils/wards/wardsRefusals.ts:649')
}

function verdictOf(found: Hit | undefined, toolName: string): WardVerdict {
  if (found === undefined) return { allow: true }
  const rule = REFUSAL_WARDS.find(candidate => candidate.name === found.ward && candidate.scope === 'bash')
  if (rule === undefined) return { allow: true }
  return { allow: false, rule, excerpt: found.excerpt, line: found.line, target: toolName, ...(found.unread === undefined ? {} : { unread: found.unread }) }
}

function worldOf(pending: PendingToolCall, cwd: string): RefusalWorld {
  const platform = process.platform
  const homes = wardHomes()
  const home = homes[0]
  const fold = wardPathFoldsCase(platform)
  const parent = home === undefined ? '' : posix.dirname(home)
  const named = posix.basename(parent)
  const holdsHomes = fold ? ['users', 'home'].includes(named.toLowerCase()) : named === 'Users' || named === 'home'
  return {
    cwd: wardPosixWorldCwd(cwd, platform),
    home,
    homesRoot: holdsHomes ? parent : platform === 'darwin' ? '/Users' : '/home',
    ownNames: ownHomeNames(),
    platform,
    homes,
    windowsHome: wardWindowsHomeEnv(hostEnv(), platform),
    startingFolder: pending.startingFolder,
    resolvePath: pending.resolvePath,
    toolName: pending.toolName,
  }
}

const OLD_FOLDER_PLACE_CAP = 8

function oldFolderPlaces(
  start: string | undefined,
  home: string | undefined,
  written: readonly string[] | undefined,
  resolve: (word: string) => string | undefined,
  entered: Iterable<string | undefined>,
): string[] {
  const places: string[] = []
  const add = (folder: string | undefined): void => {
    if (folder !== undefined && !places.includes(folder) && places.length < OLD_FOLDER_PLACE_CAP) places.push(folder)
  }
  add(start)
  if (written !== undefined) {
    add(home)
    for (const word of written) add(resolve(word))
  }
  for (const folder of entered) add(folder)
  return places
}

async function windowsStanding(text: string, dialect: ReadCommand['dialect'], world: RefusalWorld, cwd: string, read: ShellRead, returnsTo?: string): Promise<ReadonlyMap<ReadCommand, string> | undefined> {
  if (!wardTracksWindowsStandingFolder(world.platform) || !read.commands.some(command => layersOf(command.argv).some(layer => DELETE_PROGRAMS.has(layer.program) || layer.program === 'find' || layer.program === 'rsync'))) return undefined
  const folderOf = (word: string): string | undefined => (word.includes(UNREAD_PART) ? undefined : windowsPath(word, world))
  const home = world.windowsHome === undefined ? undefined : folderOf(world.windowsHome)
  try {
    const again = await withDeadline(
      readShellCommands(text, dialect, { cwd: folderOf(cwd), home, homesRoot: home === undefined ? world.homesRoot : posix.dirname(home), ownNames: world.ownNames, folderOf, ...(returnsTo === undefined ? {} : { windows: true, returnsTo }) }),
      READ_DEADLINE_MS,
      () => undefined,
    )
    if (again === undefined || again.commands.length !== read.commands.length) return undefined
    const standing = new Map<ReadCommand, string>()
    read.commands.forEach((command, at) => {
      const folder = again.commands[at]!.cwd
      if (folder !== undefined && /^(?:[a-z]:|\/\/)/.test(folder)) standing.set(command, folder)
    })
    return standing
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

function windowsStandingFromText(text: string, dialect: ReadCommand['dialect'], world: RefusalWorld, cwd: string, read: ShellRead, returnsTo?: string): ReadonlyMap<ReadCommand, string> | undefined {
  if (!wardTracksWindowsStandingFolder(world.platform) || !read.commands.some(command => layersOf(command.argv).some(layer => DELETE_PROGRAMS.has(layer.program) || layer.program === 'find' || layer.program === 'rsync'))) return undefined
  const folderOf = (word: string): string | undefined => (word.includes(UNREAD_PART) ? undefined : windowsPath(word, world))
  const home = world.windowsHome === undefined ? undefined : folderOf(world.windowsHome)
  try {
    const again = readShellCommandsFromText(text, dialect, { cwd: folderOf(cwd), home, homesRoot: home === undefined ? world.homesRoot : posix.dirname(home), ownNames: world.ownNames, folderOf, ...(returnsTo === undefined ? {} : { windows: true, returnsTo }) })
    if (again.commands.length !== read.commands.length) return undefined
    const standing = new Map<ReadCommand, string>()
    read.commands.forEach((command, at) => {
      const folder = again.commands[at]!.cwd
      if (folder !== undefined && /^(?:[a-z]:|\/\/)/.test(folder)) standing.set(command, folder)
    })
    return standing
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

function judgeVerdict(pending: PendingToolCall, text: string, dialect: ReadCommand['dialect'], effective: ShellRead, world: RefusalWorld, work?: WardWork): WardVerdict {
  const unread = effective.unread
  const textReading = (part: string): WardVerdict => evaluateWards(REFUSAL_WARDS, { ...pending, shellCommand: part }, work)
  if (unread === undefined) return verdictOf(judgeShellRead(effective, world, textReading, work), pending.toolName)
  const byText = evaluateWards(REFUSAL_WARDS, pending, work)
  if (!byText.allow) return byText
  const outside = unread.text === text && dialect === 'posix' ? shellTextOutsideFileHeredocs(text) : unread.text
  const named = mention(outside)
  if (named === undefined) return verdictOf(judgeShellRead(effective, world, textReading, work), pending.toolName)
  const at = outside.indexOf(named.word)
  const excerpt = outside.slice(Math.max(0, at - 30), at + 50).replace(/\s+/g, ' ').trim()
  return verdictOf({ ward: named.ward, at: 0, excerpt, line: outside.slice(0, Math.max(0, at)).split('\n').length, unread: `${unread.why}, and it mentions "${named.word}"` }, pending.toolName)
}

export async function refusalOfShellCommand(pending: PendingToolCall, cwd: string, work?: WardWork): Promise<WardVerdict> {
  const text = pending.shellCommand ?? ''
  const dialect = pending.toolName === 'PowerShell' ? 'powershell' : 'posix'
  const world = worldOf(pending, cwd)
  let read: ShellRead | undefined
  try {
    read = await withDeadline(readShellCommands(text, dialect, world), READ_DEADLINE_MS, () => undefined)
  } catch {
    return evaluateWards(REFUSAL_WARDS, pending, work)
  }
  const late = read === undefined
  const effective = read ?? readShellCommandsFromText(text, dialect, world)
  world.standing = late ? windowsStandingFromText(text, dialect, world, cwd, effective) : await windowsStanding(text, dialect, world, cwd, effective)
  let first: WardVerdict
  try {
    first = judgeVerdict(pending, text, dialect, effective, world, work)
  } catch {
    return evaluateWards(REFUSAL_WARDS, pending, work)
  }
  if (!first.allow) return first
  const returned = oldFolderReturn(effective.commands, text)
  if (returned === undefined) return first
  if (wardTracksWindowsStandingFolder(world.platform)) {
    const firstStanding = world.standing
    if (firstStanding === undefined) return first
    const folderOf = (word: string): string | undefined => (word.includes(UNREAD_PART) ? undefined : windowsPath(word, world))
    const places = oldFolderPlaces(
      folderOf(cwd),
      world.windowsHome === undefined ? undefined : windowsPath(world.windowsHome, world),
      returned.written,
      word => windowsPath(word, world),
      firstStanding.values(),
    )
    for (const returnsTo of places) {
      try {
        const standing = late ? windowsStandingFromText(text, dialect, world, cwd, effective, returnsTo) : await windowsStanding(text, dialect, world, cwd, effective, returnsTo)
        if (standing === undefined) continue
        const second = judgeVerdict(pending, text, dialect, effective, { ...world, standing }, work)
        if (!second.allow) return second
      } catch (error) {
        passedOver(error)
      }
    }
    return first
  }
  const places = oldFolderPlaces(
    world.cwd,
    world.home,
    returned.written,
    word => absolutePath(word, world.cwd, world),
    effective.commands.map(command => command.cwd),
  )
  for (const returnsTo of places) {
    const againWorld: RefusalWorld = { ...world, returnsTo }
    try {
      const again = late
        ? readShellCommandsFromText(text, dialect, againWorld)
        : ((await withDeadline(readShellCommands(text, dialect, againWorld), READ_DEADLINE_MS, () => undefined)) ?? readShellCommandsFromText(text, dialect, againWorld))
      const second = judgeVerdict(pending, text, dialect, again, againWorld, work)
      if (!second.allow) return second
    } catch (error) {
      passedOver(error)
    }
  }
  return first
}
