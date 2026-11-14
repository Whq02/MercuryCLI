import * as fs from 'node:fs'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { controlCharacterPathRefusal, expandPath } from '../../utils/path.js'

interface UploadMember {
  path: string
  real: string
  parts: string[]
  dev: number
  ino: number
  size: number
}

export interface UploadSource {
  given: string
  path: string
  real: string
  folder: boolean
  members: UploadMember[]
}

class SourceRefusal extends Error {}

function codeOf(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? (err as Error).message
}

function memberOf(at: string, real: string, parts: string[], stat: fs.Stats): UploadMember {
  try {
    fs.accessSync(real, fs.constants.R_OK)
  } catch (err) {
    throw new SourceRefusal(`${at} cannot be read (${codeOf(err)})`)
  }
  return { path: at, real, parts, dev: stat.dev, ino: stat.ino, size: stat.size }
}

function walk(at: string, real: string, parts: string[], seen: Set<string>, members: UploadMember[]): void {
  let names: string[]
  try {
    names = fs.readdirSync(real).sort()
  } catch (err) {
    throw new SourceRefusal(`${at} cannot be listed (${codeOf(err)})`)
  }
  for (const name of names) {
    const childAt = path.join(at, name)
    const childParts = [...parts, name]
    let childReal: string
    let stat: fs.Stats
    try {
      childReal = fs.realpathSync.native(path.join(real, name))
      stat = fs.statSync(childReal)
    } catch (err) {
      throw new SourceRefusal(`${childAt} cannot be reached (${codeOf(err)})`)
    }
    if (stat.isDirectory()) {
      if (seen.has(childReal)) continue
      seen.add(childReal)
      walk(childAt, childReal, childParts, seen, members)
    } else if (stat.isFile()) {
      members.push(memberOf(childAt, childReal, childParts, stat))
    } else {
      throw new SourceRefusal(`${childAt} is not a regular file`)
    }
  }
}

export function resolveUploadSources(files: readonly string[]): { sources: UploadSource[] } | { refusal: string } {
  const sources: UploadSource[] = []
  try {
    for (const given of files) {
      const control = controlCharacterPathRefusal(given)
      if (control) throw new SourceRefusal(control)
      if (given.trim() === '') throw new SourceRefusal('a file path is empty')
      const at = expandPath(given)
      if (fs.lstatSync(at, { throwIfNoEntry: false }) === undefined) throw new SourceRefusal(`${given} does not exist`)
      let real: string
      let stat: fs.Stats
      try {
        real = fs.realpathSync.native(at)
        stat = fs.statSync(real)
      } catch (err) {
        throw new SourceRefusal(`${given} cannot be reached (${codeOf(err)})`)
      }
      if (stat.isFile()) {
        sources.push({ given, path: at, real, folder: false, members: [memberOf(at, real, [], stat)] })
      } else if (stat.isDirectory()) {
        const members: UploadMember[] = []
        walk(at, real, [], new Set([real]), members)
        if (members.length === 0) throw new SourceRefusal(`${given} is a folder that holds no file`)
        sources.push({ given, path: at, real, folder: true, members })
      } else {
        throw new SourceRefusal(`${given} is not a regular file or a folder`)
      }
    }
  } catch (err) {
    if (err instanceof SourceRefusal) return { refusal: err.message }
    throw err
  }
  return { sources }
}

export function uploadSourcesChanged(checked: readonly UploadSource[], now: readonly UploadSource[]): string | null {
  for (let i = 0; i < now.length; i++) {
    const before = checked[i]
    const after = now[i]!
    if (before === undefined || before.path !== after.path) return `${after.given} was not among the files the permission check saw`
    if (before.real !== after.real) return `${after.given} is another file than the permission check saw (it led to ${before.real}, it leads to ${after.real} now)`
    const judged = new Set(before.members.map(member => member.real))
    const added = after.members.find(member => !judged.has(member.real))
    if (added !== undefined) return `${added.path} was not there when the permission check saw ${after.given}`
  }
  return null
}

async function copyVerified(member: UploadMember, to: string, signal: AbortSignal | undefined): Promise<void> {
  const handle = await fs.promises.open(member.real, fs.constants.O_RDONLY)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.dev !== member.dev || stat.ino !== member.ino) {
      throw new Error(`${member.path} was replaced while it was being sent`)
    }
    await pipeline(handle.createReadStream({ autoClose: false }), fs.createWriteStream(to, { flags: 'wx' }), { signal })
    await fs.promises.utimes(to, stat.atime, stat.mtime)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

interface StagedUpload {
  dir: string
  paths: string[]
  files: number
  bytes: number
}

export async function stageUploads(sources: readonly UploadSource[], root: string, signal?: AbortSignal): Promise<StagedUpload> {
  await fs.promises.mkdir(root, { recursive: true })
  const dir = await fs.promises.mkdtemp(path.join(root, 'u-'))
  const staged: StagedUpload = { dir, paths: [], files: 0, bytes: 0 }
  try {
    for (const [index, source] of sources.entries()) {
      const top = path.join(dir, String(index + 1), path.basename(source.path))
      await fs.promises.mkdir(path.dirname(top), { recursive: true })
      for (const member of source.members) {
        const to = source.folder ? path.join(top, ...member.parts) : top
        if (source.folder) await fs.promises.mkdir(path.dirname(to), { recursive: true })
        await copyVerified(member, to, signal)
        staged.files++
        staged.bytes += member.size
      }
      staged.paths.push(top)
    }
  } catch (err) {
    await dropStagedUpload(dir)
    throw err
  }
  return staged
}

export async function dropStagedUpload(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
}
