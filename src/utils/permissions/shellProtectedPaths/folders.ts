import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import { getMercuryHome } from '../../envUtils.js'
import { type ShellRead, UNREAD_PART, absolutePath, moveOf, printedBy, wordKnown } from '../../wards/wardsShellRead.js'
import { placedUnder } from '../runtimeProtection.js'
import { expandPath } from '../../path.js'
import { credentialStorePath, protectedPathForms, spelling } from './paths.js'
import { CONVENTIONAL_USER_HOME, GLOB_PART, floorsWorld, globPartSource, mercuryHomes, wildcardSource } from './homes.js'
import { passedOver } from '../../passedOver.js'
import { hostEnv } from '../../hostEnv.js'

const CD_PROGRAMS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'])
const FOLDER_CAP = 16
const ON_CONVENTIONAL_WAY = new RegExp(`^(?:\\/(?:users|home)|[a-z]:\\/users|${CONVENTIONAL_USER_HOME}(?:\\/\\.mercury(?:\\/.*)?)?)$`)
const namedFolders = new Map<string, { at: number; folders: string[] }>()

function onGuardedWay(folder: string, mercury: readonly string[], home: readonly string[]): boolean {
  const lower = folder.normalize('NFC').toLowerCase()
  if (ON_CONVENTIONAL_WAY.test(lower)) return true
  if (mercury.some(way => way === lower || way.startsWith(`${lower}/`) || lower.startsWith(`${way}/`))) return true
  if (home.some(way => way === lower || way.startsWith(`${lower}/`))) return true
  return (home.some(way => lower.startsWith(`${way}/`)) || /^\/(?:private\/)?(?:etc|library)(?:\/|$)/.test(lower)) && credentialStorePath(folder, '/') !== null
}

function foldersNamedBy(pattern: string): string[] {
  const known = namedFolders.get(pattern)
  if (known !== undefined && Date.now() - known.at < 2000) return known.folders
  const folders = foldersOnDisk(pattern)
  if (namedFolders.size >= 32) namedFolders.clear()
  namedFolders.set(pattern, { at: Date.now(), folders })
  return folders
}

function foldersOnDisk(pattern: string): string[] {
  let mercury: string[] | undefined
  let home: string[] = []
  const parts = spelling(pattern).split(/[\\/]/).filter(part => part !== '')
  let found = [/^[a-z]:$/i.test(parts[0] ?? '') ? `${parts.shift()}/` : '/']
  for (const part of parts) {
    const next: string[] = []
    for (const folder of found) {
      if (!GLOB_PART.test(part)) {
        next.push(posix.join(folder, part))
        continue
      }
      let test: RegExp
      try {
        test = new RegExp(`^${wildcardSource(part)}$`)
      } catch {
        test = new RegExp(`^${globPartSource(part)}$`)
      }
      if (test.test('')) next.push(folder)
      let names: string[] = []
      try {
        names = readdirSync(folder)
      } catch (error) {
        passedOver(error)
      }
      const dotLed = part.startsWith('.') || /^\{(?:[^}]*,)?\./.test(part)
      const named = names.filter(name => test.test(name) && (dotLed || !name.startsWith('.')))
      next.push(...(named.length > 0 ? named : [part]).map(name => posix.join(folder, name)))
    }
    if (next.length > FOLDER_CAP) {
      if (mercury === undefined) {
        mercury = [...mercuryHomes(), ...protectedPathForms(flagEnv('MERCURY_DAEMON_DIR') || getMercuryHome())]
        home = [hostEnv().HOME, hostEnv().USERPROFILE, homedir()].filter((path): path is string => !!path).flatMap(path => protectedPathForms(path))
      }
      const ways = mercury
      const guarded = next.filter(folder => onGuardedWay(folder, ways, home))
      found = [...guarded, ...next.filter(folder => !guarded.includes(folder)).slice(0, FOLDER_CAP)]
    } else found = next
    if (found.length === 0) return []
  }
  return found.filter(canBeEntered)
}

function canBeEntered(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isDirectory()
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function foldersAfter(read: ShellRead, at: number, cwd: string): { folders: string[]; lost: boolean } {
  const reached = foldersRead(read, at, cwd)
  const simple = read.commands[at]
  const stands = simple?.cwd
  if (simple === undefined || stands === undefined) return reached
  const stayed: string[] = []
  for (let index = at - 1; index >= 0; index--) {
    const turn = read.commands[index]!
    const move = moveOf(turn)
    if (move === undefined || !CD_PROGRAMS.has(move.program) || turn.cwd === undefined) continue
    const operands = move.operands
    const switched = process.platform === 'win32' && operands.length === 2 && /^\/d$/i.test(operands[0]!)
    const target = switched ? operands[1] : operands[0]
    const bare = target === undefined && turn.dialect === 'powershell' && move.program !== 'pushd' && move.program !== 'push-location' ? (read.homes.at(-1) ?? floorsWorld(turn.cwd).home) : undefined
    if (bare === undefined && (target === undefined || target === '-' || !wordKnown(target))) continue
    const named = bare ?? absolutePath(turn.dialect === 'powershell' ? target!.replace(/\\/g, '/') : target!, turn.cwd, floorsWorld(turn.cwd))
    if (named === undefined || (stands !== named && !stands.startsWith(`${named}/`))) continue
    const gated = (simple.gates ?? []).some(([from, to]) => index >= from && index < to)
    const ran =
      !turn.background &&
      (turn.maybes ?? []).every(context => (simple.maybes ?? []).includes(context)) &&
      (turn.gates ?? []).every(([from, to]) => (simple.gates ?? []).some(([start, end]) => (start === from && end === to) || (index >= start && index < end)))
    const moved = bare === undefined && (gated || ((operands.length === 1 || switched) && (GLOB_PART.test(named) ? foldersNamedBy(named).length > 0 : canBeEntered(named))))
    if (ran && moved) continue
    stayed.push(posix.join(turn.cwd, stands.slice(named.length)), turn.cwd)
  }
  return stayed.length === 0 ? reached : { folders: [...new Set([...reached.folders, ...stayed])], lost: reached.lost }
}

export function foldersRead(read: ShellRead, at: number, cwd: string): { folders: string[]; lost: boolean } {
  const simple = read.commands[at]
  if (simple === undefined) return { folders: [cwd], lost: false }
  if (simple.cwd !== undefined) {
    if (!GLOB_PART.test(simple.cwd)) return { folders: [simple.cwd], lost: false }
    return { folders: [...foldersNamedBy(simple.cwd), simple.cwd], lost: false }
  }
  for (let index = at - 1; index >= 0; index--) {
    const turn = read.commands[index]!
    const move = moveOf(turn)
    if (move === undefined || !CD_PROGRAMS.has(move.program)) continue
    const before = turn.cwd ?? cwd
    let target = move.operands[0]
    if (target === UNREAD_PART) {
      const fed = turn.inner.flat()
      const printed = fed.length === 1 && read.commands[fed[0]!] !== undefined ? printedBy(read.commands[fed[0]!]!) : undefined
      if (printed !== undefined && printed.trim() !== '') target = printed.trim()
    }
    if (target === undefined || target === '-' || target.includes(UNREAD_PART) || /[$`\s]/.test(spelling(target))) return { folders: [before], lost: true }
    const pattern = /^[A-Za-z]:\//.test(spelling(target)) ? spelling(target) : placedUnder(target, before) !== target ? placedUnder(target, before) : expandPath(spelling(target), before)
    const named = GLOB_PART.test(pattern) ? foldersNamedBy(pattern) : canBeEntered(pattern) ? [pattern] : []
    const gated = (simple.gates ?? []).some(([from, to]) => index >= from && index < to)
    return { folders: [...named, ...(named.includes(pattern) ? [] : [pattern]), ...(named.length > 0 || gated ? [] : [before])], lost: false }
  }
  return { folders: [cwd], lost: true }
}
