import { posix } from 'node:path'
import { layersOf } from '../../wards/wardsShellRead.js'
import { credentialStorePath } from './paths.js'
import { OTHER_WRITERS, UNREAD_ADVICE, WRITERS, WRITE_REDIRECT, pathLike, unreadWords, verb, writeOperands } from './words.js'
import { inlineScriptWrites } from './inlineScripts.js'
import { expandShellConstants, walkShellCommands } from './walk.js'
import { GLOB_PART, readForFloors } from './homes.js'
import { foldersAfter } from './folders.js'
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

export async function credentialWriteInBlocks(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  for (const text of new Set([expandShellConstants(command, powershell), command])) {
    const found = await credentialWriteRead(text, powershell, cwd)
    if (found !== null) return found
  }
  return null
}

async function credentialWriteRead(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  const read = await readForFloors(command, powershell, cwd)
  if (read === null) return null
  for (const [at, simple] of read.commands.entries()) {
    const ps = simple.dialect === 'powershell'
    const after = foldersAfter(read, at, cwd)
    const written = simple.redirects.flatMap(redirect => ((ps ? ['>', '>>'] : ['>', '>>', '>|', '&>', '&>>']).includes(redirect.op) ? ['>', '', redirect.target] : []))
    const removes = ps && layersOf(simple.argv).some(layer => TREE_REMOVERS.has(layer.program) && !layer.argv.some(word => /^-whatif$/i.test(word)))
    const listed = removes ? read.commands.filter(earlier => sharesEarlierStage(earlier, simple)).flatMap(earlier => layersOf(earlier.argv).flatMap(layer => (POWERSHELL_LISTERS.has(layer.program) ? powershellListing(layer.argv).roots : []))) : []
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
  return null
}

export async function credentialWriteAfterMove(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  const read = await readForFloors(command, powershell, cwd)
  if (read === null) return null
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
  const words = unreadWords(read, command, powershell)
  if (words.some(word => WRITERS.has(verb(word)) || OTHER_WRITERS.has(verb(word))) || (words.length > 0 && (WRITE_REDIRECT.test(command) || netWrites(command).length > 0))) {
    for (const word of words) if (pathLike(word) && credentialStorePath(word, cwd) !== null) return `${word} (${UNREAD_ADVICE})`
  }
  return null
}

export function credentialWriteWalked(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  return walkShellCommands(command, powershell, ({ argv, cwd, text, powershell: ps }) => {
    if (ps) {
      for (const call of text.matchAll(/(?:^|[;\n])\s*\[(?:System\.)?IO\.(?:File|Directory)\]::(?:WriteAllText|WriteAllBytes|AppendAllText|AppendAllLines|Delete|Move|Copy|Create|OpenWrite)\s*\(\s*(['"])([^'"\r\n]+)\1/gi)) {
        const hit = credentialStorePath(call[2]!, cwd)
        if (hit !== null) return call[2]!
      }
    }
    for (const path of writeOperands(argv, ps)) {
      const hit = credentialStorePath(path, cwd)
      if (hit !== null) return path.includes('/') || path.includes('\\') ? path : hit
    }
    const name = verb(argv[0] ?? '')
    const flag = argv.findIndex((word, i) => i > 0 && /^-(?:e|c|p|command)$/i.test(word))
    if (/^(?:node|bun|python[\d.]*|ruby|perl)$/.test(name) && flag >= 0) {
      const script = argv.slice(flag + 1).join(' ')
      for (const target of inlineScriptWrites(script)) {
        const hit = credentialStorePath(target, cwd)
        if (hit !== null) return target.includes('/') || target.includes('\\') ? target : hit
      }
    }
    return null
  }, cwd)
}

export const TREE_REMOVERS = new Set(['rm', 'unlink', 'rmdir', 'rd', 'ri', 'del', 'erase', 'remove-item', 'shred'])
