import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { getMercuryHome } from '../environment/envUtils.js'
import { errorMessage, isENOENT } from '../errors/errors.js'
import { passedOver } from '../errors/passedOver.js'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { flagPair } from '../substrate/flagRegistry.js'
import { resolveLayoutRoots, shimStatus } from '../update-channel/installLayout.js'
import { resolveInstallProvenance } from '../update-channel/installProvenance.js'

export type ProfileRow = { id: number; name: string; home: string; command: string | null; current: boolean }
export type ProfileRefusal = { ok: false; reason: string }

const RECORD = 'profiles.json'
const MARKER = 'profile.json'
const NOT_INSTALLED = 'Profiles need Mercury started through its installed `mercury` command (a release install or a source deploy), and this session was not: start it that way, then try again.'

const recordShape = () => z.object({ profiles: z.array(z.object({ id: z.number().int().min(1), name: z.string().optional() })) })
const markerShape = () => z.object({ first: z.string().min(1), id: z.number().int().min(2) })

type Labels = z.infer<ReturnType<typeof recordShape>>['profiles']
type Family = { first: string; currentId: number; labels: Labels }
type Install = { bin: string; command: string; program: Record<string, string>; isWindows: boolean }
type CommandFile = { path: string; text: string }

const refused = (reason: string): ProfileRefusal => ({ ok: false, reason })
const notDone = (did: string, again: string) => (error: unknown): ProfileRefusal => refused(`The profile was not ${did} (${errorMessage(error)}): mend that, then ${again} it again.`)
const homeOf = (first: string, id: number): string => (id === 1 ? first : `${first}${id}`)
const wordOf = (id: number): string => (id === 1 ? 'mercury' : `mercury${id}`)

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

export function programHome(): string {
  const home = getMercuryHome()
  try {
    return stored(join(home, MARKER), markerShape)?.first ?? home
  } catch (error) {
    passedOver(error)
    return home
  }
}

function family(): Family {
  const home = getMercuryHome()
  const marker = stored(join(home, MARKER), markerShape)
  const first = marker?.first ?? home
  return { first, currentId: marker?.id ?? 1, labels: stored(join(first, RECORD), recordShape)?.profiles ?? [] }
}

function save(first: string, labels: Labels): void {
  const path = join(first, RECORD)
  if (labels.length === 0) rmSync(path, { force: true })
  else durableAtomicPublishSync(path, `${JSON.stringify({ profiles: [...labels].sort((a, b) => a.id - b.id) }, null, 2)}\n`, { mode: 0o600 })
}

function install(first: string): Install | null {
  const bundle = process.argv[1]
  if (bundle === undefined) return null
  const bin = join(first, 'bin')
  const launcher = join(bin, 'mercury')
  if (['current', 'dist'].some(name => bundle === join(first, 'runtime', name, 'mercury.mjs')) && existsSync(launcher)) {
    return { bin, command: launcher, program: { MERCURY_DIST: bundle }, isWindows: false }
  }
  const roots = resolveLayoutRoots()
  if (resolveInstallProvenance().kind !== 'managed' || shimStatus(roots) !== 'managed') return null
  return { bin: roots.binDir, command: roots.shimPath, program: flagPair('MERCURY_VERSIONS_DIR', roots.versionsDir), isWindows: roots.isWindows }
}

function commandFiles(found: Install, id: number, home: string): CommandFile[] {
  const env = Object.entries({ ...flagPair('MERCURY_CONFIG_DIR', home), ...found.program })
  const word = join(found.bin, wordOf(id))
  const sh = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
  const assigned = env.map(([name, value]) => `${name}=${sh(value)}`).join(' ')
  if (!found.isWindows) return [{ path: word, text: `#!/bin/sh\n${assigned} exec ${sh(found.command)} "$@"\n` }]
  const ps = (value: string): string => `'${value.replace(/'/g, "''")}'`
  const own = `${homedir()}\\`
  const batch = (value: string): string => (value.startsWith(own) ? `%USERPROFILE%\\${value.slice(own.length).replace(/%/g, '%%')}` : value.replace(/%/g, '%%'))
  const entry = '& (Join-Path $PSScriptRoot \'mercury.ps1\') @args'
  return [
    { path: `${word}.cmd`, text: ['@echo off', 'setlocal', ...env.map(([name, value]) => `set "${name}=${batch(value)}"`), '"%~dp0mercury.cmd" %*', ''].join('\r\n') },
    { path: word, text: `#!/bin/sh\n${assigned} exec "$(dirname "$0")/mercury" "$@"\n` },
    {
      path: `${word}.ps1`,
      text: `\uFEFF${[
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
  return {
    id,
    name: known.labels.find(row => row.id === id)?.name ?? `Profile ${id}`,
    home: homeOf(known.first, id),
    command: stands ? wordOf(id) : null,
    current: id === known.currentId,
  }
}

export function listProfiles(): ProfileRow[] {
  let known: Family
  try {
    known = family()
  } catch (error) {
    passedOver(error)
    known = { first: getMercuryHome(), currentId: 1, labels: [] }
  }
  const found = install(known.first)
  const ids = new Set([1, known.currentId, ...known.labels.map(row => row.id)])
  return [...ids].sort((a, b) => a - b).map(id => rowOf(known, found, id))
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
    const taken = files.find(file => ![undefined, file.text].includes(textAt(file.path)))
    if (taken !== undefined) return refused(`The file ${taken.path} is already there and is not this profile's command: move it away, then create the profile again.`)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    durableAtomicPublishSync(join(home, MARKER), `${JSON.stringify({ first: known.first, id })}\n`, { mode: 0o600 })
    for (const file of files) durableAtomicPublishSync(file.path, file.text, { mode: 0o755 })
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
    const listed = known.labels.some(row => row.id === id)
    if (id !== 1 && id !== known.currentId && !listed) return refused(`There is no profile ${id}: pick one from the list.`)
    const label = name.replace(/\s+/g, ' ').trim()
    const plain = label === '' || label === `Profile ${id}`
    const row = plain ? (id === 1 ? [] : [{ id }]) : [{ id, name: label }]
    save(known.first, [...known.labels.filter(kept => kept.id !== id), ...row])
    return { ok: true }
  } catch (error) {
    return notDone('renamed', 'rename')(error)
  }
}

export function removeProfile(id: number): { ok: true; keptHome: string } | ProfileRefusal {
  try {
    const known = family()
    if (id === 1) return refused('Profile 1 is the home Mercury starts in by default and is never removed: remove a profile numbered 2 or above.')
    if (id === known.currentId) return refused(`This session runs in profile ${id}: start Mercury with \`mercury\` and remove it from there.`)
    if (!known.labels.some(row => row.id === id)) return refused(`There is no profile ${id}: pick one from the list.`)
    const found = install(known.first)
    if (found === null) return refused(NOT_INSTALLED)
    const home = homeOf(known.first, id)
    for (const file of commandFiles(found, id, home)) if (textAt(file.path) === file.text) rmSync(file.path)
    save(known.first, known.labels.filter(row => row.id !== id))
    return { ok: true, keptHome: home }
  } catch (error) {
    return notDone('removed', 'remove')(error)
  }
}
