
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { renameWithWin32RetrySync } from '../../substrate/durablePublish.js'
import * as path from 'node:path'
import { probeGodotEditorReachable } from '../lsp/godotLane.js'
import { vulcanEnabled, vulcanLiteMode, vulcanPort } from '../../utils/vulcan/vulcanGates.js'
import { VULCAN_ADDON_DIGEST, VULCAN_ADDON_FILES } from './addonFiles.generated.js'
import { classCacheReport } from './classCache.js'
import {
  describePresenceProcesses,
  presenceNudge,
  probeGodotEditorPresence,
  takeCensus,
  type GodotEditorPresence,
} from './editorPresence.js'
import type { GodotProcess } from './godotProcessCensus.js'
import { getVulcanClient, type VulcanClient, type VulcanResult } from './vulcanClient.js'
import { ensureVulcanToken, readVulcanToken, vulcanTokenPath } from './vulcanToken.js'

const ADDON_DIR = path.join('addons', 'mercury_vulcan')
const PLUGIN_CFG_RES = 'res://addons/mercury_vulcan/plugin.cfg'
const RUNTIME_AUTOLOAD = 'MercuryVulcanRuntimeBridge'
const RUNTIME_AUTOLOAD_SCRIPT = 'res://addons/mercury_vulcan/core/runtime_bridge.gd'
export const RUNTIME_AUTOLOAD_ROW_VALUE = `"*${RUNTIME_AUTOLOAD_SCRIPT}"`
const DEFAULT_VULCAN_PORT = 6010
const RECEIPT_VALUE_CAP = 160

export interface VulcanInstallStatus {
  installed: boolean
  digestMatch: boolean
  enabled: boolean
  bundledFiles: number
}

export function vulcanInstallStatus(projectRoot: string): VulcanInstallStatus {
  const addonRoot = path.join(projectRoot, ADDON_DIR)
  const installed = existsSync(path.join(addonRoot, 'plugin.cfg'))
  let digestMatch = installed && VULCAN_ADDON_FILES.length > 0
  if (digestMatch) {
    for (const f of VULCAN_ADDON_FILES) {
      const target = path.join(addonRoot, f.path)
      try {
        if (readFileSync(target, 'utf8') !== f.content) {
          digestMatch = false
          break
        }
      } catch {
        digestMatch = false
        break
      }
    }
  }
  return {
    installed,
    digestMatch,
    enabled: readEnabledPlugins(projectRoot).includes(PLUGIN_CFG_RES),
    bundledFiles: VULCAN_ADDON_FILES.length,
  }
}


function projectGodotPath(projectRoot: string): string {
  return path.join(projectRoot, 'project.godot')
}

export function readEnabledPlugins(projectRoot: string): string[] {
  let text: string
  try {
    text = readFileSync(projectGodotPath(projectRoot), 'utf8')
  } catch {
    return []
  }
  return enabledPluginsFromText(text)
}

function enabledPluginsFromText(text: string): string[] {
  const m = text.match(/\[editor_plugins\][^[]*?enabled=PackedStringArray\(([^)]*)\)/s)
  if (!m) return []
  return [...m[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => x[1]!)
}


export interface ProjectGodotEdit {
  section: string
  key: string
  previous?: string
  next?: string
  why: string
}

function clip(v: string): string {
  return v.length > RECEIPT_VALUE_CAP ? v.slice(0, RECEIPT_VALUE_CAP - 1) + '…' : v
}

export function formatProjectGodotReceipt(edit: ProjectGodotEdit): string {
  const previous = edit.previous === undefined ? '(absent)' : clip(edit.previous)
  const next = edit.next === undefined ? '(removed)' : clip(edit.next)
  return `project.godot [${edit.section}] ${edit.key}: ${previous} → ${next} — ${edit.why}`
}

export interface ChangeRecordRoad {
  before?: (file: string) => Promise<void>
  after?: (file: string, previous: string, next: string) => void
}

const GODOT_MUTATION_ATTEMPTS = 3

export type ProjectGodotMutation =
  | { ok: true; edits: ProjectGodotEdit[]; receipts: string[] }
  | { ok: false; conflict: string }

export async function mutateProjectGodot(
  projectRoot: string,
  mutate: (text: string) => { text: string; edits: ProjectGodotEdit[] },
  road: ChangeRecordRoad = {},
): Promise<ProjectGodotMutation> {
  const file = projectGodotPath(projectRoot)
  for (let attempt = 0; attempt < GODOT_MUTATION_ATTEMPTS; attempt++) {
    let original: string
    try {
      original = readFileSync(file, 'utf8')
    } catch {
      original = ''
    }
    const out = mutate(original)
    if (out.text === original) {
      return { ok: true, edits: [], receipts: [] }
    }
    if (road.before) await road.before(file)
    const tmp = `${file}.mercury-tmp-${process.pid}-${attempt}`
    writeFileSync(tmp, out.text)
    let current: string
    try {
      current = readFileSync(file, 'utf8')
    } catch {
      current = ''
    }
    if (current !== original) {
      try {
        unlinkSync(tmp)
      } catch {
      }
      continue
    }
    renameWithWin32RetrySync(tmp, file)
    road.after?.(file, original, out.text)
    return { ok: true, edits: out.edits, receipts: out.edits.map(formatProjectGodotReceipt) }
  }
  return {
    ok: false,
    conflict:
      'project.godot kept changing under concurrent edits (is the editor saving?) — no partial write was made; retry when the editor is idle',
  }
}


function sectionSpan(text: string, section: string): [number, number] | null {
  const m = new RegExp(`\\[${section}\\]`).exec(text)
  if (!m) return null
  const start = m.index + m[0].length
  const rest = text.slice(start).search(/\n\[[^\]]+\]/)
  return [start, rest === -1 ? text.length : start + rest]
}

export function readRuntimeAutoloadEntry(projectRoot: string): string | undefined {
  let text: string
  try {
    text = readFileSync(projectGodotPath(projectRoot), 'utf8')
  } catch {
    return undefined
  }
  return runtimeAutoloadFromText(text)
}

function runtimeAutoloadFromText(text: string): string | undefined {
  const span = sectionSpan(text, 'autoload')
  if (!span) return undefined
  const m = text.slice(span[0], span[1]).match(new RegExp(`^${RUNTIME_AUTOLOAD}=(.*)$`, 'm'))
  return m ? m[1] : undefined
}

export function explainRuntimeAutoloadRow(value: string | undefined, installed: boolean): string {
  if (value === undefined) {
    return installed
      ? `absent — the play-mode bridge cannot attach to play sessions; op:"vulcan_install" writes it`
      : 'absent'
  }
  if (value.includes('uid://')) {
    return `${value} — uid:// spelling written by the Godot editor (add_autoload_singleton stores "*" + path_to_uid once the script has a .uid sidecar; the same ${RUNTIME_AUTOLOAD_SCRIPT}; op:"project_uid_to_path" resolves it)`
  }
  if (value === RUNTIME_AUTOLOAD_ROW_VALUE) {
    return `${value} — the res:// row vulcan_install writes (receipted)`
  }
  return `${value} — an unexpected value; expected ${RUNTIME_AUTOLOAD_ROW_VALUE}`
}

function withRuntimeAutoload(text: string): { text: string; added: boolean } {
  const span = sectionSpan(text, 'autoload')
  const row = `${RUNTIME_AUTOLOAD}=${RUNTIME_AUTOLOAD_ROW_VALUE}`
  if (span) {
    const section = text.slice(span[0], span[1])
    if (new RegExp(`^${RUNTIME_AUTOLOAD}=`, 'm').test(section)) return { text, added: false }
    const kept = section.replace(/\s*$/, '')
    return { text: `${text.slice(0, span[0])}${kept}\n${row}\n${text.slice(span[1])}`, added: true }
  }
  return { text: text.replace(/\s*$/, `\n\n[autoload]\n\n${row}\n`), added: true }
}

function withoutRuntimeAutoload(text: string): { text: string; stripped: boolean } {
  const span = sectionSpan(text, 'autoload')
  if (!span) return { text, stripped: false }
  const section = text.slice(span[0], span[1])
  const lineRe = new RegExp(`^${RUNTIME_AUTOLOAD}=.*\\n?`, 'm')
  if (!lineRe.test(section)) return { text, stripped: false }
  return {
    text: text.slice(0, span[0]) + section.replace(lineRe, '') + text.slice(span[1]),
    stripped: true,
  }
}

export function readProjectVulcanPort(projectRoot: string): number | undefined {
  let text: string
  try {
    text = readFileSync(projectGodotPath(projectRoot), 'utf8')
  } catch {
    return undefined
  }
  return vulcanPortFromText(text)
}

function withVulcanPort(text: string, port: number): string {
  const span = sectionSpan(text, 'mercury_vulcan')
  if (span) {
    const section = text.slice(span[0], span[1])
    const next = /^port=\d+$/m.test(section)
      ? section.replace(/^port=\d+$/m, `port=${port}`)
      : `\n\nport=${port}${section}`
    return text.slice(0, span[0]) + next + text.slice(span[1])
  }
  return text.replace(/\s*$/, `\n\n[mercury_vulcan]\n\nport=${port}\n`)
}

function vulcanPortFromText(text: string): number | undefined {
  const span = sectionSpan(text, 'mercury_vulcan')
  if (!span) return undefined
  const m = text.slice(span[0], span[1]).match(/^port=(\d+)$/m)
  return m ? Number(m[1]) : undefined
}

function withEnabledPlugins(text: string, plugins: string[]): string {
  const arr = `PackedStringArray(${plugins.map(p => JSON.stringify(p)).join(', ')})`
  if (/\[editor_plugins\][^[]*?enabled=PackedStringArray\([^)]*\)/s.test(text)) {
    return text.replace(
      /(\[editor_plugins\][^[]*?enabled=)PackedStringArray\([^)]*\)/s,
      `$1${arr}`,
    )
  }
  if (/\[editor_plugins\]/.test(text)) {
    return text.replace(/\[editor_plugins\]\s*\n/, `[editor_plugins]\n\nenabled=${arr}\n`)
  }
  return text.replace(/\s*$/, `\n\n[editor_plugins]\n\nenabled=${arr}\n`)
}


export const PLUGIN_RELOAD_SCRIPT =
  'func run():\n' +
  '\tEditorInterface.call_deferred("set_plugin_enabled", "mercury_vulcan", false)\n' +
  '\tEditorInterface.call_deferred("set_plugin_enabled", "mercury_vulcan", true)\n' +
  '\treturn "plugin reload scheduled"\n'

const RELOAD_SETTLE_MS = 6_000
const RELOAD_OP_TIMEOUT_MS = 8_000

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function serverStartedMs(r: VulcanResult): number | undefined {
  if (!r.ok || typeof r.result !== 'object' || r.result === null) return undefined
  const v = (r.result as { vulcan_server_started_ms?: unknown }).vulcan_server_started_ms
  return typeof v === 'number' ? v : undefined
}

export async function reloadPluginOverBridge(port: number): Promise<string> {
  const client = getVulcanClient()
  if (!client) return 'plugin reload skipped: no VULCAN client (flag off, or not a project)'
  const startedBefore = serverStartedMs(await client.request('editor_state', undefined, RELOAD_OP_TIMEOUT_MS))
  const asked = await client.request('editor_execute_script', { code: PLUGIN_RELOAD_SCRIPT }, RELOAD_OP_TIMEOUT_MS)
  if (!asked.ok) {
    return `plugin reload refused by the editor: [${asked.error.code}] ${asked.error.message} — disable and re-enable "Mercury VULCAN" under Project > Project Settings > Plugins`
  }
  const t0 = Date.now()
  let dropped = false
  let last: VulcanResult = asked
  while (Date.now() - t0 < RELOAD_SETTLE_MS) {
    last = await client.request('editor_state', undefined, RELOAD_OP_TIMEOUT_MS)
    if (!last.ok) {
      dropped = true
      await sleep(Math.max(150, Math.min(client.backoffRemainingMs() + 50, 1_500)))
      continue
    }
    if (serverStartedMs(last) !== startedBefore) {
      return `the running editor reloaded the plugin (bridge back after ${Date.now() - t0}ms; the editor saved project.godot in its own layout on the way — see vulcan_status for the autoload row)`
    }
    await sleep(150)
  }
  return `plugin reload requested; the bridge ${dropped ? 'dropped and is back' : 'never dropped'} but the server start stamp did not change (${last.ok ? 'same server' : `[${last.error.code}] ${last.error.message}`}) — reload it by hand: Project > Project Settings > Plugins`
}


export async function applyVulcanInstall(
  projectRoot: string,
  road: ChangeRecordRoad = {},
  opts: { census?: { ok: boolean; processes: GodotProcess[] } } = {},
): Promise<string> {
  if (VULCAN_ADDON_FILES.length === 0) {
    return 'the addon bundle is empty (a dev build before regen-addon ran) — run: node scripts/vulcan/regen-addon.mjs and rebuild'
  }
  const before = vulcanInstallStatus(projectRoot)
  const addonRoot = path.join(projectRoot, ADDON_DIR)
  let written = 0
  for (const f of VULCAN_ADDON_FILES) {
    const target = path.join(addonRoot, f.path)
    let current: string | undefined
    try {
      current = readFileSync(target, 'utf8')
    } catch {
      current = undefined
    }
    if (current === f.content) continue
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, f.content)
    written++
  }
  const port = vulcanPort()
  const mutated = await mutateProjectGodot(
    projectRoot,
    text => {
      const edits: ProjectGodotEdit[] = []
      let next = text
      const enabled = enabledPluginsFromText(next)
      if (!enabled.includes(PLUGIN_CFG_RES)) {
        const list = [...enabled, PLUGIN_CFG_RES]
        next = withEnabledPlugins(next, list)
        edits.push({
          section: 'editor_plugins',
          key: 'enabled',
          ...(enabled.length > 0 ? { previous: enabled.join(', ') } : {}),
          next: list.join(', '),
          why: 'the editor loads the plugins listed here at startup (or from Project Settings > Plugins)',
        })
      }
      const currentPort = vulcanPortFromText(next)
      if (port !== (currentPort ?? DEFAULT_VULCAN_PORT)) {
        next = withVulcanPort(next, port)
        edits.push({
          section: 'mercury_vulcan',
          key: 'port',
          ...(currentPort !== undefined ? { previous: String(currentPort) } : {}),
          next: String(port),
          why: 'the addon listens on this project setting; Mercury dials MERCURY_GODOT_TOOLS_PORT — the two must agree',
        })
      }
      const autoload = withRuntimeAutoload(next)
      if (autoload.added) {
        next = autoload.text
        edits.push({
          section: 'autoload',
          key: RUNTIME_AUTOLOAD,
          next: RUNTIME_AUTOLOAD_ROW_VALUE,
          why: 'the play-mode bridge autoload — the game process reads [autoload] at launch; written here so the editor never has to add it (its own add_autoload_singleton respells the row as uid:// on later boots)',
        })
      }
      return { text: next, edits }
    },
    road,
  )
  if (!mutated.ok) {
    return `addon files staged under ${ADDON_DIR}/, but project.godot was NOT modified: ${mutated.conflict}`
  }
  ensureVulcanToken(projectRoot)
  const presence = await probeGodotEditorPresence(projectRoot, port, opts.census)
  const lines = [
    `installed ${VULCAN_ADDON_FILES.length} addon files under ${ADDON_DIR}/ (bundle ${VULCAN_ADDON_DIGEST.slice(0, 12)}…; ${written} written, ${VULCAN_ADDON_FILES.length - written} already current)${
      before.installed ? (before.digestMatch ? ' — already this version' : ' — refreshed an older copy') : ''
    }`,
    ...(mutated.receipts.length > 0
      ? mutated.receipts
      : ['project.godot: no change needed (plugin enabled, port aligned, autoload row present)']),
    `session token ready (${path.join('.godot', 'mercury-vulcan-token')})`,
    `editor: ${presence.words}`,
  ]
  if (presence.state === 'bridge-up') {
    const portChanged = mutated.edits.some(e => e.section === 'mercury_vulcan' && e.key === 'port')
    if (!before.digestMatch || portChanged) lines.push(await reloadPluginOverBridge(port))
    else lines.push('the running editor already serves this addon version — nothing to reload')
  } else {
    lines.push(`next: ${presenceNudge(presence, { installed: true, enabled: true })}`)
  }
  return lines.join('\n')
}

export async function applyVulcanUninstall(projectRoot: string, road: ChangeRecordRoad = {}): Promise<string> {
  const addonRoot = path.join(projectRoot, ADDON_DIR)
  const existed = existsSync(addonRoot)
  rmSync(addonRoot, { recursive: true, force: true })
  const mutated = await mutateProjectGodot(
    projectRoot,
    text => {
      const edits: ProjectGodotEdit[] = []
      let next = text
      const enabled = enabledPluginsFromText(next)
      if (enabled.includes(PLUGIN_CFG_RES)) {
        const list = enabled.filter(p => p !== PLUGIN_CFG_RES)
        next = withEnabledPlugins(next, list)
        edits.push({
          section: 'editor_plugins',
          key: 'enabled',
          previous: enabled.join(', '),
          ...(list.length > 0 ? { next: list.join(', ') } : { next: '(empty)' }),
          why: 'the plugin leaves the editor\'s enabled list',
        })
      }
      const row = runtimeAutoloadFromText(next)
      const stripped = withoutRuntimeAutoload(next)
      if (stripped.stripped) {
        next = stripped.text
        edits.push({
          section: 'autoload',
          key: RUNTIME_AUTOLOAD,
          ...(row !== undefined ? { previous: row } : {}),
          why: 'the play-mode bridge autoload would error-log on every editor boot and game launch once its script is gone',
        })
      }
      return { text: next, edits }
    },
    road,
  )
  rmSync(vulcanTokenPath(projectRoot), { force: true })
  if (!mutated.ok) {
    return `addon files deleted and token removed, but project.godot was NOT modified: ${mutated.conflict}`
  }
  const head = existed
    ? 'mercury_vulcan removed: addon files deleted, token file removed'
    : 'mercury_vulcan was not installed; token cleaned anyway'
  return [head, ...(mutated.receipts.length > 0 ? mutated.receipts : ['project.godot: no change needed'])].join('\n')
}

export async function describeVulcanStatus(projectRoot: string): Promise<string> {
  const s = vulcanInstallStatus(projectRoot)
  const port = vulcanPort()
  const census = await takeCensus()
  const presence = await probeGodotEditorPresence(projectRoot, port, census)
  const client = getVulcanClient()
  const lines = [
    `flag: ${vulcanEnabled() ? 'armed' : 'OFF'}${vulcanLiteMode() ? ' (lite subset)' : ''} · project: ${projectRoot}`,
    `addon: ${s.installed ? `installed${s.digestMatch ? ', matches the bundled version' : s.bundledFiles === 0 ? ' (bundle empty — dev build)' : ', DRIFTED from the bundle (vulcan_install refreshes)'}` : 'NOT installed (op:"vulcan_install")'} · plugin ${s.enabled ? 'enabled' : 'NOT enabled'}`,
    `token file: ${readVulcanToken(projectRoot) ? 'present' : 'absent (vulcan_install writes it)'}`,
    `editor: ${presence.words}${presence.state === 'bridge-up' ? ` — answering on 127.0.0.1:${port}` : ` — 127.0.0.1:${port} dark`}`,
  ]
  if (presence.state !== 'bridge-up') lines.push(`next: ${presenceNudge(presence, s)}`)
  lines.push(`client: ${client ? client.status() : 'unavailable'}`)
  const projPort = readProjectVulcanPort(projectRoot) ?? DEFAULT_VULCAN_PORT
  if (projPort !== port) {
    lines.push(`PORT MISMATCH: Mercury dials ${port} but the addon listens on ${projPort} (project setting mercury_vulcan/port) — op:"vulcan_install" aligns them`)
  }
  lines.push(`autoload row [autoload] ${RUNTIME_AUTOLOAD}: ${explainRuntimeAutoloadRow(readRuntimeAutoloadEntry(projectRoot), s.installed)}`)
  const { godotProviderInventory, renderProviderRows } = await import('./godotProviders.js')
  lines.push(...renderProviderRows(await godotProviderInventory(projectRoot, { census })).map(l => `provider ${l}`))
  const { godotPortabilityReport } = await import('./portabilityDoctor.js')
  const port2 = await godotPortabilityReport(projectRoot, { census: census.processes })
  lines.push(
    `godot executable: ${port2.executable.resolved ?? 'NOT FOUND'} (${port2.executable.source}: ${port2.executable.note}; ${port2.executable.probed.length} well-known roots walked)`,
  )
  const processes = describePresenceProcesses(presence)
  lines.push(
    processes.length === 0
      ? `godot processes: none seen${presence.censusOk ? '' : ' (process table unreadable)'}`
      : `godot processes: ${processes.length} — ${processes.slice(0, 4).join(' · ')}${processes.length > 4 ? ' · …' : ''}`,
  )
  const cache = classCacheReport(projectRoot, 5)
  lines.push(
    cache.state === 'fresh'
      ? `class cache: fresh (${cache.classTotal} global classes, ${cache.declaredTotal} class_name scripts)`
      : `class cache: ${cache.state.toUpperCase()} — ${cache.hint}`,
  )
  if (port2.absolutePaths.length > 0) {
    const first = port2.absolutePaths[0]!
    lines.push(`PORTABILITY: ${port2.absolutePaths.length} machine-absolute path(s) in project skills — e.g. ${first.skillFile}:${first.line} ${first.text} (skills are never rewritten; fix them for this machine or make them semantic)`)
  }
  for (const dsc of port2.controlDiscrepancies) {
    lines.push(`CONTROL DRIFT: ${dsc.skillFile} declares [${dsc.declaredNotLive.join(', ')}] not in project.godot [input]; live-but-undeclared: [${dsc.liveNotDeclared.join(', ')}]`)
  }
  if (!s.installed && readRuntimeAutoloadEntry(projectRoot) !== undefined) {
    lines.push(`DANGLING AUTOLOAD: project.godot still names ${RUNTIME_AUTOLOAD} with the addon gone — op:"vulcan_uninstall" strips it`)
  }
  return lines.join('\n')
}

export async function vulcanEditorPresence(projectRoot: string): Promise<GodotEditorPresence> {
  return probeGodotEditorPresence(projectRoot, vulcanPort())
}
