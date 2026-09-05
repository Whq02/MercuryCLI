
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { presenceNudge, probeGodotEditorPresence, takeCensus, type AddonPresenceFacts } from './editorPresence.js'
import { resolveGodotExecutable } from './portabilityDoctor.js'
import { getVulcanClient } from './vulcanClient.js'

export interface GlobalClassEntry {
  class: string
  base: string
  path: string
}

export interface DeclaredClass {
  class: string
  path: string
  mtimeMs: number
}

export type StaleReason = 'cache-missing' | 'missing-from-cache' | 'newer-than-cache'

export interface StaleClass extends DeclaredClass {
  reason: StaleReason
}

export interface ClassCacheReport {
  cacheFile: string
  present: boolean
  cacheMtimeMs?: number
  classes: GlobalClassEntry[]
  classTotal: number
  declared: DeclaredClass[]
  declaredTotal: number
  stale: StaleClass[]
  state: 'fresh' | 'stale' | 'absent'
  hint: string
}

export const REFRESH_CLASSES_OP = 'project_refresh_classes'
export const CLASS_CACHE_RELATIVE = path.join('.godot', 'global_script_class_cache.cfg')

const WALK_ENTRY_CAP = 20_000
const HEAD_BYTES = 4_096
const SKIP_DIRS = new Set(['.godot', '.git', '.import', 'node_modules'])
const IMPORT_TIMEOUT_MS = 120_000
const OUTPUT_TAIL_CHARS = 4_000
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

export function classCachePath(projectRoot: string): string {
  return path.join(projectRoot, CLASS_CACHE_RELATIVE)
}

export function parseGlobalClassCache(text: string): GlobalClassEntry[] {
  const out: GlobalClassEntry[] = []
  for (const m of text.matchAll(/\{[^}]*"base"\s*:\s*&?"([^"]*)"[^}]*"class"\s*:\s*&?"([^"]*)"[^}]*"path"\s*:\s*"([^"]*)"[^}]*\}/g)) {
    out.push({ class: m[2]!, base: m[1]!, path: m[3]! })
  }
  return out
}

export function classNameOf(head: string): string | undefined {
  const m = /^[ \t]*class_name[ \t]+([A-Za-z_][A-Za-z0-9_]*)/m.exec(head)
  return m?.[1]
}

export function declaredClasses(projectRoot: string): { list: DeclaredClass[]; total: number } {
  const list: DeclaredClass[] = []
  let visited = 0
  const root = path.resolve(projectRoot)
  const walk = (dir: string): void => {
    if (visited > WALK_ENTRY_CAP) return
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const name of entries) {
      if (visited++ > WALK_ENTRY_CAP) return
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
      const full = path.join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
      } else if (name.endsWith('.gd')) {
        let head: string
        try {
          head = readHead(full)
        } catch {
          continue
        }
        const cls = classNameOf(head)
        if (cls) {
          list.push({
            class: cls,
            path: 'res://' + path.relative(root, full).replace(/\\/g, '/'),
            mtimeMs: st.mtimeMs,
          })
        }
      }
    }
  }
  walk(root)
  return { list, total: list.length }
}

function readHead(file: string): string {
  const text = readFileSync(file, 'utf8')
  return text.length > HEAD_BYTES ? text.slice(0, HEAD_BYTES) : text
}

export function classCacheReport(projectRoot: string, budget = 40): ClassCacheReport {
  const cacheFile = classCachePath(projectRoot)
  let present = false
  let cacheMtimeMs: number | undefined
  let entries: GlobalClassEntry[] = []
  if (existsSync(cacheFile)) {
    try {
      cacheMtimeMs = statSync(cacheFile).mtimeMs
      entries = parseGlobalClassCache(readFileSync(cacheFile, 'utf8'))
      present = true
    } catch {
      present = false
    }
  }
  const declared = declaredClasses(projectRoot)
  const known = new Set(entries.map(e => e.class))
  const stale: StaleClass[] = []
  for (const d of declared.list) {
    if (!present) stale.push({ ...d, reason: 'cache-missing' })
    else if (!known.has(d.class)) stale.push({ ...d, reason: 'missing-from-cache' })
    else if (cacheMtimeMs !== undefined && d.mtimeMs > cacheMtimeMs) stale.push({ ...d, reason: 'newer-than-cache' })
  }
  const state: ClassCacheReport['state'] = !present ? 'absent' : stale.length > 0 ? 'stale' : 'fresh'
  const hint =
    state === 'fresh'
      ? ''
      : state === 'absent'
        ? `${CLASS_CACHE_RELATIVE} does not exist yet — ${declared.total} class_name script(s) are invisible to headless runs until an import pass writes it: op:"${REFRESH_CLASSES_OP}"`
        : `${CLASS_CACHE_RELATIVE} is STALE for ${stale.length} class_name script(s) (${stale
            .slice(0, 5)
            .map(s => `${s.class}: ${s.reason}`)
            .join(', ')}${stale.length > 5 ? ', …' : ''}) — headless runs fail with "Could not find type" until it is rebuilt: op:"${REFRESH_CLASSES_OP}"`
  return {
    cacheFile,
    present,
    ...(cacheMtimeMs !== undefined ? { cacheMtimeMs } : {}),
    classes: entries.slice(0, budget),
    classTotal: entries.length,
    declared: declared.list.slice(0, budget),
    declaredTotal: declared.total,
    stale,
    state,
    hint,
  }
}

export function unresolvedTypesIn(output: string): string[] {
  const out: string[] = []
  for (const m of output.matchAll(/Could not find type "([A-Za-z_][A-Za-z0-9_]*)"/g)) {
    if (!out.includes(m[1]!)) out.push(m[1]!)
  }
  return out
}

export function explainHeadlessFailure(output: string, report: ClassCacheReport): string | undefined {
  const missing = unresolvedTypesIn(output)
  if (missing.length === 0) return undefined
  const declared = new Set(report.declared.map(d => d.class))
  const explained = missing.filter(t => declared.has(t))
  if (explained.length === 0) return undefined
  return `"Could not find type" for ${explained.map(t => `"${t}"`).join(', ')}: the script declares it, but ${CLASS_CACHE_RELATIVE} ${report.present ? 'predates or omits it' : 'does not exist'} — rebuild the cache with op:"${REFRESH_CLASSES_OP}" and rerun`
}

export function refreshInvocation(executable: string, projectRoot: string): { file: string; args: string[] } {
  return { file: executable, args: ['--headless', '--import', '--path', projectRoot] }
}

export interface RefreshOutcome {
  ok: boolean
  road: 'headless-import' | 'editor-rescan' | 'refused'
  invocation?: string
  exitCode?: number
  seconds?: number
  outputTail?: string
  before: { classTotal: number; stale: number }
  after: { classTotal: number; stale: number; added: string[] }
  note: string
}

export async function refreshClassesHeadless(executable: string, projectRoot: string): Promise<RefreshOutcome> {
  const before = classCacheReport(projectRoot)
  const inv = refreshInvocation(executable, projectRoot)
  const t0 = Date.now()
  const r = await execFileNoThrow(inv.file, inv.args, { useCwd: false, timeout: IMPORT_TIMEOUT_MS })
  const seconds = Math.round((Date.now() - t0) / 100) / 10
  const after = classCacheReport(projectRoot)
  const beforeNames = new Set(before.classes.map(c => c.class))
  const added = after.classes.map(c => c.class).filter(c => !beforeNames.has(c))
  const raw = `${r.stdout}\n${r.stderr}`.replace(ANSI_RE, '').trim()
  const outputTail = raw.length > OUTPUT_TAIL_CHARS ? '…' + raw.slice(-OUTPUT_TAIL_CHARS) : raw
  const ok = r.code === 0 && after.present
  return {
    ok,
    road: 'headless-import',
    invocation: [inv.file, ...inv.args].join(' '),
    exitCode: r.code,
    seconds,
    outputTail,
    before: { classTotal: before.classTotal, stale: before.stale.length },
    after: { classTotal: after.classTotal, stale: after.stale.length, added },
    note: ok
      ? after.stale.length === 0
        ? `the import pass rebuilt ${CLASS_CACHE_RELATIVE}: ${after.classTotal} global class(es), ${added.length} new`
        : `the import pass ran, but ${after.stale.length} class_name script(s) still read stale (${after.stale.map(s => s.class).join(', ')}) — see the output tail for parse errors`
      : `the import pass exited ${r.code}${r.error ? ` (${r.error})` : ''} — see the output tail${explainHeadlessFailure(raw, after) ? `; ${explainHeadlessFailure(raw, after)}` : ''}`,
  }
}

const RESCAN_SETTLE_MS = 10_000
const RESCAN_POLL_MS = 250

async function refreshClassesViaEditor(projectRoot: string): Promise<RefreshOutcome> {
  const before = classCacheReport(projectRoot)
  const client = getVulcanClient()
  if (!client) {
    return refused(before, 'the bridge is up but no VULCAN client exists (flag off?) — op:"vulcan_status" explains')
  }
  const r = await client.request('editor_reload', { what: 'filesystem' }, 15_000)
  if (!r.ok) {
    return refused(before, `the editor refused the rescan: [${r.error.code}] ${r.error.message}${r.error.hint ? ` — ${r.error.hint}` : ''}`)
  }
  const t0 = Date.now()
  let after = classCacheReport(projectRoot)
  while (Date.now() - t0 < RESCAN_SETTLE_MS && (after.stale.length > 0 || after.cacheMtimeMs === before.cacheMtimeMs)) {
    await new Promise(resolve => setTimeout(resolve, RESCAN_POLL_MS))
    after = classCacheReport(projectRoot)
  }
  const beforeNames = new Set(before.classes.map(c => c.class))
  const added = after.classes.map(c => c.class).filter(c => !beforeNames.has(c))
  return {
    ok: after.stale.length === 0,
    road: 'editor-rescan',
    invocation: 'editor_reload {what: "filesystem"} over the bridge',
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    before: { classTotal: before.classTotal, stale: before.stale.length },
    after: { classTotal: after.classTotal, stale: after.stale.length, added },
    note:
      after.stale.length === 0
        ? `the editor rescanned and ${after.cacheMtimeMs !== before.cacheMtimeMs ? 'rewrote' : 'kept'} ${CLASS_CACHE_RELATIVE}: ${after.classTotal} global class(es), ${added.length} new`
        : `the editor rescanned but ${after.stale.length} class_name script(s) still read stale after ${RESCAN_SETTLE_MS / 1000}s (${after.stale.map(s => s.class).join(', ')}) — a parse error keeps a class out of the cache: op:"script_validate" on each`,
  }
}

function refused(before: ClassCacheReport, note: string): RefreshOutcome {
  return {
    ok: false,
    road: 'refused',
    before: { classTotal: before.classTotal, stale: before.stale.length },
    after: { classTotal: before.classTotal, stale: before.stale.length, added: [] },
    note,
  }
}

export async function runProjectRefreshClasses(
  projectRoot: string,
  port: number,
  addon: AddonPresenceFacts = { installed: true, enabled: true },
): Promise<RefreshOutcome> {
  const census = await takeCensus()
  const presence = await probeGodotEditorPresence(projectRoot, port, census)
  if (presence.state === 'bridge-up') return refreshClassesViaEditor(projectRoot)
  const before = classCacheReport(projectRoot)
  if (presence.state === 'editor-unbridged') {
    return refused(
      before,
      `${presence.words} — that editor owns this project's .godot/ and a second headless editor would race it; ${presenceNudge(presence, addon)}`,
    )
  }
  const executable = await resolveGodotExecutable({ census: census.processes, projectRoot })
  if (!executable.resolved) return refused(before, `no Godot executable to run the import pass: ${executable.note}`)
  return refreshClassesHeadless(executable.resolved, projectRoot)
}
