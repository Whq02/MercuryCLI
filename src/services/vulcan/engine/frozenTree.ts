import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { MERCURY_PROJECT_DIR } from '../../../utils/projectConfig.js'
import { subprocessEnv } from '../../../utils/subprocessEnv.js'

const GODOT_STATE_DIR = '.godot'

export interface EngineTreeSpec {
  ref: string
  files: string[]
  working: boolean
  label: string
}

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export type GitRunner = (root: string, args: string[], env?: Record<string, string>) => Promise<GitResult>

export interface EngineTreeFacts {
  spec: EngineTreeSpec
  commit: string
  path: string
  baseBlobs: Map<string, string>
  overlay: Map<string, string | null>
  files: string[]
  skipped: string[]
}

export interface EngineTreeHashes {
  assetHash: string
  scriptHash: string
  key: string
  assetFiles: number
  scriptFiles: number
}

export type EngineChangeAttribution =
  | { kind: 'uncommitted' }
  | { kind: 'commit'; commit: string; author: string; date: string }
  | { kind: 'unknown' }

const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9_./@^~{}-]*$/

export function parseEngineTreeSpec(raw: unknown): EngineTreeSpec | { error: string } {
  if (raw === undefined || raw === null || raw === '') return { ref: 'HEAD', files: [], working: false, label: 'HEAD' }
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (s === 'working') return { ref: 'HEAD', files: [], working: true, label: 'working' }
    const plus = s.indexOf('+')
    if (plus > 0) {
      const ref = s.slice(0, plus).trim() || 'HEAD'
      if (!REF_RE.test(ref)) return { error: `tree "${s}": "${ref}" is not a git ref` }
      const files = s
        .slice(plus + 1)
        .split(',')
        .map(f => f.trim())
        .filter(f => f.length > 0)
      if (files.length === 0) return { error: `tree "${s}" names no files after +` }
      return { ref, files, working: false, label: s }
    }
    if (!REF_RE.test(s)) return { error: `tree "${s}" is not a git ref (HEAD, a branch, a tag, a commit), "working", or <ref>+<comma list of files>` }
    return { ref: s, files: [], working: false, label: s }
  }
  if (typeof raw === 'object') {
    const o = raw as { ref?: unknown; files?: unknown; working?: unknown }
    const ref = typeof o.ref === 'string' && o.ref.trim().length > 0 ? o.ref.trim() : 'HEAD'
    if (!REF_RE.test(ref)) return { error: `tree.ref "${ref}" is not a git ref` }
    const files = Array.isArray(o.files)
      ? o.files.filter((f): f is string => typeof f === 'string' && f.trim().length > 0).map(f => f.trim())
      : []
    const working = o.working === true
    const label = working ? `${ref}+working` : files.length > 0 ? `${ref}+${files.length} file(s)` : ref
    return { ref, files, working, label }
  }
  return { error: 'tree must be a string (HEAD, <ref>, working, <ref>+<files>) or an object {ref, files}' }
}

export const runGit: GitRunner = (root, args, env) =>
  new Promise(resolve => {
    execFile(
      'git',
      ['-C', root, ...args],
      {
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
        encoding: 'utf8',
        env: env ? { ...subprocessEnv(), ...env } : subprocessEnv(),
      },
      (error, stdout, stderr) => {
        let code = 0
        if (error) {
          const raw = (error as NodeJS.ErrnoException & { code?: unknown }).code
          code = typeof raw === 'number' ? raw : 127
        }
        resolve({ code, stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''), stderr: typeof stderr === 'string' ? stderr : String(stderr ?? '') })
      },
    )
  })

export function gitBlobId(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
}

export function parsePorcelainZ(text: string): string[] {
  const out: string[] = []
  for (const entry of text.split('\0')) {
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    const file = entry.slice(3)
    if (status === '!!' || file.length === 0) continue
    out.push(file)
  }
  return out
}

export function parseLsTreeZ(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const entry of text.split('\0')) {
    const m = /^(\d{6}) (blob|commit) ([0-9a-f]{40,64})\t(.+)$/s.exec(entry)
    if (!m || m[2] !== 'blob') continue
    out.set(m[4], m[3])
  }
  return out
}

export function normalizeTreeFile(rel: string): string | null {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^res:\/\//, '')
  if (norm.length === 0 || path.isAbsolute(norm) || /^[A-Za-z]:\//.test(norm)) return null
  if (norm === '..' || norm.startsWith('../') || norm.includes('/../') || norm.endsWith('/..')) return null
  return norm
}

export function isEngineInternalPath(norm: string): boolean {
  return [GODOT_STATE_DIR, MERCURY_PROJECT_DIR].some(dir => norm === dir || norm.startsWith(`${dir}/`))
}

export async function materializeEngineTree(
  projectRoot: string,
  spec: EngineTreeSpec,
  dest: string,
  git: GitRunner = runGit,
): Promise<EngineTreeFacts | { error: string }> {
  const rev = await git(projectRoot, ['rev-parse', '--verify', '--quiet', `${spec.ref}^{commit}`])
  if (rev.code !== 0 || rev.stdout.trim().length === 0) {
    return { error: `git cannot resolve "${spec.ref}" as a commit in ${projectRoot}${rev.stderr.trim() ? `: ${rev.stderr.trim()}` : ''}` }
  }
  const commit = rev.stdout.trim()
  let files = spec.files
  if (spec.working) {
    const st = await git(projectRoot, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'])
    if (st.code !== 0) return { error: `git status failed in ${projectRoot}: ${st.stderr.trim()}` }
    files = [...spec.files, ...parsePorcelainZ(st.stdout)]
  }
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const indexFile = `${dest}.index`
  rmSync(indexFile, { force: true })
  const env = { GIT_INDEX_FILE: indexFile }
  const rt = await git(projectRoot, ['read-tree', commit], env)
  if (rt.code !== 0) {
    rmSync(indexFile, { force: true })
    return { error: `git read-tree ${commit.slice(0, 12)} failed: ${rt.stderr.trim()}` }
  }
  const prefix = dest.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
  const co = await git(projectRoot, ['checkout-index', '-a', '-f', `--prefix=${prefix}`], env)
  rmSync(indexFile, { force: true })
  if (co.code !== 0) return { error: `git checkout-index into ${dest} failed: ${co.stderr.trim()}` }
  const ls = await git(projectRoot, ['ls-tree', '-r', '-z', commit])
  if (ls.code !== 0) return { error: `git ls-tree ${commit.slice(0, 12)} failed: ${ls.stderr.trim()}` }
  const baseBlobs = parseLsTreeZ(ls.stdout)
  const overlay = new Map<string, string | null>()
  const applied: string[] = []
  const skipped: string[] = []
  for (const rel of files) {
    const norm = normalizeTreeFile(rel)
    if (norm === null) return { error: `tree file "${rel}" is outside the project` }
    if (isEngineInternalPath(norm)) {
      skipped.push(norm)
      continue
    }
    const live = path.join(projectRoot, norm)
    const target = path.join(dest, norm)
    let isFile = false
    try {
      isFile = statSync(live).isFile()
    } catch {
      isFile = false
    }
    if (isFile) {
      mkdirSync(path.dirname(target), { recursive: true })
      copyFileSync(live, target)
      overlay.set(norm, gitBlobId(readFileSync(live)))
    } else {
      rmSync(target, { force: true })
      overlay.set(norm, null)
    }
    applied.push(norm)
  }
  return { spec, commit, path: dest, baseBlobs, overlay, files: applied, skipped }
}

const SCRIPT_HEAD_BYTES = 4096
const NON_ASSET_SUFFIXES = [
  '.gd',
  '.gdshader',
  '.gdshaderinc',
  '.tscn',
  '.tres',
  '.md',
  '.txt',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.mjs',
  '.js',
  '.ts',
  '.py',
  '.sh',
  '.lock',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
]

export function isEngineAssetPath(rel: string): boolean {
  if (rel === 'project.godot') return true
  const lower = rel.toLowerCase()
  if (isEngineInternalPath(lower)) return false
  return !NON_ASSET_SUFFIXES.some(suffix => lower.endsWith(suffix))
}

export function scriptHeadSignature(text: string): string {
  const head = text.length > SCRIPT_HEAD_BYTES ? text.slice(0, SCRIPT_HEAD_BYTES) : text
  const out: string[] = []
  for (const line of head.split(/\r?\n/)) {
    if (/^\s*(class_name|extends|@tool|@icon|@abstract)\b/.test(line)) out.push(line.trim())
  }
  return out.join('\n')
}

function readTextOrEmpty(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export function engineTreeHashes(facts: Pick<EngineTreeFacts, 'path' | 'baseBlobs' | 'overlay'>): EngineTreeHashes {
  const blobs = new Map(facts.baseBlobs)
  for (const [p, blob] of facts.overlay) {
    if (blob === null) blobs.delete(p)
    else blobs.set(p, blob)
  }
  const asset = createHash('sha256')
  const script = createHash('sha256')
  let assetFiles = 0
  let scriptFiles = 0
  for (const rel of [...blobs.keys()].sort()) {
    const lower = rel.toLowerCase()
    if (lower.endsWith('.gd')) {
      script.update(rel).update('\0').update(scriptHeadSignature(readTextOrEmpty(path.join(facts.path, rel)))).update('\0')
      scriptFiles++
    } else if (lower.endsWith('.tscn') || lower.endsWith('.tres')) {
      const first = readTextOrEmpty(path.join(facts.path, rel)).split(/\r?\n/, 1)[0] ?? ''
      asset.update(rel).update('\0').update(first).update('\0')
      assetFiles++
    } else if (isEngineAssetPath(rel)) {
      asset.update(rel).update('\0').update(blobs.get(rel) ?? '').update('\0')
      assetFiles++
    }
  }
  const assetHash = asset.digest('hex')
  const scriptHash = script.digest('hex')
  return { assetHash, scriptHash, key: `${assetHash.slice(0, 16)}-${scriptHash.slice(0, 16)}`, assetFiles, scriptFiles }
}

export async function engineFileAttribution(
  projectRoot: string,
  facts: Pick<EngineTreeFacts, 'commit' | 'baseBlobs' | 'overlay'>,
  file: string,
  git: GitRunner = runGit,
): Promise<EngineChangeAttribution> {
  const norm = normalizeTreeFile(file)
  if (norm === null) return { kind: 'unknown' }
  if (facts.overlay.has(norm) && facts.overlay.get(norm) !== facts.baseBlobs.get(norm)) return { kind: 'uncommitted' }
  if (!facts.baseBlobs.has(norm)) return { kind: 'unknown' }
  const r = await git(projectRoot, ['log', '-1', '--format=%H%x1f%an%x1f%aI', facts.commit, '--', norm])
  if (r.code !== 0) return { kind: 'unknown' }
  const [commit, author, date] = r.stdout.trim().split('\x1f')
  if (!commit) return { kind: 'unknown' }
  return { kind: 'commit', commit, author: author ?? '', date: date ?? '' }
}

export async function liveTreeFacts(projectRoot: string, git: GitRunner = runGit): Promise<Pick<EngineTreeFacts, 'commit' | 'baseBlobs' | 'overlay'>> {
  const empty = { commit: '', baseBlobs: new Map<string, string>(), overlay: new Map<string, string | null>() }
  const rev = await git(projectRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  if (rev.code !== 0 || rev.stdout.trim().length === 0) return empty
  const commit = rev.stdout.trim()
  const ls = await git(projectRoot, ['ls-tree', '-r', '-z', commit])
  if (ls.code !== 0) return empty
  const baseBlobs = parseLsTreeZ(ls.stdout)
  const overlay = new Map<string, string | null>()
  const st = await git(projectRoot, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'])
  if (st.code === 0) {
    for (const rel of parsePorcelainZ(st.stdout)) {
      const norm = normalizeTreeFile(rel)
      if (norm === null || isEngineInternalPath(norm)) continue
      try {
        overlay.set(norm, gitBlobId(readFileSync(path.join(projectRoot, norm))))
      } catch {
        overlay.set(norm, null)
      }
    }
  }
  return { commit, baseBlobs, overlay }
}

export function describeAttribution(a: EngineChangeAttribution): string {
  if (a.kind === 'uncommitted') return 'uncommitted'
  if (a.kind === 'commit') return `${a.commit.slice(0, 12)} ${a.author}${a.date ? ` ${a.date}` : ''}`
  return 'unknown'
}

export function removeEngineTree(dest: string): void {
  rmSync(dest, { recursive: true, force: true })
  rmSync(`${dest}.index`, { force: true })
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
}
