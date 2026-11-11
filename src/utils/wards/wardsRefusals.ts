import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import { REFUSAL_WARDS, countWardWork, evaluateWards, ownHomeNames, shellTextOutsideFileHeredocs, wardHomes, type PendingToolCall, type ResolvedPath, type WardVerdict, type WardWork } from './wards.js'
import { UNREAD_PART, absolutePath, layersOf, printedBy, programOf, readShellCommands, stdinProgram, wordKnown, type Layer, type ReadCommand, type ReadWorld, type ShellRead } from './wardsShellRead.js'

type RefusalWorld = ReadWorld & {
  platform: NodeJS.Platform
  homes: readonly string[]
  windowsHome: string | undefined
  startingFolder: string | undefined
  resolvePath: ((path: string) => ResolvedPath) | undefined
  toolName: string
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
  return world.platform === 'darwin' || world.platform === 'win32'
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
  const whole = `/${segments.join('/')}`
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
  const drive = (process.env.SystemDrive ?? 'C:').slice(0, 2)
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
  if (/^(?:[A-Za-z]:|%[A-Za-z_()0-9]+%|\$\{?env:|\\\\)/.test(word)) return anywhere || world.platform === 'win32'
  if (world.platform !== 'win32') return false
  return /^(?:\/[A-Za-z](?:\/|$)|\/\/[^/]|~(?:$|[/\\])|\$\{?[A-Za-z_])/.test(word)
}

function windowsPath(word: string, world: RefusalWorld): string | undefined {
  let text = word.replace(/%([A-Za-z_()0-9]+)%|\$\{?env:([A-Za-z_()0-9]+)\}?|\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (all, percent: string | undefined, env: string | undefined, plain: string | undefined) => windowsVariable(percent ?? env ?? plain ?? '', world) ?? all)
  text = text.replace(/\\/g, '/')
  if (/^\/\/[?.]\//.test(text)) text = text.slice(4)
  const share = /^\/\/[^/]+\/([A-Za-z])\$(\/[\s\S]*)?$/.exec(text)
  if (share !== null) text = `${share[1]}:${share[2] ?? '/'}`
  const msys = world.platform === 'win32' ? /^\/([A-Za-z])(\/[\s\S]*)?$/.exec(text) : null
  if (msys !== null) text = `${msys[1]}:${msys[2] ?? '/'}`
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
  if (share) return segments.length === 2 ? path : null
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

function rootNamed(word: string, command: ReadCommand, world: RefusalWorld, anywhere = false): string | null {
  if (windowsShaped(word, world, anywhere)) {
    const path = windowsPath(word, world)
    if (path !== undefined) return windowsRoot(path, world)
    if (world.platform !== 'win32') return null
  }
  const path = posixPath(command.dialect === 'powershell' ? word.replace(/\\/g, '/') : word, command.cwd, world)
  return path === undefined ? null : protectedRoot(path, world)
}

function insideStartingFolder(path: string, world: RefusalWorld): boolean {
  if (world.resolvePath === undefined || world.startingFolder === undefined) return false
  const slashed = (text: string): string => (world.platform === 'win32' ? text.replace(/\\/g, '/').toLowerCase() : text.replace(/\\/g, '/'))
  const base = `${slashed(world.startingFolder).replace(/\/+$/, '')}/`
  try {
    return slashed(world.resolvePath(path).path).startsWith(base)
  } catch {
    return false
  }
}

function otherUserNamed(word: string, command: ReadCommand, world: RefusalWorld): boolean {
  if (windowsShaped(word, world, false)) {
    const path = windowsPath(word, world)
    if (path !== undefined) return windowsOtherUser(path, world) && !insideStartingFolder(word, world)
    if (world.platform !== 'win32') return false
  }
  const path = posixPath(command.dialect === 'powershell' ? word.replace(/\\/g, '/') : word, command.cwd, world)
  return path !== undefined && otherUserHome(path, world) && !insideStartingFolder(path, world)
}

type Delete = { recursive: boolean; preview: boolean; operands: string[] }

function deleteOf(layer: Layer, command: ReadCommand, commands: readonly ReadCommand[]): Delete | null {
  if (!DELETE_PROGRAMS.has(layer.program)) return null
  const slashed = SLASH_DELETES.has(layer.program)
  const offset = command.argv.length - layer.argv.length
  const operands: string[] = []
  let recursive = false
  let preview = false
  let ended = false
  for (let i = 1; i < layer.argv.length; i++) {
    const word = layer.argv[i]!
    if (!ended && word === '--') {
      ended = true
      continue
    }
    if (!ended && word.startsWith('-') && word !== '-') {
      if (RECURSIVE_LONG.test(word) || RECURSE_PARAMETER.test(word) || /^-(?:rf|fr|rfo)$/i.test(word) || (POSIX_RM_CLUSTER.test(word) && /[rR]/.test(word))) recursive = true
      if (/^-whatif(?::\$true)?$/i.test(word)) preview = true
      continue
    }
    if (slashed && /^\/[a-zA-Z]$/.test(word)) {
      if (/^\/s$/i.test(word)) recursive = true
      continue
    }
    if (word === '{}' && layer.findRoots !== undefined) {
      operands.push(...(layer.findRoots.length > 0 ? layer.findRoots : ['.']))
      continue
    }
    if (word === UNREAD_PART && layer.argv === command.argv) {
      for (const at of command.inner[i + offset] ?? []) {
        const joined = commands[at]
        if (joined !== undefined && programOf(joined.argv[0] ?? '') === 'join-path') operands.push(joined.argv.slice(1).filter(part => !/^-[A-Za-z]+$/.test(part)).join('/'))
      }
      continue
    }
    operands.push(word)
  }
  return { recursive, preview, operands }
}

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

function writtenBy(layer: Layer): string[] {
  const { program, argv } = layer
  switch (program) {
    case 'cp':
    case 'mv':
    case 'install':
    case 'ln':
    case 'rsync':
    case 'scp':
    case 'ditto':
    case 'copy-item':
    case 'cpi':
    case 'copy':
    case 'move-item':
    case 'mi':
    case 'move': {
      const named = [...optionValue(argv, '-t', '--target-directory'), ...optionValue(argv, undefined, '-Destination')]
      if (named.length > 0) return named
      const operands = operandsOf(argv)
      return operands.length >= 2 ? [operands[operands.length - 1]!] : []
    }
    case 'tee':
    case 'sponge':
    case 'shred':
    case 'touch':
    case 'truncate':
    case 'set-content':
    case 'add-content':
    case 'out-file':
    case 'new-item':
    case 'ni':
    case 'tee-object':
      return operandsOf(argv)
    case 'dd':
      return argv.filter(word => word.startsWith('of=')).map(word => word.slice(3))
    case 'curl': {
      const named = [...optionValue(argv, '-o', '--output'), ...optionValue(argv, undefined, '--output-dir')]
      return named.length > 0 ? named : argv.some(word => word === '--remote-name' || /^-[A-Za-z]*O/.test(word)) ? ['.'] : []
    }
    case 'wget': {
      const named = [...optionValue(argv, '-O', '--output-document'), ...optionValue(argv, '-P', '--directory-prefix')]
      return named.length > 0 ? named : ['.']
    }
    case 'sed':
    case 'perl':
      return argv.some(word => word === '--in-place' || word.startsWith('--in-place=') || /^-[A-Za-z]*i/.test(word)) ? operandsOf(argv) : []
    default:
      return []
  }
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

function remoteExecWard(layer: Layer, command: ReadCommand, read: ShellRead, work: WardWork | undefined): boolean {
  const { program, argv } = layer
  const assigned = (name: string): string | undefined => [...command.env, ...layer.env].find(entry => entry.name.toLowerCase() === name)?.value ?? read.exported.get(name)?.[0] ?? read.exported.get(name.toUpperCase())?.[0]
  const confirmed = (from: number): boolean => {
    if (truthy(assigned('npm_config_yes'))) return true
    for (let i = from; i < argv.length; i++) {
      const word = argv[i]!
      if (word === '--' || !word.startsWith('-')) return false
      if (word === '-y' || word === '--yes' || word === '--yes=true') return true
      if (NPX_VALUED.has(word)) i++
    }
    return false
  }
  if (program === 'npx') return confirmed(1)
  if (program === 'npm') {
    const at = argv.findIndex((word, i) => i > 0 && !word.startsWith('-'))
    return at > 0 && (argv[at] === 'exec' || argv[at] === 'x') && (confirmed(at + 1) || argv.slice(1, at).some(word => word === '-y' || word === '--yes'))
  }
  if (program === 'pnpm' || program === 'yarn') return operandsOf(argv)[0] === 'dlx'
  if (program === 'bunx' || (program === 'bun' && operandsOf(argv)[0] === 'x')) {
    const name = operandsOf(argv)[program === 'bun' ? 1 : 0]
    if (name === undefined) return false
    if (work) countWardWork(work, 'existsCalls')
    return !localBinary(name, command.cwd)
  }
  return false
}

function pinnedInstall(layer: Layer): boolean {
  const { program, argv } = layer
  const operands = operandsOf(argv)
  const verb = operands[0] ?? ''
  const pinned = (): boolean => argv.some(word => PINNED_AT.test(word) || PINNED_HASH.test(word))
  if (/^pip(?:x|\d[\d.]*)?$/.test(program) || program === 'pipenv') return verb === 'install' && pinned()
  if (/^python[\d.]*$/.test(program)) return argv.includes('pip') && argv.includes('install') && pinned()
  if (program === 'uv') return (verb === 'add' || (verb === 'pip' && operands[1] === 'install') || (verb === 'tool' && operands[1] === 'install')) && pinned()
  if (program === 'poetry') return verb === 'add' && pinned()
  if (program === 'npm' || program === 'pnpm' || program === 'yarn' || program === 'bun') return ['install', 'i', 'add'].includes(verb) && pinned()
  if (program === 'cargo') return verb === 'install' && argv.includes('--git') && [...optionValue(argv, undefined, '--rev')].some(rev => /^[0-9a-f]{7,40}$/i.test(rev))
  return false
}

function firstVerb(argv: string[], valued: ReadonlySet<string>): string {
  return operandsOf(argv, valued)[0]?.toLowerCase() ?? ''
}

const SYSTEMCTL_VALUED = new Set(['-t', '--type', '-H', '--host', '-M', '--machine', '-p', '--property', '-s', '--signal', '-n', '--lines', '-o', '--output', '--root', '--state', '--job-mode'])

function formatWard(layer: Layer): boolean {
  const { program, argv } = layer
  if (/^mkfs(?:\.[a-z0-9]+)?$/.test(program) || /^newfs(?:_[a-z0-9]+)?$/.test(program)) return true
  if (['mke2fs', 'mkswap', 'wipefs', 'cfdisk', 'sgdisk', 'diskpart', 'format-volume', 'clear-disk', 'initialize-disk', 'remove-partition', 'new-partition', 'resize-partition'].includes(program)) return true
  if (program === 'fdisk' || program === 'sfdisk' || program === 'gdisk') return !argv.some(word => word === '-l' || word === '--list')
  if (program === 'parted') {
    if (argv.some(word => ['-l', '--list', '-v', '--version', '-h', '--help'].includes(word))) return false
    const words = operandsOf(argv).map(word => word.toLowerCase())
    return !words.includes('print') || words.some(word => ['mklabel', 'mktable', 'mkpart', 'mkpartfs', 'rm', 'resizepart', 'resize', 'move', 'set', 'name', 'rescue', 'toggle', 'disk_set'].includes(word))
  }
  if (program === 'diskutil') {
    const verb = argv[1]?.toLowerCase() ?? ''
    if (/^erase/.test(verb) || ['partitiondisk', 'zerodisk', 'randomdisk', 'secureerase', 'reformat'].includes(verb)) return true
    return (verb === 'apfs' || verb === 'ap') && ['deletecontainer', 'erasevolume', 'deletevolume'].includes(argv[2]?.toLowerCase() ?? '')
  }
  return program === 'format' && argv.slice(1).some(word => /^[A-Za-z]:$/.test(word))
}

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

function forkBomb(read: ShellRead): number | undefined {
  const calls = new Map<string, Array<{ to: string; concurrent: boolean; at: number }>>()
  for (const command of read.commands) if (command.body !== undefined && !calls.has(command.body)) calls.set(command.body, [])
  for (const [at, command] of read.commands.entries()) {
    const callee = command.argv[0]
    if (command.body === undefined || callee === undefined || !calls.has(callee)) continue
    calls.get(command.body)!.push({ to: callee, concurrent: command.background || command.stages.some(stage => (read.pipelineSizes[stage.pipeline] ?? 1) > 1), at })
  }
  const reaches = (from: string, to: string, seen: Set<string>): boolean => {
    if (from === to) return true
    if (seen.has(from)) return false
    seen.add(from)
    return (calls.get(from) ?? []).some(call => reaches(call.to, to, seen))
  }
  for (const [name, made] of calls) {
    const forking = made.filter(call => call.concurrent && reaches(call.to, name, new Set()))
    if (forking.length >= 2) return forking[0]!.at
  }
  return undefined
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
  const hits: Hit[] = []
  const layered = read.commands.map(command => layersOf(command.argv))
  const hit = (ward: string, at: number, unread?: string): void => {
    const command = read.commands[at]!
    hits.push({ ward, at, excerpt: command.text.replace(/\s+/g, ' ').slice(0, 80), line: command.line, ...(unread === undefined ? {} : { unread }) })
  }
  const fetches = (at: number): boolean => layered[at]!.some(layer => FETCHERS.has(layer.program)) || /\.Download(?:String|File)\(/i.test(read.commands[at]!.text)
  const fetchers = read.commands.map((_command, at) => at).filter(fetches)
  const confirmers = read.commands.map((_command, at) => at).filter(at => layered[at]!.some(layer => layer.program === 'yes'))

  for (const [at, command] of read.commands.entries()) {
    if (work) countWardWork(work, 'steps')
    const layers = layered[at]!
    const unnamed = layers.find(layer => layer.argv[0] !== undefined && !wordKnown(layer.argv[0]))
    if (unnamed !== undefined) {
      const byText = textReading(command.around ?? command.text)
      const named = mention(command.text)
      const swept = unnamed.argv.slice(1).some(word => RECURSIVE_LONG.test(word) || RECURSE_PARAMETER.test(word) || (POSIX_RM_CLUSTER.test(word) && /[rR]/.test(word)))
        ? unnamed.argv.slice(1).find(word => !word.startsWith('-') && rootNamed(word, command, world) !== null)
        : undefined
      const theirs = /(?<![\w.-])(?:rm|unlink|rmdir|rd|ri|del|erase|remove-item)(?![\w-])/i.test(command.text) ? unnamed.argv.slice(1).find(word => !word.startsWith('-') && otherUserNamed(word, command, world)) : undefined
      if (!byText.allow) hits.push({ ward: byText.rule.name, at, excerpt: byText.excerpt, line: command.line })
      else if (named !== undefined) hit(named.ward, at, `its program is set at run time, and it mentions "${named.word}"`)
      else if (swept !== undefined) hit('no-root-recursive-delete', at, `its program is set at run time, and its arguments are those of a recursive delete of "${swept}"`)
      else if (theirs !== undefined) hit('no-other-user-delete', at, `its program is set at run time, it mentions a delete, and "${theirs}" lies in another user's home`)
    }
    for (const redirect of command.redirects) {
      if (!WRITE_REDIRECTS.has(redirect.op) || /^\d+$/.test(redirect.target) || redirect.target === '-') continue
      const ward = wardOfWrite(redirect.target, command, world)
      if (ward !== undefined) hit(ward, at)
    }
    let narrowed = false
    for (const layer of layers) {
      if (work) countWardWork(work, 'steps')
      const { program, argv } = layer
      if (layer.opaque !== undefined) {
        const byText = textReading(command.around ?? command.text)
        const named = mention(command.text)
        if (!byText.allow) hits.push({ ward: byText.rule.name, at, excerpt: byText.excerpt, line: command.line })
        else if (named !== undefined) hit(named.ward, at, `${layer.opaque}, and it mentions "${named.word}"`)
      }
      if (program === 'sudo' || program === 'doas' || program === 'pkexec') hit('no-sudo', at)
      if (haltWard(layer)) hit('no-system-halt', at)
      if (formatWard(layer)) hit('no-disk-format', at)
      if (remoteExecWard(layer, command, read, work)) hit('npm-exec-yes', at)
      if ((program === 'npx' || (program === 'npm' && ['exec', 'x'].includes(operandsOf(argv)[0] ?? ''))) && confirmers.some(earlier => sharesEarlier(read.commands[earlier]!, command))) hit('npm-exec-yes', at)
      if (pinnedInstall(layer)) hit('git-install-sha', at)
      if (program === 'disown' || (program === 'setsid' && argv.slice(1).some(word => word === '-f' || word === '--fork'))) hit('self-daemonize', at)
      if (command.background && (program === 'nohup' || program === 'setsid' || layer.wrappers.includes('nohup') || layer.wrappers.includes('setsid'))) hit('self-daemonize', at)
      if (program === 'crontab' && !(argv.includes('-l') && operandsOf(argv, new Set(['-u'])).length === 0)) hit('cron-persist', at)
      if (program === 'systemctl' && ['enable', 'reenable', 'link'].includes(firstVerb(argv, SYSTEMCTL_VALUED))) hit('systemd-persist', at)
      if (program === 'launchctl' && ['load', 'bootstrap', 'submit'].includes(argv[1]?.toLowerCase() ?? '')) hit('autostart-persist', at)
      if ((program === 'perl' || program === 'ruby') && argv.some(word => /\bfork\s+while\s+fork\b/.test(word))) hit('no-fork-bomb', at)
      if (program === 'git') {
        const ward = gitConfigWard(layer, command, world)
        if (ward !== undefined) hit(ward, at)
      }
      if (program === 'dd') {
        for (const target of argv.filter(word => word.startsWith('of='))) {
          const path = posixPath(target.slice(3), command.cwd, world)
          if (path !== undefined && path.startsWith('/dev/') && !SAFE_NODE.test(path)) hit('no-device-write', at)
        }
      }
      for (const target of writtenBy(layer)) {
        const ward = wardOfWrite(target, command, world)
        if (ward !== undefined) hit(ward, at)
      }
      if (program === 'find') {
        narrowed = argv.some(word => FIND_NARROWING.has(word))
        const roots = layer.findRoots === undefined || layer.findRoots.length === 0 ? ['.'] : layer.findRoots
        if (argv.includes('-delete')) {
          if (!narrowed && roots.some(root => rootNamed(root, command, world) !== null)) hit('no-root-recursive-delete', at)
          if (roots.some(root => otherUserNamed(root, command, world))) hit('no-other-user-delete', at)
        }
      }
      if (program === 'rsync' && argv.some(word => /^--del(?:ete(?:-[a-z]+)?)?$/.test(word))) {
        const operands = operandsOf(argv)
        const target = operands[operands.length - 1]
        if (operands.length >= 2 && target !== undefined && rootNamed(target, command, world) !== null) hit('no-root-recursive-delete', at)
      }
      const removal = deleteOf(layer, command, read.commands)
      if (removal !== null && layer.wrappers.includes('xargs')) {
        const fed = [command.input, ...read.commands.filter(earlier => sharesEarlier(earlier, command)).map(earlier => printedBy(earlier))]
        for (const text of fed) if (text !== undefined) removal.operands.push(...text.split(/\s+/).filter(word => word !== '' && !word.startsWith('-')))
      }
      if (removal !== null && !removal.preview) {
        const found = layer.findRoots !== undefined && layer.argv !== command.argv
        if (removal.recursive && !(found && narrowed) && removal.operands.some(word => rootNamed(word, command, world) !== null)) hit('no-root-recursive-delete', at)
        if (removal.operands.some(word => otherUserNamed(word, command, world))) hit('no-other-user-delete', at)
        for (const [earlier, lister] of read.commands.entries()) {
          if (!sharesEarlier(lister, command)) continue
          const listing = layered[earlier]!.find(listed => LISTERS.has(listed.program) || listed.program === 'find')
          if (listing === undefined) continue
          const listed = listing.program === 'find' ? (listing.findRoots ?? []) : operandsOf(listing.argv)
          const deep = removal.recursive || listing.argv.some(word => RECURSE_PARAMETER.test(word) || (POSIX_RM_CLUSTER.test(word) && word.includes('R')))
          if (deep && listing.program !== 'find' && listed.some(word => rootNamed(word, lister, world, true) !== null)) hit('no-root-recursive-delete', at)
          if (listed.some(word => otherUserNamed(word, lister, world))) hit('no-other-user-delete', at)
        }
      }
      const runsInput = stdinProgram(layer) || (command.dialect === 'powershell' && (program === 'invoke-expression' || program === 'iex'))
      if (runsInput && fetchers.some(earlier => sharesEarlier(read.commands[earlier]!, command))) hit('curl-pipe-shell', at)
      if (SCRIPT_RUNNERS.has(program) && innerCommands(command, read.commands).some(inner => layersOf(inner.argv).some(found => FETCHERS.has(found.program)) || /\.Download(?:String|File)\(/i.test(inner.text))) hit('curl-pipe-shell', at)
    }
    if (command.dialect === 'powershell') {
      const call = /\[(?:System\.)?IO\.(File|Directory)\]::Delete\(\s*(?:'([^']*)'|"([^"]*)")\s*(,\s*\$true)?/i.exec(command.text)
      const target = call?.[2] ?? call?.[3]
      if (call !== null && target !== undefined) {
        if (call[1]!.toLowerCase() === 'directory' && call[4] !== undefined && rootNamed(target, command, world) !== null) hit('no-root-recursive-delete', at)
        if (otherUserNamed(target, command, world)) hit('no-other-user-delete', at)
      }
    }
  }
  const bomb = forkBomb(read)
  if (bomb !== undefined) hit('no-fork-bomb', bomb)
  let first: Hit | undefined
  for (const found of hits) {
    if (first === undefined || WARD_ORDER.indexOf(found.ward) < WARD_ORDER.indexOf(first.ward) || (found.ward === first.ward && found.at < first.at)) first = found
  }
  return first
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
  const fold = platform === 'darwin' || platform === 'win32'
  const parent = home === undefined ? '' : posix.dirname(home)
  const named = posix.basename(parent)
  const holdsHomes = fold ? ['users', 'home'].includes(named.toLowerCase()) : named === 'Users' || named === 'home'
  return {
    cwd: platform === 'win32' ? undefined : cwd,
    home,
    homesRoot: holdsHomes ? parent : platform === 'darwin' ? '/Users' : '/home',
    ownNames: ownHomeNames(),
    platform,
    homes,
    windowsHome: process.env.USERPROFILE || (platform === 'win32' ? process.env.HOME : undefined) || undefined,
    startingFolder: pending.startingFolder,
    resolvePath: pending.resolvePath,
    toolName: pending.toolName,
  }
}

export async function refusalOfShellCommand(pending: PendingToolCall, cwd: string, work?: WardWork): Promise<WardVerdict> {
  const text = pending.shellCommand ?? ''
  const dialect = pending.toolName === 'PowerShell' ? 'powershell' : 'posix'
  const world = worldOf(pending, cwd)
  let read: ShellRead | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    read = await Promise.race([readShellCommands(text, dialect, world), new Promise<undefined>(resolve => (timer = setTimeout(resolve, READ_DEADLINE_MS, undefined)))])
  } catch {
    return evaluateWards(REFUSAL_WARDS, pending, work)
  } finally {
    clearTimeout(timer)
  }
  try {
    const unread = read === undefined ? { why: 'the shell parser did not answer in time', text } : read.unread
    const textReading = (part: string): WardVerdict => evaluateWards(REFUSAL_WARDS, { ...pending, shellCommand: part }, work)
    if (read !== undefined && unread === undefined) return verdictOf(judgeShellRead(read, world, textReading, work), pending.toolName)
    const byText = evaluateWards(REFUSAL_WARDS, pending, work)
    if (!byText.allow) return byText
    const outside = unread!.text === text && dialect === 'posix' ? shellTextOutsideFileHeredocs(text) : unread!.text
    const named = mention(outside)
    if (named === undefined) return read === undefined ? { allow: true } : verdictOf(judgeShellRead(read, world, textReading, work), pending.toolName)
    const at = outside.indexOf(named.word)
    const excerpt = outside.slice(Math.max(0, at - 30), at + 50).replace(/\s+/g, ' ').trim()
    return verdictOf({ ward: named.ward, at: 0, excerpt, line: outside.slice(0, Math.max(0, at)).split('\n').length, unread: `${unread!.why}, and it mentions "${named.word}"` }, pending.toolName)
  } catch {
    return evaluateWards(REFUSAL_WARDS, pending, work)
  }
}
