import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { getMercuryHome } from '../../../platform/environment/envUtils.js'
import { type ReadCommand, type ShellRead, UNREAD_PART, absolutePath, layersOf, moveOf, oldFolderReturn, printedBy, wordKnown, wordsAsWritten } from '../decision/commandAnalysis.js'
import { placedUnder } from '../runtimeProtection.js'
import { expandPath, hasNulByte } from '../../../platform/files/path.js'
import { credentialStorePath, protectedPathForms, spelling } from './paths.js'
import { CONVENTIONAL_USER_HOME, GLOB_PART, floorsWorld, globNotCompiled, mercuryHomes, wildcardSource } from './homes.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'
import { isCmdDriveSwitchCd } from '../../../platform/host-os/commandForms.js'

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
      } catch (error) {
        globNotCompiled(part, error)
        continue
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
    const switched = isCmdDriveSwitchCd(operands)
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
  const called = new Set<string>()
  for (let index = 0; index < at; index++) {
    const turn = read.commands[index]!
    if (turn.body === undefined && turn.argv[0] !== undefined) called.add(turn.argv[0])
  }
  if (called.size > 0) {
    for (let index = 0; index < at; index++) {
      const turn = read.commands[index]!
      if (turn.body === undefined || !called.has(turn.body) || turn.cwd === undefined) continue
      const move = moveOf(turn)
      if (move === undefined || !CD_PROGRAMS.has(move.program)) continue
      const target = move.operands[0]
      if (target === undefined || target === '-' || !wordKnown(target)) continue
      const named = absolutePath(target, turn.cwd, floorsWorld(turn.cwd))
      if (named !== undefined) stayed.push(named)
    }
  }
  return stayed.length === 0 ? reached : { folders: [...new Set([...reached.folders, ...stayed])], lost: reached.lost }
}

export function foldersRead(read: ShellRead, at: number, cwd: string): { folders: string[]; lost: boolean } {
  const simple = read.commands[at]
  if (simple === undefined) return { folders: [cwd], lost: false }
  if (simple.cwd !== undefined) {
    const envAt = simple.cwd.search(/%(?:USERPROFILE|HOME|MERCURY_CONFIG_DIR)%|\$env:(?:USERPROFILE|MERCURY_CONFIG_DIR)/i)
    const standing = envAt >= 0 ? spelling(simple.cwd.slice(envAt)) : simple.cwd
    if (!GLOB_PART.test(standing)) return { folders: [standing], lost: false }
    return { folders: [...foldersNamedBy(standing), standing], lost: false }
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

const UNCERTAIN_PLACE_WORDS = /\b(?:OLDPWD|DIRSTACK|CDPATH|trap)\b/
const UNCERTAIN_SYNTAX = /(?:^|[\s;|&{(])(?:function|export|declare|typeset|local|readonly|unset)(?=$|[ \t\r\n])|(?:^|[\s;|&(])(?:HOME|PWD)\+?=|[A-Za-z_][\w.-]*\s*\(\s*\)|\$\{[^}]*:?=/
const UNCERTAIN_MOVE_WORD = /[`$*?[\]{}\\<>()!'"]/
const PLAIN_SEP = /^[ \t]*(?:;|\r?\n)[ \t]*/
const AFTER_RETURN = /^[ \t]*(?:$|;(?!;)|\r?\n|&&(?!&))/
const SHELL_BUILTINS = new Set([
  '.', 'alias', 'autoload', 'bg', 'bind', 'bindkey', 'break', 'builtin',
  'caller', 'cd', 'chdir', 'command', 'compgen', 'complete', 'compopt',
  'continue', 'coproc', 'declare', 'dirs', 'disable', 'disown', 'emulate',
  'enable', 'eval', 'exec', 'exit', 'export', 'fc', 'fg', 'float', 'functions',
  'getopts', 'hash', 'help', 'history', 'integer', 'jobs', 'kill', 'let',
  'local', 'logout', 'mapfile', 'noglob', 'popd', 'print', 'pushd',
  'read', 'readarray', 'readonly', 'rehash', 'return', 'set', 'setopt',
  'shift', 'shopt', 'source', 'suspend', 'times', 'trap', 'type',
  'typeset', 'ulimit', 'umask', 'unalias', 'unfunction', 'unhash',
  'unset', 'unsetopt', 'wait', 'whence', 'zmodload',
])

type MoveKind = 'cd-entry' | 'cd-return' | 'pushd-entry' | 'popd-return'

function printfAssigns(argv: readonly string[]): boolean {
  for (const word of argv.slice(1)) {
    if (word === '--') return false
    if (word === '-v' || /^-[A-Za-z]*v/.test(word)) return true
  }
  return false
}

function plainLiteralOperand(arg: string): boolean {
  if (arg === '' || UNCERTAIN_MOVE_WORD.test(arg)) return false
  if (arg.startsWith('~') && arg !== '~' && !arg.startsWith('~/')) return false
  return true
}

function plainMoveKind(turn: ReadCommand): MoveKind | undefined | null {
  const move = moveOf(turn)
  if (move === undefined) return undefined
  if ((turn.gates?.length ?? 0) > 0 || (turn.maybes?.length ?? 0) > 0 || turn.background || turn.stages.length > 0 || turn.substituted === true) return null
  if (turn.redirects.length > 0 || turn.env.length > 0) return null
  const raw = wordsAsWritten(turn)
  if (raw === undefined || raw.length !== turn.argv.length) return null
  const layer = layersOf(turn.argv).find(found => found.program === move.program)
  if (layer === undefined || layer.wrappers.length > 0 || layer.argv.length !== turn.argv.length) return null
  const written = raw[0]!
  if (written === 'cd') {
    if (raw.length !== 2) return null
    const arg = raw[1]!
    if (arg === '-') return 'cd-return'
    if (arg.startsWith('-') || !plainLiteralOperand(arg)) return null
    return 'cd-entry'
  }
  if (written === 'pushd') {
    if (raw.length !== 2) return null
    const arg = raw[1]!
    if (arg.startsWith('-') || arg.startsWith('+') || !plainLiteralOperand(arg)) return null
    return 'pushd-entry'
  }
  if (written === 'popd') return raw.length === 1 ? 'popd-return' : null
  return null
}

function startsWithReturnPair(text: string, prevText: string, turnText: string): boolean {
  const start = text.length - text.trimStart().length
  if (!text.startsWith(prevText, start)) return false
  const afterPrev = start + prevText.length
  const sep = PLAIN_SEP.exec(text.slice(afterPrev))
  if (sep === null) return false
  const turnAt = afterPrev + sep[0].length
  const afterTurn = turnAt + turnText.length
  return text.startsWith(turnText, turnAt) && AFTER_RETURN.test(text.slice(afterTurn))
}

export function placesCertain(read: ShellRead, text: string): boolean {
  if (UNCERTAIN_PLACE_WORDS.test(text) || UNCERTAIN_SYNTAX.test(text)) return false
  if (read.exported.size > 0) return false
  let prevKind: MoveKind | undefined
  let prevText = ''
  for (let at = 0; at < read.commands.length; at++) {
    const turn = read.commands[at]!
    if (turn.body !== undefined) return false
    const kind = plainMoveKind(turn)
    if (kind === null) return false
    if (kind !== undefined) {
      if (kind === 'cd-return' || kind === 'popd-return') {
        const expected: MoveKind = kind === 'cd-return' ? 'cd-entry' : 'pushd-entry'
        if (at !== 1 || prevKind !== expected || !startsWithReturnPair(text, prevText, turn.text)) return false
        prevKind = undefined
        prevText = ''
      } else {
        prevKind = kind
        prevText = turn.text
      }
      continue
    }
    prevKind = undefined
    prevText = ''
    if (turn.argv.length === 0) continue
    const head = turn.argv[0]!
    if (!wordKnown(head) || head.startsWith('$')) return false
    for (const layer of layersOf(turn.argv)) {
      if (SHELL_BUILTINS.has(layer.program)) return false
      if (layer.program === 'printf' && printfAssigns(layer.argv)) return false
    }
  }
  return true
}

export function oldFolderPlaces(
  read: ShellRead,
  text: string,
  cwd: string | null,
  home: () => string | undefined,
  extra?: () => readonly string[],
): string[] {
  const ret = oldFolderReturn(read.commands, text)
  if (ret === undefined) return []
  const out: string[] = []
  const add = (folder: string | undefined | null): void => {
    if (folder === undefined || folder === null || folder === '' || out.includes(folder)) return
    out.push(folder)
  }
  add(cwd)
  if (ret.written !== undefined) {
    const resolvedHome = home()
    add(resolvedHome)
    if (extra !== undefined) for (const folder of extra()) add(folder)
    for (const word of ret.written) {
      if (word === '' || word.includes(UNREAD_PART) || hasNulByte(word)) continue
      add(expandPath(spelling(word), cwd ?? resolvedHome ?? '/'))
    }
  }
  for (const one of read.commands) add(one.cwd)
  return out.slice(0, 8)
}
