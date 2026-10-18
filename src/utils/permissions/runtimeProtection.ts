import { readFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describeArtifactIdentity } from '../artifactIdentity.js'
import { defaultMercuryHome, getMercuryHome } from '../envUtils.js'
import { getShellCwd } from '../Shell.js'
import { subprocessEnv } from '../subprocessEnv.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { getAncestorPidsAsync } from '../genericProcessUtils.js'
import { readDaemonState } from '../../daemon/controlSocket.js'
import { getProcessStartTokenAsync, isProcessAlive } from '../../daemon/ownerWatch.js'
import { protectedPathForms } from './protectedPaths.js'
import { matchWildcardPattern } from './shellRuleMatching.js'

const inside = (path: string, root: string): boolean => path === root || path.startsWith(root + '/')

function runtimeRoots(): string[] {
  const artifact = describeArtifactIdentity('')
  const roots = [join(getMercuryHome(), 'runtime'), join(defaultMercuryHome(), 'runtime'), ...protectedPathForms(process.execPath).map(path => posix.dirname(path))]
  if (artifact.entry && artifact.distribution !== 'source-run') roots.push(dirname(artifact.entry))
  return roots.flatMap(root => protectedPathForms(root))
}

export function runtimeWritePath(path: string, cwd = getShellCwd(), removesTree = true): string | null {
  const roots = runtimeRoots()
  for (const candidate of protectedPathForms(path, cwd)) {
    const conventional = candidate.match(/^(?:\/(?:users|home)\/[^/]+|\/root|[a-z]:\/users\/[^/]+)\/\.mercury\/runtime(?=\/|$)/)?.[0]
    if (conventional) return conventional
    for (const root of roots) {
      if (inside(candidate, root) || (removesTree && inside(root, candidate))) return root
      if (removesTree && /[*?[]/.test(candidate)) {
        let parent = root
        while (parent !== posix.dirname(parent)) {
          if (matchWildcardPattern(candidate, parent, true)) return root
          parent = posix.dirname(parent)
        }
      }
    }
  }
  return null
}

function name(word: string): string {
  return word.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '')
}

function optionValues(args: string[], option: RegExp): string[] {
  const result: string[] = []
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!
    const split = word.search(/[:=]/)
    if (option.test(split < 0 ? word : word.slice(0, split))) {
      result.push(split < 0 ? args[++i] ?? '' : word.slice(split + 1))
    }
  }
  return result.flatMap(value => value.split(','))
}

function positionals(args: string[], valued: RegExp): string[] {
  const result: string[] = []
  let ended = false
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!
    if (word === '--') { ended = true; continue }
    if (!ended && valued.test(word)) { i++; continue }
    if (ended || !/^[-/]/.test(word)) result.push(word)
  }
  return result
}

async function protectedPids(): Promise<number[]> {
  const pids = [process.pid]
  const state = await readDaemonState()
  if (state && Number.isSafeInteger(state.pid) && state.pid > 0 && isProcessAlive(state.pid)) {
    const token = state.startToken ? await getProcessStartTokenAsync(state.pid) : null
    if (!state.startToken || token === null || token === state.startToken) pids.push(state.pid)
  }
  return pids
}

function imageMatches(pattern: string, regex: boolean, full: boolean, insensitive: boolean): boolean {
  const images = [name(process.execPath), name(process.execPath) + '.exe', 'mercury', 'mercury.exe']
  const candidates = full ? [...images, [process.execPath, ...process.argv.slice(1)].join(' ')] : images
  if (!regex) return candidates.some(image => matchWildcardPattern(pattern, image, insensitive))
  try {
    const re = new RegExp(pattern, insensitive ? 'i' : '')
    return candidates.some(image => re.test(image))
  } catch { return false }
}

function selectedImages(argv: string[]): string[] {
  const command = name(argv[0] ?? '')
  const args = argv.slice(1)
  if (command === 'taskkill') return optionValues(args, /^\/im$/i)
  if (command === 'stop-process' || command === 'get-process' || command === 'spps' || command === 'gps') {
    const named = optionValues(args, /^-n(?:a(?:m(?:e)?)?)?$/i)
    if (named.length) return named
    if (args.some(arg => /^-(?:id|inputobject)(?:[:=]|$)/i.test(arg))) return []
    return positionals(args, /^-(?:erroraction|ea|warningaction|wa)$/i).filter(arg => !/^\d+$/.test(arg))
  }
  if (command === 'killall') return positionals(args, /^-(?:u|user|s|signal|t)$/i)
  if (command === 'pkill' || command === 'pgrep') {
    return positionals(args, /^-(?:[ugGPUsFt]|-(?:euid|uid|group|pgroup|parent|session|terminal|pidfile|signal))$/).slice(-1)
  }
  return []
}

async function launchAgentReason(args: string[], pids: number[]): Promise<string | null> {
  if (!['bootout', 'unload'].includes(args[0] ?? '')) return null
  for (const target of args.slice(1).filter(arg => !arg.startsWith('-'))) {
    if (target.endsWith('.plist')) {
      try {
        const text = readFileSync(target, 'utf8')
        const program = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1]
          ?? /<key>Program<\/key>\s*(<string>[^<]*<\/string>)/.exec(text)?.[1] ?? ''
        const paths = [...program.matchAll(/<string>([^<]+)/g)].map(match => match[1]!)
        const entries = [process.argv[1], (await readDaemonState())?.script].filter((path): path is string => !!path).flatMap(path => protectedPathForms(path))
        if (paths.some(path => protectedPathForms(path).some(form => entries.includes(form)))) return target
      } catch {}
    } else if (process.platform === 'darwin') {
      try {
        const printed = execFileSync('launchctl', ['print', target], { encoding: 'utf8', timeout: 2000, windowsHide: true, env: { ...subprocessEnv() }, stdio: ['ignore', 'pipe', 'ignore'] })
        if ([...printed.matchAll(/\bpid\s*=\s*(\d+)/g)].some(match => pids.includes(Number(match[1])))) return target
      } catch {}
    }
  }
  return null
}

async function parentPid(pid: number): Promise<number | undefined> {
  if (pid === process.pid) return process.ppid
  if (process.platform === 'win32') return (await getAncestorPidsAsync(pid, 1))[0]
  const result = await execFileNoThrow('ps', ['-o', 'ppid=', '-p', String(pid)])
  const parent = Number(result.stdout.trim())
  return result.code === 0 && parent > 0 ? parent : undefined
}

export async function runtimeProcessRefusal(commands: string[][]): Promise<string | null> {
  const kills = new Set(['kill', 'pkill', 'killall', 'taskkill', 'stop-process', 'spps', 'launchctl'])
  if (!commands.some(argv => kills.has(name(argv[0] ?? '')) || argv.some(word => kills.has(name(word))))) return null
  const pids = await protectedPids()
  const hasPipedKill = commands.some(argv => ['kill', 'stop-process', 'spps'].includes(name(argv[0] ?? '')) || (name(argv[0] ?? '') === 'xargs' && argv.some(word => name(word) === 'kill')))
  for (const argv of commands) {
    const command = name(argv[0] ?? '')
    const args = argv.slice(1)
    if (args.some(arg => /^-whatif$/i.test(arg))) continue
    if (command === 'launchctl') {
      const target = await launchAgentReason(args, pids)
      if (target) return 'Stopping ' + target + ' is refused: it owns Mercury’s running process or daemon.'
    }
    const filters = command === 'taskkill' ? optionValues(args, /^\/fi$/i) : []
    const filterPids = filters.flatMap(value => /^pid\s+eq\s+(\d+)$/i.exec(value)?.slice(1) ?? [])
    if (command === 'kill' || command === 'taskkill' || command === 'stop-process' || command === 'spps' || (hasPipedKill && ['get-process', 'gps'].includes(command))) {
      if (command === 'kill' && (args.some(arg => /^-(?:l|L|0)$/.test(arg)) || optionValues(args, /^-(?:s|-signal)$/).some(value => /^(?:0|SIG0)$/i.test(value)))) continue
      if (command === 'kill' && (args.at(-1) === '-1' && args.length > 1 || args.includes('0'))) return 'Killing all processes or the shell process group is refused: it can terminate Mercury’s running process or daemon.'
      const targets = command === 'taskkill' ? [...optionValues(args, /^\/pid$/i), ...filterPids]
        : command === 'kill' ? positionals(args, /^-(?:s|n|-signal)$/)
        : [...optionValues(args, /^-id$/i), ...positionals(args, /^-(?:name|n|inputobject|erroraction|ea)$/i)]
      const pid = targets.find(target => /^\d+$/.test(target) && pids.includes(Number(target)))
      if (pid) return 'Killing pid ' + pid + ' is refused: it is Mercury’s own process or daemon.'
    }
    if (!kills.has(command) && !(hasPipedKill && ['pgrep', 'get-process', 'gps'].includes(command))) continue
    if (filterPids.length && !filterPids.some(pid => pids.includes(Number(pid)))) continue
    const parents = ['pkill', 'pgrep'].includes(command) ? optionValues(args, /^-(?:P|-parent)$/) : []
    if (parents.length) {
      const ownParents = await Promise.all(pids.map(parentPid))
      if (ownParents.every(parent => parent !== undefined && !parents.includes(String(parent)))) continue
    }
    const regex = command === 'pkill' || command === 'pgrep' || (command === 'killall' && args.some(arg => /^-(?:r|-regexp)$/.test(arg)))
    const full = regex && args.some(arg => /^-[^-]*f/.test(arg) || arg === '--full')
    const insensitive = !regex || args.some(arg => /^-[^-]*i/.test(arg) || arg === '--ignore-case')
    const images = [...selectedImages(argv), ...filters.flatMap(value => /^imagename\s+eq\s+(.+)$/i.exec(value)?.slice(1) ?? [])]
    for (const image of images) {
      const exact = regex && args.some(arg => /^-(?:[a-z]*x[a-z]*|-exact)$/.test(arg))
      if (imageMatches(exact ? '^(?:' + image + ')$' : image, regex, full, insensitive)) return 'Killing by image ' + image + ' is refused: it can terminate Mercury’s running process or daemon. Use the pid of the unrelated process instead.'
    }
  }
  return null
}
