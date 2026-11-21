import { posix } from 'node:path'
import { type CommandReading, layersOf } from '../decision/commandAnalysis.js'
import { credentialStorePath } from './paths.js'
import { OTHER_WRITERS, UNREAD_ADVICE, WRITERS, WRITE_REDIRECT, expandedLayerArgvs, pathLike, pipedPrinterOperands, spelledTargetWord, unreadWords, verb, writeOperands, writtenLayerArgv } from './words.js'
import { inlineScriptOf, inlineScriptOfArgv, inlineScriptWrites } from './inlineScripts.js'
import { expandShellConstants, walkShellCommands } from './walk.js'
import { GLOB_PART, floorsWorld, mercuryHomes, readForFloors } from './homes.js'
import { foldersAfter, oldFolderPlaces } from './folders.js'
import { POWERSHELL_LISTERS, powershellListing, sharesEarlierStage } from './listings.js'

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
  const walked = await credentialWriteWalked(command, true, cwd)
  if (walked !== null) return walked
  const read = await readForFloors(command, true, cwd)
  if (read !== null) {
    for (const [at, simple] of read.commands.entries()) {
      const after = foldersAfter(read, at, cwd)
      if (after.lost) continue
      if (simple.cwd !== undefined && !GLOB_PART.test(simple.cwd) && !/^[A-Za-z]:\//.test(simple.cwd) && after.folders.length === 1) continue
      const written = simple.redirects.flatMap(redirect => (['>', '>>', '>|', '&>', '&>>'].includes(redirect.op) ? ['>', '', redirect.target] : []))
      for (const layer of layersOf(simple.argv)) {
        for (const path of writeOperands([...layer.argv, ...written], simple.dialect === 'powershell')) {
          if (/^(?:[/~]|[A-Za-z]:)/.test(path)) continue
          for (const here of after.folders) {
            const full = posix.join(here, path)
            if (credentialStorePath(full, here) !== null) return full
          }
        }
      }
    }
    const words = unreadWords(read, command, true)
    if (words.some(word => WRITERS.has(verb(word)) || OTHER_WRITERS.has(verb(word))) || (words.length > 0 && (WRITE_REDIRECT.test(command) || netWrites(command).length > 0))) {
      for (const word of words) if (pathLike(word) && credentialStorePath(word, cwd) !== null) return `${word} (${UNREAD_ADVICE})`
    }
  }
  for (const text of new Set([expandShellConstants(command, true), command])) {
    const blockRead = text === command ? read : await readForFloors(text, true, cwd)
    if (blockRead === null) continue
    for (const [at, simple] of blockRead.commands.entries()) {
      const ps = simple.dialect === 'powershell'
      const after = foldersAfter(blockRead, at, cwd)
      const written = simple.redirects.flatMap(redirect => ((ps ? ['>', '>>'] : ['>', '>>', '>|', '&>', '&>>']).includes(redirect.op) ? ['>', '', redirect.target] : []))
      const removes = ps && layersOf(simple.argv).some(layer => TREE_REMOVERS.has(layer.program) && !layer.argv.some(word => /^-whatif$/i.test(word)))
      const listed = removes ? blockRead.commands.filter(earlier => sharesEarlierStage(earlier, simple)).flatMap(earlier => layersOf(earlier.argv).flatMap(layer => (POWERSHELL_LISTERS.has(layer.program) ? powershellListing(layer.argv).roots : []))) : []
      for (const path of [...layersOf(simple.argv).flatMap(layer => writeOperands([...layer.argv, ...written], ps)), ...(ps ? netWrites(simple.text) : []), ...listed]) {
        if (/^(?:[/~$%]|[A-Za-z]:)/.test(path)) {
          if (credentialStorePath(path, cwd) !== null) return path
        } else if (!after.lost) {
          for (const here of after.folders) {
            const full = posix.join(here, path)
            if (credentialStorePath(full, here) !== null) return full
          }
        }
      }
    }
  }
  return null
}

function credentialWriteFromRead(read: CommandReading, cwd: string): string | null {
  const anchored = (path: string): boolean => /^(?:[/~$%]|[A-Za-z]:)/.test(path)
  const checkPath = (path: string, after: { folders: string[]; lost: boolean }, argv?: readonly string[], written?: readonly string[]): string | null => {
    if (anchored(path)) {
      if (credentialStorePath(path, cwd) === null) return null
      return argv !== undefined ? spelledTargetWord(path, argv, written, candidate => credentialStorePath(candidate, cwd) !== null) : path
    }
    if (!after.lost) {
      for (const here of after.folders) {
        const full = posix.join(here, path)
        if (credentialStorePath(full, here) !== null) return full
      }
    }
    return null
  }
  for (const [at, simple] of read.commands.entries()) {
    const ps = simple.dialect === 'powershell'
    const after = foldersAfter(read, at, cwd)
    const writtenRedirects = simple.redirects.flatMap(redirect => ((ps ? ['>', '>>'] : ['>', '>>', '>|', '&>', '&>>']).includes(redirect.op) ? ['>', '', redirect.target] : []))
    const layers = layersOf(simple.argv)
    if (writtenRedirects.length > 0 && layers.length === 0) {
      for (const path of writeOperands(writtenRedirects, ps)) {
        const hit = checkPath(path, after)
        if (hit !== null) return hit
      }
    }
    for (const layer of layers) {
      const written = writtenLayerArgv(simple, layer)
      const argvs = expandedLayerArgvs(layer)
      if (layer.wrappers.includes('xargs')) {
        const earlier = read.commands.filter(other => sharesEarlierStage(other, simple))
        const words = pipedPrinterOperands(earlier)
        if (words.length > 0) argvs.push([...layer.argv, ...words])
      }
      for (const argv of argvs) {
        const displayWritten = argv === layer.argv ? written : undefined
        for (const path of writeOperands([...argv, ...writtenRedirects], ps)) {
          const hit = checkPath(path, after, argv, displayWritten)
          if (hit !== null) return hit
        }
      }
      const writtenScript = written !== undefined ? inlineScriptOfArgv(layer.program, written) : null
      const script = inlineScriptOf(layer)
      for (const code of writtenScript !== null && writtenScript !== script ? [writtenScript, script] : [script]) {
        if (code === null) continue
        for (const target of inlineScriptWrites(code)) {
          const hit = checkPath(target, after)
          if (hit !== null) return hit
        }
      }
    }
    const removes = ps && layers.some(layer => TREE_REMOVERS.has(layer.program) && !layer.argv.some(word => /^-whatif$/i.test(word)))
    const listed = removes ? read.commands.filter(earlier => sharesEarlierStage(earlier, simple)).flatMap(earlier => layersOf(earlier.argv).flatMap(layer => (POWERSHELL_LISTERS.has(layer.program) ? powershellListing(layer.argv).roots : []))) : []
    for (const path of [...(ps ? netWrites(simple.text) : []), ...listed]) {
      const hit = checkPath(path, after)
      if (hit !== null) return hit
    }
  }
  if (read.exact.kind === 'simple') {
    for (const simple of read.exact.commands) {
      const writtenRedirects = simple.redirects.flatMap(redirect => (['>', '>>', '>|', '&>', '&>>'].includes(redirect.op) ? ['>', '', redirect.target] : []))
      for (const layer of layersOf(simple.argv)) {
        for (const path of writeOperands([...layer.argv, ...writtenRedirects], false)) {
          const hit = credentialStorePath(path, cwd)
          if (hit !== null) return path.includes('/') || path.includes('\\') ? path : hit
        }
      }
    }
  }
  return null
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
