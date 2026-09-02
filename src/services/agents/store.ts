import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { findGitRoot } from '../../utils/git.js'
import { adoptiveProjectPath } from '../../utils/projectStoreAdoption.js'
import type { SettingSource } from '../../utils/settings/constants.js'
import { decodeAgentDocument, validateAgentIdentifier } from './codec.js'
import {
  type AgentDocument,
  type AgentFileIdentity,
  type AgentSpecFields,
  revisionDigest,
} from './contracts.js'
import { noteSelfWrite } from './watch.js'

export type AgentStoreErrorCode =
  | 'validation'
  | 'revision-conflict'
  | 'source-missing'
  | 'already-exists'
  | 'io'

export class AgentStoreError extends Error {
  constructor(
    readonly code: AgentStoreErrorCode,
    message: string,
    readonly detail?: {
      path?: string
      expectedRevision?: string
      currentRevision?: string
      currentRaw?: string
    },
  ) {
    super(message)
    this.name = 'AgentStoreError'
  }
}

export type AgentSaveReceipt = {
  path: string
  beforeRevision?: string
  afterRevision: string
  semanticChanges: string[]
  bytes: number
  at: string
}

export type AgentSaveTarget =
  | { kind: 'existing'; identity: AgentFileIdentity }
  | { kind: 'new'; scope: 'user' | 'project'; cwd: string; slug: string }

export function newAgentDirectory(
  scope: 'user' | 'project',
  cwd: string,
): string {
  if (scope === 'user') {
    return join(getMercuryHome(), 'agents')
  }
  const root = findGitRoot(cwd) ?? cwd
  return adoptiveProjectPath(root, 'agents')
}

export function newAgentPath(
  scope: 'user' | 'project',
  cwd: string,
  slug: string,
): string {
  return join(newAgentDirectory(scope, cwd), `${slug}.md`)
}

export { validateAgentIdentifier }

function fieldChanges(
  before: AgentSpecFields | undefined,
  after: AgentSpecFields,
  bodyChanged: boolean,
): string[] {
  const changes: string[] = []
  const keys = new Set<keyof AgentSpecFields>([
    ...(Object.keys(before ?? {}) as (keyof AgentSpecFields)[]),
    ...(Object.keys(after) as (keyof AgentSpecFields)[]),
  ])
  for (const key of keys) {
    const a = before?.[key]
    const b = after[key]
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push(String(key))
  }
  if (bodyChanged) changes.push('body')
  return changes.sort()
}

function receiptsPath(): string {
  return join(getMercuryHome(), 'agent-receipts.jsonl')
}

const RECEIPTS_KEEP = 200

async function appendReceipt(record: Record<string, unknown>): Promise<void> {
  try {
    let existing: string[] = []
    try {
      existing = readFileSync(receiptsPath(), 'utf-8')
        .split('\n')
        .filter(Boolean)
    } catch {
    }
    existing.push(JSON.stringify(record))
    const bounded = existing.slice(-RECEIPTS_KEEP)
    await durableAtomicPublish(receiptsPath(), bounded.join('\n') + '\n')
  } catch (e) {
    logForDebugging(
      `agent receipt append failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

export async function saveAgentDocument(
  target: AgentSaveTarget,
  document: AgentDocument,
): Promise<AgentSaveReceipt> {
  const idError = validateAgentIdentifier(document.fields.name)
  if (idError) throw new AgentStoreError('validation', idError)
  if (!document.fields.description) {
    throw new AgentStoreError('validation', 'Description is required')
  }
  const errors = document.diagnostics.filter(d => d.severity === 'error')
  if (errors.length > 0) {
    throw new AgentStoreError(
      'validation',
      `Definition has ${errors.length} error(s): ${errors.map(e => e.code).join(', ')}`,
    )
  }

  let path: string
  let beforeRevision: string | undefined
  let beforeFields: AgentSpecFields | undefined
  let beforeBody: string | undefined

  if (target.kind === 'existing') {
    path = target.identity.filePath
    let currentRaw: string
    try {
      currentRaw = readFileSync(path, 'utf-8')
    } catch {
      throw new AgentStoreError(
        'source-missing',
        `The definition file no longer exists at ${path} — it was moved or deleted outside this session`,
        { path, expectedRevision: target.identity.revision },
      )
    }
    const currentRevision = revisionDigest(currentRaw)
    if (currentRevision !== target.identity.revision) {
      throw new AgentStoreError(
        'revision-conflict',
        `The file at ${path} changed since it was loaded (expected ${target.identity.revision}, found ${currentRevision})`,
        {
          path,
          expectedRevision: target.identity.revision,
          currentRevision,
          currentRaw,
        },
      )
    }
    beforeRevision = currentRevision
    const beforeDoc = decodeAgentDocument(currentRaw, path)
    beforeFields = beforeDoc.fields
    beforeBody = beforeDoc.body
  } else {
    path = newAgentPath(target.scope, target.cwd, target.slug)
    let exists = false
    try {
      readFileSync(path, 'utf-8')
      exists = true
    } catch {
    }
    if (exists) {
      throw new AgentStoreError(
        'already-exists',
        `Agent file already exists: ${path}`,
        { path },
      )
    }
  }

  noteSelfWrite(path)
  try {
    await durableAtomicPublish(path, document.raw)
  } catch (e) {
    throw new AgentStoreError(
      'io',
      `Failed to write ${path}: ${e instanceof Error ? e.message : String(e)}`,
      { path },
    )
  }

  const receipt: AgentSaveReceipt = {
    path,
    ...(beforeRevision !== undefined ? { beforeRevision } : {}),
    afterRevision: revisionDigest(document.raw),
    semanticChanges: fieldChanges(
      beforeFields,
      document.fields,
      beforeBody !== undefined ? beforeBody !== document.body : true,
    ),
    bytes: Buffer.byteLength(document.raw, 'utf-8'),
    at: new Date().toISOString(),
  }
  await appendReceipt({ kind: 'save', ...receipt })
  return receipt
}


export type AgentTrashEntry = {
  id: string
  agentType: string
  source: SettingSource | 'unknown'
  originalPath: string
  revision: string
  deletedAt: string
}

function trashDir(): string {
  return join(getMercuryHome(), 'agent-trash')
}

const TRASH_KEEP = 50

function listTrashSidecars(): { path: string; entry: AgentTrashEntry }[] {
  let names: string[]
  try {
    names = readdirSync(trashDir())
  } catch {
    return []
  }
  const out: { path: string; entry: AgentTrashEntry }[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(trashDir(), name)
    try {
      const entry = JSON.parse(readFileSync(path, 'utf-8')) as AgentTrashEntry
      if (entry && typeof entry.originalPath === 'string' && entry.id) {
        out.push({ path, entry })
      }
    } catch {
    }
  }
  out.sort((a, b) => (a.entry.deletedAt < b.entry.deletedAt ? 1 : -1))
  return out
}

export function listAgentTrash(): AgentTrashEntry[] {
  return listTrashSidecars().map(s => s.entry)
}

export async function deleteAgentToTrash(
  identity: AgentFileIdentity,
  meta: { agentType: string; source: SettingSource },
): Promise<AgentTrashEntry> {
  let raw: string
  try {
    raw = readFileSync(identity.filePath, 'utf-8')
  } catch {
    throw new AgentStoreError(
      'source-missing',
      `Cannot delete: no file at ${identity.filePath}`,
      { path: identity.filePath },
    )
  }
  const currentRevision = revisionDigest(raw)
  if (currentRevision !== identity.revision) {
    throw new AgentStoreError(
      'revision-conflict',
      `The file at ${identity.filePath} changed since it was loaded — reload before deleting`,
      {
        path: identity.filePath,
        expectedRevision: identity.revision,
        currentRevision,
        currentRaw: raw,
      },
    )
  }
  mkdirSync(trashDir(), { recursive: true })
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${meta.agentType}`
  const entry: AgentTrashEntry = {
    id,
    agentType: meta.agentType,
    source: meta.source,
    originalPath: identity.filePath,
    revision: currentRevision,
    deletedAt: new Date().toISOString(),
  }
  await durableAtomicPublish(join(trashDir(), `${id}.md`), raw)
  await durableAtomicPublish(
    join(trashDir(), `${id}.json`),
    JSON.stringify(entry, null, 2) + '\n',
  )
  noteSelfWrite(identity.filePath)
  try {
    unlinkSync(identity.filePath)
  } catch (e) {
    throw new AgentStoreError(
      'io',
      `Trash copy written but the source could not be removed: ${e instanceof Error ? e.message : String(e)}`,
      { path: identity.filePath },
    )
  }
  await appendReceipt({
    kind: 'delete',
    path: identity.filePath,
    beforeRevision: currentRevision,
    trashId: id,
    at: entry.deletedAt,
  })
  const sidecars = listTrashSidecars()
  for (const stale of sidecars.slice(TRASH_KEEP)) {
    try {
      unlinkSync(stale.path)
      unlinkSync(stale.path.replace(/\.json$/, '.md'))
    } catch {
    }
  }
  return entry
}

export async function restoreAgentFromTrash(
  id: string,
  opts?: { toPath?: string; overwrite?: boolean },
): Promise<{ path: string; revision: string }> {
  const sidecar = listTrashSidecars().find(s => s.entry.id === id)
  if (!sidecar) {
    throw new AgentStoreError('source-missing', `No trash entry '${id}'`)
  }
  const bytesPath = sidecar.path.replace(/\.json$/, '.md')
  let raw: string
  try {
    raw = readFileSync(bytesPath, 'utf-8')
  } catch {
    throw new AgentStoreError(
      'source-missing',
      `Trash entry '${id}' has no content file (${basename(bytesPath)})`,
    )
  }
  const dest = opts?.toPath ?? sidecar.entry.originalPath
  if (!opts?.overwrite) {
    let exists = false
    try {
      readFileSync(dest, 'utf-8')
      exists = true
    } catch {
    }
    if (exists) {
      throw new AgentStoreError(
        'already-exists',
        `A file already exists at ${dest} — restore elsewhere or overwrite explicitly`,
        { path: dest },
      )
    }
  }
  noteSelfWrite(dest)
  await durableAtomicPublish(dest, raw)
  try {
    unlinkSync(sidecar.path)
    unlinkSync(bytesPath)
  } catch {
  }
  await appendReceipt({
    kind: 'restore',
    path: dest,
    afterRevision: revisionDigest(raw),
    trashId: id,
    at: new Date().toISOString(),
  })
  return { path: dest, revision: revisionDigest(raw) }
}


export type AgentDraft = {
  version: 1
  savedAt: string
  baseIdentity?: AgentFileIdentity
  newTarget?: { scope: 'user' | 'project'; cwd: string }
  raw: string
}

function draftsDir(): string {
  return join(getMercuryHome(), 'agent-drafts')
}

function draftKey(draft: Pick<AgentDraft, 'baseIdentity'>): string {
  if (draft.baseIdentity) {
    return `edit-${revisionDigest(draft.baseIdentity.filePath)}`
  }
  return 'new'
}

export async function saveAgentDraft(
  draft: Omit<AgentDraft, 'version' | 'savedAt'>,
): Promise<string> {
  const full: AgentDraft = {
    version: 1,
    savedAt: new Date().toISOString(),
    ...draft,
  }
  const path = join(draftsDir(), `${draftKey(draft)}.json`)
  await durableAtomicPublish(path, JSON.stringify(full, null, 2) + '\n')
  return path
}

export function listAgentDrafts(): { path: string; draft: AgentDraft }[] {
  let names: string[]
  try {
    names = readdirSync(draftsDir())
  } catch {
    return []
  }
  const out: { path: string; draft: AgentDraft }[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(draftsDir(), name)
    try {
      const draft = JSON.parse(readFileSync(path, 'utf-8')) as AgentDraft
      if (draft?.version === 1 && typeof draft.raw === 'string') {
        out.push({ path, draft })
      }
    } catch {
    }
  }
  return out
}

export function discardAgentDraft(path: string): void {
  try {
    unlinkSync(path)
  } catch {
  }
}
