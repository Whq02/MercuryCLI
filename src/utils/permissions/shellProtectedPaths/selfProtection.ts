import { flagEnv } from '../../../substrate/flagRegistry.js'
import { getShellCwd } from '../../Shell.js'
import { getMercuryHome } from '../../envUtils.js'
import { type Layer, type ReadCommand, UNREAD_PART, layersOf } from '../../wards/wardsShellRead.js'
import { namesMercuryProcess, runtimeProcessRefusal, runtimeWritePath } from '../runtimeProtection.js'
import { protectedPathForms } from './paths.js'
import { OTHER_WRITERS, RUNTIME_WRITERS, TREE_MOVERS, UNREAD_ADVICE, WRITERS, WRITE_REDIRECT, pathLike, runtimeOperands, unreadWords, verb } from './words.js'
import { inlineScriptWrites } from './inlineScripts.js'
import { walkShellCommands } from './walk.js'
import { mercuryHomes, readForFloors } from './homes.js'
import { foldersAfter } from './folders.js'
import { GIT_OPTION_VALUED, sharesEarlierStage } from './listings.js'
import { TREE_REMOVERS } from './credentialWrite.js'

const GIT_WRITES = new Set(['checkout', 'clean', 'reset', 'restore', 'switch', 'pull', 'merge', 'rebase', 'stash', 'apply', 'am', 'cherry-pick', 'revert', 'rm', 'mv', 'init', 'clone', 'worktree', 'submodule', 'read-tree', 'checkout-index'])
const PACKAGE_WRITES = new Set(['install', 'i', 'ci', 'add', 'uninstall', 'remove', 'rm', 'update', 'up', 'upgrade', 'dedupe', 'prune', 'rebuild', 'link'])
const ATTRIBUTE_WRITERS = new Set(['chown', 'chgrp', 'chflags', 'xattr', 'touch', 'setfacl', 'lchown'])

const SCRIPT_LANGUAGES = /^(?:node|nodejs|bun|deno|python[\d.]*|ruby|perl|php|lua)$/
const PATTERN_READERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'awk', 'gawk', 'sed', 'pgrep', 'pidof'])

function valuesOf(argv: string[], ...names: string[]): string[] {
  const out: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!
    const named = names.find(name => word === name || word.startsWith(`${name}=`) || (name.length === 2 && word.startsWith(name) && word.length > 2 && !word.startsWith('--')))
    if (named === undefined) continue
    if (word === named) {
      if (argv[i + 1] !== undefined) out.push(argv[++i]!)
    } else out.push(word.slice(word.startsWith(`${named}=`) ? named.length + 1 : named.length))
  }
  return out
}

function plainOperands(argv: string[]): string[] {
  return argv.slice(1).filter(word => !word.startsWith('-'))
}

function runtimeTargetsOf(layer: Layer): Array<{ path: string; removesTree: boolean }> {
  const { program, argv } = layer
  const at = (paths: string[], removesTree = false): Array<{ path: string; removesTree: boolean }> => paths.map(path => ({ path, removesTree }))
  switch (program) {
    case 'tar':
    case 'bsdtar':
    case 'gtar': {
      const extracts = /^-?[A-Za-z]*x/.test(argv[1] ?? '') || argv.slice(1).some(word => word === '--extract' || word === '--get' || (/^-[A-Za-z]+$/.test(word) && word.includes('x')))
      if (!extracts) return []
      const into = valuesOf(argv, '-C', '--directory', '--cd')
      return at(into.length > 0 ? into : ['.'])
    }
    case 'unzip': {
      const into = valuesOf(argv, '-d')
      return at(into.length > 0 ? into : ['.'])
    }
    case 'curl': {
      const named = [...valuesOf(argv, '-o', '--output'), ...valuesOf(argv, '--output-dir')]
      return at(named.length > 0 ? named : argv.some(word => word === '--remote-name' || /^-[A-Za-z]*O/.test(word)) ? ['.'] : [])
    }
    case 'wget': {
      const named = [...valuesOf(argv, '-O', '--output-document'), ...valuesOf(argv, '-P', '--directory-prefix')]
      return at(named.length > 0 ? named : ['.'])
    }
    case 'patch': {
      const into = valuesOf(argv, '-d', '--directory')
      return at(into.length > 0 ? into : ['.'])
    }
    case 'git': {
      let i = 1
      const folders: string[] = []
      while (i < argv.length && argv[i]!.startsWith('-')) {
        const word = argv[i]!
        if (word === '-C' || word === '--work-tree' || word === '--git-dir') folders.push(argv[i + 1] ?? '')
        else if (word.startsWith('--work-tree=') || word.startsWith('--git-dir=')) folders.push(word.slice(word.indexOf('=') + 1))
        i += GIT_OPTION_VALUED.has(word) ? 2 : 1
      }
      return GIT_WRITES.has(argv[i] ?? '') ? at(folders.length > 0 ? folders : ['.'], argv[i] === 'clean') : []
    }
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      const folders = valuesOf(argv, '--prefix', '--dir', '--cwd', '-C')
      const verb = plainOperands(argv).find(word => !folders.includes(word)) ?? ''
      return PACKAGE_WRITES.has(verb) ? at(folders.length > 0 ? folders : ['.']) : []
    }
    case 'ditto': {
      const operands = plainOperands(argv)
      return operands.length >= 2 ? at([operands[operands.length - 1]!]) : []
    }
    default:
      return ATTRIBUTE_WRITERS.has(program) ? at(plainOperands(argv)) : []
  }
}

function inlineScriptOf(layer: Layer): string | null {
  if (!SCRIPT_LANGUAGES.test(layer.program)) return null
  const flag = layer.argv.findIndex((word, i) => i > 0 && /^-(?:e|c|p|E|r)$/.test(word))
  return flag >= 0 ? layer.argv.slice(flag + 1).join(' ') : null
}

export async function killOfNamedPid(text: string): Promise<string | null> {
  if (!/kill|terminate/i.test(text)) return null
  for (const number of [...new Set([...text.matchAll(/\b\d{2,}\b/g)].map(match => match[0]))].slice(0, 32)) {
    const reason = await runtimeProcessRefusal([['kill', number]])
    if (reason) return reason
  }
  return null
}

function withinMercuryRecords(word: string, cwd: string, homes: readonly string[]): boolean {
  if (word === '' || word.startsWith('-') || word.includes(UNREAD_PART)) return false
  return protectedPathForms(word, cwd).some(form => homes.some(home => form === home || form.startsWith(`${home}/`)))
}

async function readSelfProtection(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  const read = await readForFloors(command, powershell, cwd)
  if (read === null) return null
  const homes = [...mercuryHomes(), ...protectedPathForms(flagEnv('MERCURY_DAEMON_DIR') || getMercuryHome())]
  const changing = (path: string, hit: string): string => 'Changing ' + path + ' is refused: ' + hit + ' is part of Mercury’s running runtime.'
  for (const { simple, here } of read.commands.flatMap((simple, at) => foldersAfter(read, at, cwd).folders.map(here => ({ simple, here })))) {
    const feeders = (piped: boolean): ReadCommand[] => {
      const out: ReadCommand[] = []
      const seen = new Set<number>()
      const visit = (indexes: readonly number[]): void => {
        for (const index of indexes) {
          const inner = read.commands[index]
          if (inner === undefined || seen.has(index)) continue
          seen.add(index)
          out.push(inner)
          visit(inner.inner.flat())
          visit(inner.inputInner)
        }
      }
      visit(simple.inner.flat())
      visit(simple.inputInner)
      if (piped) for (const earlier of read.commands) if (sharesEarlierStage(earlier, simple)) out.push(earlier)
      return out
    }
    for (const redirect of simple.redirects) {
      if (!['>', '>>', '>|', '&>', '&>>'].includes(redirect.op)) continue
      const hit = runtimeWritePath(redirect.target, here, false)
      if (hit !== null) return changing(redirect.target, hit)
    }
    for (const layer of layersOf(simple.argv)) {
      const reason = await runtimeProcessRefusal([layer.argv])
      if (reason) return reason
      const script = inlineScriptOf(layer)
      if (script !== null) {
        const killed = await killOfNamedPid(script)
        if (killed) return killed
      }
      const piped = layer.wrappers.includes('xargs')
      if (layer.program === 'kill' && (piped || layer.argv.some(word => word.includes(UNREAD_PART)))) {
        if (simple.input !== undefined) {
          const killed = await killOfNamedPid(`kill ${simple.input}`)
          if (killed) return killed
        }
        for (const feeder of feeders(piped)) {
          const there = foldersAfter(read, read.commands.indexOf(feeder), cwd).folders[0] ?? cwd
          for (const fed of layersOf(feeder.argv)) {
            const record = fed.argv.slice(1).find(word => withinMercuryRecords(word, there, homes))
            if (record !== undefined) return 'Killing a process named by ' + record + ' is refused: that file is Mercury’s own record of its running process or daemon.'
            let pattern: string | undefined
            for (const word of PATTERN_READERS.has(fed.program) ? fed.argv.slice(1) : []) {
              if (!word.startsWith('-') && (await namesMercuryProcess(word))) {
                pattern = word
                break
              }
            }
            if (pattern !== undefined) return 'Killing the processes that match ' + pattern + ' is refused: it can terminate Mercury’s running process or daemon. Use the pid of the unrelated process instead.'
          }
        }
      }
      for (const target of [...runtimeTargetsOf(layer), ...runtimeOperands(layer.argv, simple.dialect === 'powershell')]) {
        const hit = runtimeWritePath(target.path, here, target.removesTree)
        if (hit !== null) return changing(target.path, hit)
      }
      if (TREE_REMOVERS.has(layer.program) && (piped || layer.argv.some(word => word.includes(UNREAD_PART)))) {
        for (const feeder of feeders(piped)) {
          const there = foldersAfter(read, read.commands.indexOf(feeder), cwd).folders[0] ?? cwd
          for (const fed of layersOf(feeder.argv)) {
            for (const word of [...fed.argv.slice(1), ...(fed.findRoots ?? [])]) {
              if (word.startsWith('-') || word.includes(UNREAD_PART)) continue
              const hit = runtimeWritePath(word, there, false)
              if (hit !== null) return changing(word, hit)
            }
          }
        }
      }
    }
  }
  const words = unreadWords(read, command, powershell)
  const removes = words.some(word => TREE_MOVERS.includes(verb(word)))
  if (removes || words.some(word => WRITERS.has(verb(word)) || OTHER_WRITERS.has(verb(word)) || RUNTIME_WRITERS.has(verb(word))) || (words.length > 0 && WRITE_REDIRECT.test(command))) {
    for (const word of words) {
      const hit = pathLike(word) ? runtimeWritePath(word, cwd, removes) : null
      if (hit !== null) return `${changing(word, hit)} ${UNREAD_ADVICE}.`
    }
  }
  return null
}

export async function shellSelfProtectionReason(command: string, powershell = false, cwd = getShellCwd()): Promise<string | null> {
  const named = await namedSelfProtectionReason(command, powershell, cwd)
  return named ?? readSelfProtection(command, powershell, cwd)
}

async function namedSelfProtectionReason(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  return walkShellCommands(command, powershell, async ({ argv, commands, operandEnds, cwd, text, powershell: ps }) => {
    if (ps) {
      for (const call of text.matchAll(/(?:^|[;\n])\s*\[(?:System\.)?IO\.(?:File|Directory)\]::(?:WriteAllText|WriteAllBytes|AppendAllText|AppendAllLines|Delete|Move|Create|OpenWrite)\s*\(\s*(['"])([^'"\r\n]+)\1/gi)) {
        const hit = runtimeWritePath(call[2]!, cwd, true)
        if (hit) return 'Changing ' + call[2] + ' is refused: ' + hit + ' is part of Mercury’s running runtime.'
      }
    }
    const processReason = await runtimeProcessRefusal(commands, operandEnds)
    if (processReason) return processReason
    for (const target of runtimeOperands(argv, ps)) {
      const hit = runtimeWritePath(target.path, cwd, target.removesTree)
      if (hit !== null) return 'Changing ' + target.path + ' is refused: ' + hit + ' is part of Mercury’s running runtime.'
    }
    const name = verb(argv[0] ?? '')
    const flag = argv.findIndex((word, i) => i > 0 && /^-(?:e|c|p|command)$/i.test(word))
    if (/^(?:node|bun|python[\d.]*|ruby|perl)$/.test(name) && flag >= 0) {
      const script = argv.slice(flag + 1).join(' ')
      for (const target of inlineScriptWrites(script)) {
        const hit = runtimeWritePath(target, cwd, true)
        if (hit) return 'Changing ' + target + ' is refused: ' + hit + ' is part of Mercury’s running runtime.'
      }
      for (const killCall of script.matchAll(/\b(?:process|os)\.kill\s*\(\s*(\d+)/g)) {
        const reason = await runtimeProcessRefusal([['kill', killCall[1]!]])
        if (reason) return reason
      }
    }
    return null
  }, cwd)
}
