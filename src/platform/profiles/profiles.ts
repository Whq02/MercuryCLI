import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'
import { getMercuryHome } from '../environment/envUtils.js'
import { errorMessage, isENOENT } from '../errors/errors.js'
import { passedOver } from '../errors/passedOver.js'
import { foldPathCase, pathModuleFor, stripExtendedLengthPrefixForPlatform, toNativeSeparators } from '../host-os/paths.js'
import { envPathDirs } from '../host-os/programs.js'
import { logError } from '../logs/errorLog.js'
import { publishAtomicSync } from '../substrate/fileStore.js'
import { flagPair } from '../substrate/flagRegistry.js'
import { pathEntryEquals, readCurrentVersion, reconcileManagedShims, resolveLayoutRoots, runningPayloadDir, shimStatus, type LayoutRoots, type ShimSetOutcome } from '../update-channel/installLayout.js'
import { resolveInstallProvenance } from '../update-channel/installProvenance.js'
import { realpathSafe } from '../update-channel/provenanceNotice.js'

export type ProfileRow = { id: number; name: string; home: string; command: string | null; offPath?: string; current: boolean }
type ProfileRefusal = { ok: false; reason: string }

const RECORD = 'profiles.json'
const HOME_MARKER = 'profile.json'
const COMMAND_MARKER = 'mercury-managed-profile'
const NOT_INSTALLED = 'Profiles need Mercury started through its installed `mercury` command, and this session was not: start it that way, then try again.'

const recordShape = () => z.object({ profiles: z.array(z.object({ id: z.number().int().min(1), name: z.string().optional() })) })
const markerShape = () => z.object({ first: z.string().min(1), id: z.number().int().min(2) })

type Labels = z.infer<ReturnType<typeof recordShape>>['profiles']
type Family = { first: string; currentId: number; labels: Labels }
type Install = { bin: string; command: string; program: Record<string, string>; isWindows: boolean; userHome: string }
type CommandFile = { path: string; text: string }

const refused = (reason: string): ProfileRefusal => ({ ok: false, reason })
const notDone = (did: string, again: string) => (error: unknown): ProfileRefusal => refused(`The profile was not ${did} (${errorMessage(error)}): mend that, then ${again} it again.`)
const homeOf = (first: string, id: number): string => (id === 1 ? first : `${first}${id}`)
const wordOf = (id: number): string => (id === 1 ? 'mercury' : `mercury${id}`)
const carries = (text: string | undefined, id: number): boolean => text !== undefined && text.split(/\r?\n/).some(line => line.endsWith(`${COMMAND_MARKER} ${id}`))
const strange = (file: CommandFile, id: number): boolean => existsSync(file.path) && !carries(textAt(file.path), id)

function textAt(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return undefined
    throw error
  }
}

function stored<T>(path: string, shape: () => z.ZodType<T>): T | undefined {
  const text = textAt(path)
  if (text === undefined) return undefined
  try {
    return shape().parse(JSON.parse(text))
  } catch (error) {
    throw new Error(`${path} does not read as Mercury wrote it`, { cause: error })
  }
}

export function firstProfileHome(): string {
  const home = getMercuryHome()
  try {
    return stored(join(home, HOME_MARKER), markerShape)?.first ?? home
  } catch (error) {
    passedOver(error)
    return home
  }
}

function family(): Family {
  const home = getMercuryHome()
  const marker = stored(join(home, HOME_MARKER), markerShape)
  const first = marker?.first ?? home
  return { first, currentId: marker?.id ?? 1, labels: stored(join(first, RECORD), recordShape)?.profiles ?? [] }
}

function save(first: string, labels: Labels): void {
  const path = join(first, RECORD)
  if (labels.length === 0) rmSync(path, { force: true })
  else publishAtomicSync(path, `${JSON.stringify({ profiles: [...labels].sort((a, b) => a.id - b.id) }, null, 2)}\n`, { mode: 0o600 })
}

const released = (roots: LayoutRoots): Install => ({ bin: roots.binDir, command: roots.shimPath, program: flagPair('MERCURY_VERSIONS_DIR', roots.versionsDir), isWindows: roots.isWindows, userHome: homedir() })

function install(first: string): Install | null {
  const bundle = process.argv[1]
  if (bundle === undefined) return null
  const bin = join(first, 'bin')
  const launcher = join(bin, 'mercury')
  const pointers = ['current', 'dist'].map(name => resolve(first, 'runtime', name, 'mercury.mjs'))
  const program = pointers.find(pointer => existsSync(pointer))
  if (program !== undefined && pointers.includes(resolve(bundle)) && existsSync(launcher)) {
    return { bin, command: launcher, program: { MERCURY_DIST: program }, isWindows: false, userHome: homedir() }
  }
  const roots = resolveLayoutRoots()
  return resolveInstallProvenance().kind === 'managed' && shimStatus(roots) === 'managed' ? released(roots) : null
}

export function commandFiles(found: Install, id: number, home: string): CommandFile[] {
  const env = Object.entries({ ...flagPair('MERCURY_CONFIG_DIR', home), ...found.program })
  const pathMod = found.isWindows && (found.bin.includes('\\') || /^[A-Za-z]:/.test(found.bin))
    ? pathModuleFor('win32')
    : pathModuleFor(process.platform === 'win32' ? 'win32' : 'linux')
  const word = pathMod.join(found.bin, wordOf(id))
  const mark = `${COMMAND_MARKER} ${id}`
  const sh = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
  const assigned = env.map(([name, value]) => `${name}=${sh(value)}`).join(' ')
  if (!found.isWindows) return [{ path: word, text: `#!/bin/sh\n# ${mark}\n${assigned} exec ${sh(found.command)} "$@"\n` }]
  const ps = (value: string): string => `'${value.replace(/'/g, "''")}'`
  const own = `${toNativeSeparators(found.userHome, 'win32').replace(/\\+$/, '')}\\`
  const batch = (value: string): string => {
    const spelt = toNativeSeparators(value, 'win32')
    return foldPathCase(spelt, 'win32').startsWith(foldPathCase(own, 'win32')) ? `%USERPROFILE%\\${spelt.slice(own.length).replace(/%/g, '%%')}` : value.replace(/%/g, '%%')
  }
  const entry = '& (Join-Path $PSScriptRoot \'mercury.ps1\') @args'
  const sets = env.map(([name, value]) => `set "${name}=${batch(value)}"`)
  return [
    { path: `${word}.cmd`, text: ['@echo off', `rem ${mark}`, ...(sets.some(line => /[^\x00-\x7f]/.test(line)) ? ['chcp 65001 >nul 2>nul'] : []), 'setlocal DisableDelayedExpansion', ...sets, '"%~dp0mercury.cmd" %*', ''].join('\r\n') },
    { path: word, text: `#!/bin/sh\n# ${mark}\n${assigned} exec "$(dirname "$0")/mercury" "$@"\n` },
    {
      path: `${word}.ps1`,
      text: `\uFEFF${[
        `# ${mark}`,
        ...env.map(([name]) => `$kept_${name} = $env:${name}`),
        ...env.map(([name, value]) => `$env:${name} = ${ps(value)}`),
        `try { if ($MyInvocation.ExpectingInput) { $input | ${entry} } else { ${entry} } }`,
        `finally { ${env.map(([name]) => `$env:${name} = $kept_${name}`).join('; ')} }`,
        'exit $LASTEXITCODE',
        '',
      ].join('\r\n')}`,
    },
  ]
}

function rowOf(known: Family, found: Install | null, id: number): ProfileRow {
  const stands = found !== null && existsSync(join(found.bin, `${wordOf(id)}${found.isWindows ? '.cmd' : ''}`))
  const off = stands && id !== 1 && !envPathDirs().some(entry => pathEntryEquals(entry, found.bin, found.isWindows))
  return {
    id,
    name: known.labels.find(row => row.id === id)?.name ?? `Profile ${id}`,
    home: homeOf(known.first, id),
    command: stands ? wordOf(id) : null,
    ...(off ? { offPath: join(found.bin, wordOf(id)) } : {}),
    current: id === known.currentId,
  }
}

export function listProfiles(): { ok: true; profiles: ProfileRow[] } | ProfileRefusal {
  try {
    const known = family()
    const found = install(known.first)
    const ids = new Set([1, known.currentId, ...known.labels.map(row => row.id)])
    return { ok: true, profiles: [...ids].sort((a, b) => a - b).map(id => rowOf(known, found, id)) }
  } catch (error) {
    return refused(`The profile list could not be read (${errorMessage(error)}): mend that file or move it away, then try again.`)
  }
}

export function profileCommands(roots: LayoutRoots, profiles: readonly ProfileRow[]): string[] {
  return profiles
    .filter(row => row.id !== 1)
    .flatMap(row => commandFiles(released(roots), row.id, row.home).filter(file => carries(textAt(file.path), row.id)))
    .map(file => file.path)
}

function sameDirectory(left: string, right: string, isWindows: boolean): boolean {
  const clean = (dir: string): string => {
    const resolved = stripExtendedLengthPrefixForPlatform(realpathSafe(dir), isWindows ? 'win32' : 'linux')
    const trimmed = resolved.replace(isWindows ? /[\\/]+$/ : /\/+$/, '')
    return foldPathCase(trimmed === '' ? resolved : trimmed, isWindows ? 'win32' : 'linux')
  }
  return clean(left) === clean(right)
}

function refreshManagedProfileCommands(roots: LayoutRoots): void {
  try {
    const current = readCurrentVersion(roots)
    if (current === null || shimStatus(roots) !== 'managed') return
    if (!sameDirectory(runningPayloadDir(), join(roots.versionsDir, current), roots.isWindows)) return
    const known = family()
    const ids = [...new Set(known.labels.map(row => row.id))].filter(id => id > 1).sort((a, b) => a - b)
    if (ids.length === 0) return
    const found = released(roots)
    for (const id of ids) {
      for (const file of commandFiles(found, id, homeOf(known.first, id))) {
        try {
          if (!existsSync(file.path) || lstatSync(file.path).isSymbolicLink()) continue
          const existing = textAt(file.path)
          if (existing === undefined || existing === file.text || !carries(existing, id)) continue
          publishAtomicSync(file.path, file.text, { mode: 0o755, parent: 'must-stand', platform: found.isWindows ? 'win32' : process.platform })
        } catch (error) {
          logError(new Error(`profile ${id} command at ${file.path} could not be refreshed (${errorMessage(error)}); the existing file stays as it was`))
        }
      }
    }
  } catch (error) {
    logError(new Error(`profile commands in ${roots.binDir} could not be checked (${errorMessage(error)}); they stay as they were`))
  }
}

export function reconcileManagedCommands(roots: LayoutRoots = resolveLayoutRoots()): ShimSetOutcome | null {
  const shims = reconcileManagedShims(roots)
  if (shims !== null) refreshManagedProfileCommands(roots)
  return shims
}

export function createProfile(): { ok: true; profile: ProfileRow } | ProfileRefusal {
  try {
    const known = family()
    const found = install(known.first)
    if (found === null) return refused(NOT_INSTALLED)
    let id = 2
    while (known.labels.some(row => row.id === id)) id++
    const home = homeOf(known.first, id)
    const files = commandFiles(found, id, home)
    const stranger = files.find(file => strange(file, id))
    if (stranger !== undefined) return refused(`The file ${stranger.path} is already there and is not this profile's command: move it away, then create the profile again.`)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    publishAtomicSync(join(home, HOME_MARKER), `${JSON.stringify({ first: known.first, id })}\n`, { mode: 0o600 })
    for (const file of files) publishAtomicSync(file.path, file.text, { mode: 0o755 })
    const labels = [...known.labels, { id }]
    save(known.first, labels)
    return { ok: true, profile: rowOf({ ...known, labels }, found, id) }
  } catch (error) {
    return notDone('created', 'create')(error)
  }
}

export function renameProfile(id: number, name: string): { ok: true } | ProfileRefusal {
  try {
    const known = family()
    if (id !== 1 && !known.labels.some(row => row.id === id)) return refused(`Profile ${id} has no row in the list: create a profile to bring it back, then rename it.`)
    const label = name.replace(/\s+/g, ' ').trim()
    const plain = label === '' || label === `Profile ${id}`
    const row = plain ? (id === 1 ? [] : [{ id }]) : [{ id, name: label }]
    save(known.first, [...known.labels.filter(kept => kept.id !== id), ...row])
    return { ok: true }
  } catch (error) {
    return notDone('renamed', 'rename')(error)
  }
}

export function removeProfile(id: number): { ok: true; keptHome: string; keptFiles?: string[] } | ProfileRefusal {
  try {
    const known = family()
    if (id === 1) return refused('Profile 1 is the home Mercury starts in by default and is never removed: remove a profile numbered 2 or above.')
    if (id === known.currentId) return refused(`This session runs in profile ${id}: start Mercury with \`mercury\` and remove it from there.`)
    if (!known.labels.some(row => row.id === id)) return refused(`There is no profile ${id}: pick one from the list.`)
    const found = install(known.first)
    if (found === null) return refused(NOT_INSTALLED)
    const home = homeOf(known.first, id)
    const files = commandFiles(found, id, home)
    const keptFiles = files.filter(file => strange(file, id)).map(file => file.path)
    for (const file of files) if (carries(textAt(file.path), id)) rmSync(file.path)
    save(known.first, known.labels.filter(row => row.id !== id))
    return { ok: true, keptHome: home, ...(keptFiles.length > 0 ? { keptFiles } : {}) }
  } catch (error) {
    return notDone('removed', 'remove')(error)
  }
}
