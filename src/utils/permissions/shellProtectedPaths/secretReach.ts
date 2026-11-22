import { posix } from 'node:path'
import { type CommandReading, type ReadCommand, type ShellRead, UNREAD_PART, layersOf, moveOf, wordKnown } from '../decision/commandAnalysis.js'
import { expandPath, hasNulByte } from '../../path.js'
import { mercurySecretPath, spelling } from './paths.js'
import { UNREAD_ADVICE, flaggedReadOperands, readOperands, unreadWords, verb } from './words.js'
import { inlineScriptOf, inlineScriptOfArgv, inlineScriptReads } from './inlineScripts.js'
import { expandShellConstants, walkShellCommands } from './walk.js'
import { GLOB_PART, SECRET_NAME_SAMPLES, UPLOADERS, couldNameSecret, floorsWorld, globNamesStore, holdsMercuryHome, mercuryHomes, namesMercuryHome, readForFloors, secretNameBehindUnread, secretsHeld, spellingsOf, underOtherHomes } from './homes.js'
import { foldersAfter, foldersRead, oldFolderPlaces } from './folders.js'
import { FILE_READERS, FIND_NON_READERS, POWERSHELL_LISTERS, callsUnreadName, filesSentOrPrinted, findMaxDepth, findNamesASecret, findstrFolderFiles, gitGrepRoots, joinedUnderStanding, keychainItemRead, namesNoSecret, powershellListing, readsHandedFiles, readsWholeTree, receivesListing, ripgrepReachesHidden, searcherOf, searchesNamesAsText, searchesTextOfListing, sharesEarlierStage, stagesApart, standingSpelled, storeBelowDepth, treeReadRoots } from './listings.js'
import { notBuilt } from '../../../pi/holes.js'

const PS_NET_SECRET_READER = /(?:^|[;\n])\s*\[(?:System\.)?IO\.File\]::(?:ReadAllText|ReadAllBytes|ReadAllLines|ReadLines|OpenRead)\s*\(\s*(['"])([^'"\r\n]+)\1/gi
const PLAIN_CD_PROGRAMS = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location'])

function literalSecretToken(command: string, cwd: string): string | null {
  const pending = [command]
  while (pending.length) {
    const text = pending.pop()!
    for (const match of text.matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'();|<>=]+)/g)) {
      const token = match[1] ?? match[2] ?? match[3]!
      if (mercurySecretPath(token, cwd) !== null) return token
      if (token.length < text.length && (token.includes('"') || token.includes("'"))) pending.push(token)
    }
  }
  return null
}

function plainTrackedCwd(read: ShellRead, at: number, cwd: string): string {
  let current = cwd
  for (let i = 0; i < at; i++) {
    const move = moveOf(read.commands[i]!)
    if (move === undefined || !PLAIN_CD_PROGRAMS.has(move.program)) continue
    const target = move.operands[0]
    if (target !== undefined) {
      if (target === '-' || target.includes(UNREAD_PART) || hasNulByte(target)) continue
      current = expandPath(spelling(target), current)
    } else if (move.program !== 'pushd' && move.program !== 'push-location') {
      current = expandPath(spelling('~'), current)
    }
  }
  return current
}

async function namedMercurySecretPath(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  const literal = literalSecretToken(expandShellConstants(command, powershell), cwd)
  if (literal !== null) return literal
  return walkShellCommands(command, powershell, ({ argv, cwd: here, text, powershell: ps }) => {
    if (ps) {
      for (const call of text.matchAll(PS_NET_SECRET_READER)) {
        const hit = mercurySecretPath(call[2]!, here)
        if (hit !== null) return hit
      }
    }
    for (const path of readOperands(argv)) {
      const hit = mercurySecretPath(path, here)
      if (hit !== null) return path.includes('/') || path.includes('\\') ? path : hit
    }
    const script = inlineScriptOfArgv(verb(argv[0] ?? ''), argv)
    if (script !== null) {
      for (const target of inlineScriptReads(script)) {
        const hit = mercurySecretPath(target, here)
        if (hit !== null) return target.includes('/') || target.includes('\\') ? target : hit
      }
    }
    return null
  }, cwd)
}

function secretReachFromRead(read: CommandReading, powershell: boolean, cwd: string, homes: readonly string[]): string | null {
  return notBuilt('src/utils/permissions/shellProtectedPaths/secretReach.ts:69')
}

export async function readSecretReach(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  const named = await namedMercurySecretPath(command, powershell, cwd)
  if (named !== null) return named
  const read = await readForFloors(command, powershell, cwd)
  if (read === null) return null
  const homes = mercuryHomes()
  const hit = secretReachFromRead(read, powershell, cwd, homes)
  if (hit !== null) return !powershell && read.exact.kind === 'parse-unavailable' ? `${hit} (${UNREAD_ADVICE})` : hit
  const words = unreadWords(read, command, powershell)
  if (words.length > 0) {
    const stands = namesMercuryHome('.', cwd, homes)
    const needles = [...SECRET_NAME_SAMPLES, ...homes.flatMap(secretsHeld), ...homes.map(home => posix.basename(home))].map(name => name.toLowerCase())
    for (const word of words) {
      const lower = word.toLowerCase()
      if (!needles.some(needle => lower.includes(needle)) && !/^[~$%]/.test(word) && !(stands && (word === '.' || word.startsWith('./') || GLOB_PART.test(word)))) continue
      for (const candidate of spellingsOf(powershell ? standingSpelled(word) : word)) {
        const names = mercurySecretPath(candidate, cwd) !== null || namesMercuryHome(candidate, cwd, homes) || (wordKnown(candidate) && couldNameSecret(candidate, cwd, homes)) || (!/^(?:[/~-]|[A-Za-z]:)/.test(candidate) && homes.some(home => mercurySecretPath(candidate, home) !== null))
        if (names) return `${word} (${UNREAD_ADVICE})`
      }
    }
  }
  if (!powershell) {
    for (const place of oldFolderPlaces(read, command, cwd, () => floorsWorld(cwd).home, () => homes)) {
      const again = await readForFloors(command, false, cwd, place)
      if (again === null) continue
      const found = secretReachFromRead(again, false, cwd, homes)
      if (found !== null) return again.exact.kind === 'parse-unavailable' ? `${found} (${UNREAD_ADVICE})` : found
    }
  }
  return null
}
