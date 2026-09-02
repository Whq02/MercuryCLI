import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { lazySchema } from '../utils/lazySchema.js'
import { SWITCH_KINDS, type SwitchKind } from './manifest.js'
import { getExtensionsLog, getInstalledFile, getSourcesFile } from './paths.js'


export const SourceRecordSchema = lazySchema(() =>
  z.object({
    kind: z.enum(['git', 'folder', 'archive']).describe('How the source is materialised.'),
    where: z.string().describe('The git URL, the folder path, or the archive path/URL as the operator typed it.'),
    ref: z.string().nullable().optional().describe('The pinned branch or tag (git only).'),
    addedAt: z.string().describe('ISO time the operator added it.'),
    checkedAt: z.string().nullable().describe('ISO time of the last successful refresh; null means never.'),
    commit: z.string().nullable().optional().describe('The checked-out commit (git only).'),
    lastError: z.string().nullable().describe('The last refresh failure, or null.'),
  }),
)
export type SourceRecord = z.infer<ReturnType<typeof SourceRecordSchema>>

export const ApprovalSchema = lazySchema(() =>
  z.object({
    version: z.string(),
    contributionsHash: z.string(),
    at: z.string(),
  }),
)
export type Approval = z.infer<ReturnType<typeof ApprovalSchema>>

export const SwitchesSchema = lazySchema(() =>
  z.object(Object.fromEntries(SWITCH_KINDS.map(kind => [kind, z.boolean()])) as Record<SwitchKind, z.ZodBoolean>),
)
export type Switches = Record<SwitchKind, boolean>

export const InstalledRecordSchema = lazySchema(() =>
  z.object({
    name: z.string(),
    label: z.string(),
    version: z.string(),
    commit: z.string().nullable(),
    contentHash: z.string(),
    contributionsHash: z.string(),
    installedAt: z.string(),
    updatedAt: z.string(),
    path: z.string(),
    previous: z.object({ version: z.string(), path: z.string(), contributionsHash: z.string() }).nullable(),
    approval: ApprovalSchema().nullable(),
    switches: SwitchesSchema(),
    pendingFirstLoad: z.boolean().optional(),
    pendingUpdate: z.object({ version: z.string(), path: z.string(), contributionsHash: z.string(), commit: z.string().nullable() }).nullable().optional(),
    bundledNote: z.string().nullable().optional(),
  }),
)
export type InstalledRecord = z.infer<ReturnType<typeof InstalledRecordSchema>>

export type SourcesFile = Record<string, SourceRecord>
export type InstalledFile = Record<string, InstalledRecord>

export function defaultSwitches(): Switches {
  return Object.fromEntries(SWITCH_KINDS.map(kind => [kind, true])) as Switches
}


export type RecordsRead<T> = { ok: true; data: T; exists: boolean } | { ok: false; error: string; path: string }

function readRecordsFile<T>(path: string, parse: (raw: unknown) => T): RecordsRead<T> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, data: parse({}), exists: false }
    return { ok: false, error: `unreadable: ${error instanceof Error ? error.message : String(error)}`, path }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `not JSON: ${error instanceof Error ? error.message : String(error)}`, path }
  }
  try {
    return { ok: true, data: parse(raw), exists: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), path }
  }
}

function parseSources(raw: unknown): SourcesFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('sources.json must be an object keyed by label')
  const out: SourcesFile = {}
  for (const [label, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = SourceRecordSchema().safeParse(value)
    if (!parsed.success) throw new Error(`sources.json: "${label}": ${parsed.error.issues[0]?.message ?? 'invalid record'}`)
    out[label] = parsed.data
  }
  return out
}

function parseInstalled(raw: unknown): InstalledFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('installed.json must be an object keyed by id')
  const out: InstalledFile = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = InstalledRecordSchema().safeParse(value)
    if (!parsed.success) throw new Error(`installed.json: "${id}": ${parsed.error.issues[0]?.message ?? 'invalid record'}`)
    out[id] = parsed.data
  }
  return out
}

export function readSources(): RecordsRead<SourcesFile> {
  return readRecordsFile(getSourcesFile(), parseSources)
}

export function readInstalled(): RecordsRead<InstalledFile> {
  return readRecordsFile(getInstalledFile(), parseInstalled)
}

export function sourcesOrEmpty(): SourcesFile {
  const read = readSources()
  return read.ok ? read.data : {}
}

export function installedOrEmpty(): InstalledFile {
  const read = readInstalled()
  return read.ok ? read.data : {}
}


export function writeDurable(path: string, text: string): void {
  durableAtomicPublishSync(path, text)
}

export function writeSources(data: SourcesFile): void {
  writeDurable(getSourcesFile(), JSON.stringify(data, null, 2) + '\n')
}

export function writeInstalled(data: InstalledFile): void {
  writeDurable(getInstalledFile(), JSON.stringify(data, null, 2) + '\n')
}

export function updateSources(mutate: (current: SourcesFile) => SourcesFile | void): { ok: true } | { ok: false; error: string } {
  const read = readSources()
  if (!read.ok) return { ok: false, error: `sources.json is ${read.error}` }
  const next = mutate(read.data) ?? read.data
  writeSources(next)
  return { ok: true }
}

export function updateInstalled(mutate: (current: InstalledFile) => InstalledFile | void): { ok: true } | { ok: false; error: string } {
  const read = readInstalled()
  if (!read.ok) return { ok: false, error: `installed.json is ${read.error}` }
  const next = mutate(read.data) ?? read.data
  writeInstalled(next)
  return { ok: true }
}


export function logAct(line: string): void {
  try {
    const path = getExtensionsLog()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
  }
}
