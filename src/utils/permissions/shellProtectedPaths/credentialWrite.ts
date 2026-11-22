import { posix } from 'node:path'
import { type CommandReading, layersOf } from '../decision/commandAnalysis.js'
import { credentialStorePath } from './paths.js'
import { OTHER_WRITERS, UNREAD_ADVICE, WRITERS, WRITE_REDIRECT, expandedLayerArgvs, pathLike, pipedPrinterOperands, spelledTargetWord, unreadWords, verb, writeOperands, writtenLayerArgv } from './words.js'
import { inlineScriptOf, inlineScriptOfArgv, inlineScriptWrites } from './inlineScripts.js'
import { expandShellConstants, walkShellCommands } from './walk.js'
import { GLOB_PART, floorsWorld, mercuryHomes, readForFloors } from './homes.js'
import { foldersAfter, oldFolderPlaces } from './folders.js'
import { POWERSHELL_LISTERS, powershellListing, sharesEarlierStage } from './listings.js'
import { notBuilt } from '../../../pi/holes.js'

const NET_WRITER = /\[(?:System\.)?IO\.(File|Directory|StreamWriter|FileStream)\]::(\w+)\s*\(/gi
const NET_WRITTEN: Record<string, readonly number[]> = { writealltext: [0], writeallbytes: [0], writealllines: [0], appendalltext: [0], appendalllines: [0], appendtext: [0], createtext: [0], create: [0], openwrite: [0], delete: [0], copy: [1], move: [0, 1], replace: [0, 1, 2] }

function callArguments(text: string, from: number): string[] {
  const out: string[] = []
  let depth = 0
  let part = ''
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1)
      const stop = end < 0 ? text.length : end
      part += text.slice(i, stop + 1)
      i = stop
    } else if (ch === ')' && depth-- === 0) break
    else if (ch === ',' && depth === 0) {
      out.push(part.trim())
      part = ''
    } else {
      if (ch === '(') depth++
      part += ch
    }
  }
  return [...out, part.trim()]
}

function netWrites(text: string): string[] {
  const out: string[] = []
  const bare = text.replace(/'[^']*'|"[^"]*"/g, quoted => quoted[0] + ' '.repeat(Math.max(0, quoted.length - 2)) + quoted[0])
  for (const call of bare.matchAll(NET_WRITER)) {
    const stream = call[1]!.toLowerCase() === 'streamwriter' || call[1]!.toLowerCase() === 'filestream'
    const args = callArguments(text, call.index + call[0].length)
    const reads = /^(?:['"]read['"]|\[(?:System\.)?IO\.FileAccess\]::Read)$/i.test(args[2] ?? '')
    const written = stream ? (call[2]!.toLowerCase() === 'new' && !reads ? [0] : []) : (NET_WRITTEN[call[2]!.toLowerCase()] ?? [])
    for (const at of written) {
      const path = /^(['"])([^'"\r\n]+)\1$/.exec(args[at] ?? '')?.[2]
      if (path !== undefined) out.push(path)
    }
  }
  return out
}

function credentialWriteWalked(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  return walkShellCommands(command, powershell, ({ argv, cwd: here, text, powershell: ps }) => {
    if (ps) {
      for (const call of text.matchAll(/(?:^|[;\n])\s*\[(?:System\.)?IO\.(?:File|Directory)\]::(?:WriteAllText|WriteAllBytes|AppendAllText|AppendAllLines|Delete|Move|Copy|Create|OpenWrite)\s*\(\s*(['"])([^'"\r\n]+)\1/gi)) {
        const hit = credentialStorePath(call[2]!, here)
        if (hit !== null) return call[2]!
      }
    }
    for (const path of writeOperands(argv, ps)) {
      const hit = credentialStorePath(path, here)
      if (hit !== null) return path.includes('/') || path.includes('\\') ? path : hit
    }
    const script = inlineScriptOfArgv(verb(argv[0] ?? ''), argv)
    if (script !== null) {
      for (const target of inlineScriptWrites(script)) {
        const hit = credentialStorePath(target, here)
        if (hit !== null) return target.includes('/') || target.includes('\\') ? target : hit
      }
    }
    return null
  }, cwd)
}

async function credentialWritePowerShell(command: string, cwd: string): Promise<string | null> {
  return notBuilt('src/utils/permissions/shellProtectedPaths/credentialWrite.ts:76')
}

function credentialWriteFromRead(read: CommandReading, cwd: string): string | null {
  return notBuilt('src/utils/permissions/shellProtectedPaths/credentialWrite.ts:125')
}

export async function readCredentialWrite(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  if (powershell) return credentialWritePowerShell(command, cwd)
  const named = await credentialWriteWalked(command, false, cwd)
  if (named !== null) return named
  const read = await readForFloors(command, false, cwd)
  if (read === null) return null
  const hit = credentialWriteFromRead(read, cwd)
  if (hit !== null) return read.exact.kind === 'parse-unavailable' ? `${hit} (${UNREAD_ADVICE})` : hit
  const words = unreadWords(read, command, false)
  if (words.some(word => WRITERS.has(verb(word)) || OTHER_WRITERS.has(verb(word))) || (words.length > 0 && (WRITE_REDIRECT.test(command) || netWrites(command).length > 0))) {
    for (const word of words) if (pathLike(word) && credentialStorePath(word, cwd) !== null) return `${word} (${UNREAD_ADVICE})`
  }
  for (const place of oldFolderPlaces(read, command, cwd, () => floorsWorld(cwd).home, mercuryHomes)) {
    const again = await readForFloors(command, false, cwd, place)
    if (again === null) continue
    const found = credentialWriteFromRead(again, cwd)
    if (found !== null) return again.exact.kind === 'parse-unavailable' ? `${found} (${UNREAD_ADVICE})` : found
  }
  return null
}

export const TREE_REMOVERS = new Set(['rm', 'unlink', 'rmdir', 'rd', 'ri', 'del', 'erase', 'remove-item', 'shred'])
