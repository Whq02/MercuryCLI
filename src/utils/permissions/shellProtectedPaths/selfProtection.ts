import { flagEnv } from '../../../substrate/flagRegistry.js'
import { getMercuryHome } from '../../envUtils.js'
import { type CommandReading, type Layer, type ReadCommand, UNREAD_PART, layersOf } from '../decision/commandAnalysis.js'
import { namesMercuryProcess, runtimeProcessRefusal, runtimeWritePath } from '../runtimeProtection.js'
import { protectedPathForms } from './paths.js'
import { OTHER_WRITERS, RUNTIME_WRITERS, TREE_MOVERS, UNREAD_ADVICE, WRITERS, WRITE_REDIRECT, expandedLayerArgvs, pathLike, pipedPrinterOperands, runtimeOperands, spelledTargetWord, spelledUserArgv, unreadWords, verb, writtenLayerArgv } from './words.js'
import { inlineScriptOf, inlineScriptOfArgv, inlineScriptWrites } from './inlineScripts.js'
import { walkShellCommands } from './walk.js'
import { floorsWorld, mercuryHomes, readForFloors } from './homes.js'
import { foldersAfter, oldFolderPlaces } from './folders.js'
import { GIT_OPTION_VALUED, sharesEarlierStage } from './listings.js'
import { TREE_REMOVERS } from './credentialWrite.js'
import { notBuilt } from '../../../pi/holes.js'

const GIT_WRITES = new Set(['checkout', 'clean', 'reset', 'restore', 'switch', 'pull', 'merge', 'rebase', 'stash', 'apply', 'am', 'cherry-pick', 'revert', 'rm', 'mv', 'init', 'clone', 'worktree', 'submodule', 'read-tree', 'checkout-index'])
const PACKAGE_WRITES = new Set(['install', 'i', 'ci', 'add', 'uninstall', 'remove', 'rm', 'update', 'up', 'upgrade', 'dedupe', 'prune', 'rebuild', 'link'])
const ATTRIBUTE_WRITERS = new Set(['chown', 'chgrp', 'chflags', 'xattr', 'touch', 'setfacl', 'lchown'])

const PATTERN_READERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'awk', 'gawk', 'sed', 'pgrep', 'pidof'])
const KILL_RECEIVERS = new Set(['kill', 'stop-process', 'spps'])
const PS_NET_RUNTIME_WRITER = /(?:^|[;\n])\s*\[(?:System\.)?IO\.(?:File|Directory)\]::(?:WriteAllText|WriteAllBytes|AppendAllText|AppendAllLines|Delete|Move|Create|OpenWrite)\s*\(\s*(['"])([^'"\r\n]+)\1/gi

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

async function namedSelfProtectionReason(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  return walkShellCommands(command, powershell, async ({ argv, commands, operandEnds, cwd: here, text, powershell: ps }) => {
    if (ps) {
      for (const call of text.matchAll(PS_NET_RUNTIME_WRITER)) {
        const hit = runtimeWritePath(call[2]!, here, true)
        if (hit) return 'Changing ' + call[2] + ' is refused: ' + hit + ' is part of Mercury’s running runtime.'
      }
    }
    const processReason = await runtimeProcessRefusal(commands, operandEnds)
    if (processReason) return processReason
    for (const target of runtimeOperands(argv, ps)) {
      const hit = runtimeWritePath(target.path, here, target.removesTree)
      if (hit !== null) return 'Changing ' + target.path + ' is refused: ' + hit + ' is part of Mercury’s running runtime.'
    }
    const script = inlineScriptOfArgv(verb(argv[0] ?? ''), argv)
    if (script !== null) {
      for (const target of inlineScriptWrites(script)) {
        const hit = runtimeWritePath(target, here, true)
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

async function selfProtectionFromRead(read: CommandReading, cwd: string, changing: (path: string, hit: string) => string): Promise<string | null> {
  return notBuilt('src/utils/permissions/shellProtectedPaths/selfProtection.ts:134')
}

export async function readSelfProtection(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  const named = await namedSelfProtectionReason(command, powershell, cwd)
  if (named !== null) return named
  const read = await readForFloors(command, powershell, cwd)
  if (read === null) return null
  const changing = (path: string, hit: string): string => 'Changing ' + path + ' is refused: ' + hit + ' is part of Mercury’s running runtime.'
  const hit = await selfProtectionFromRead(read, cwd, changing)
  if (hit !== null) return !powershell && read.exact.kind === 'parse-unavailable' ? `${hit} ${UNREAD_ADVICE}.` : hit
  const words = unreadWords(read, command, powershell)
  const removes = words.some(word => TREE_MOVERS.includes(verb(word)))
  if (removes || words.some(word => WRITERS.has(verb(word)) || OTHER_WRITERS.has(verb(word)) || RUNTIME_WRITERS.has(verb(word))) || (words.length > 0 && WRITE_REDIRECT.test(command))) {
    for (const word of words) {
      const hit = pathLike(word) ? runtimeWritePath(word, cwd, removes) : null
      if (hit !== null) return `${changing(word, hit)} ${UNREAD_ADVICE}.`
    }
  }
  if (!powershell) {
    for (const place of oldFolderPlaces(read, command, cwd, () => floorsWorld(cwd).home, mercuryHomes)) {
      const again = await readForFloors(command, false, cwd, place)
      if (again === null) continue
      const found = await selfProtectionFromRead(again, cwd, changing)
      if (found !== null) return again.exact.kind === 'parse-unavailable' ? `${found} ${UNREAD_ADVICE}.` : found
    }
  }
  return null
}
