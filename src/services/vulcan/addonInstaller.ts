// ============================================================================
//  addonInstaller — materializes the bundled mercury_vulcan editor addon into
//  a Godot project (VULCAN; the Mercury-side halves of vulcan_install /
//  vulcan_uninstall / vulcan_status — the Godot tool routes those ops here,
//  they never reach the wire). All writes are plain fs through the tool's
//  permissioned call (install/uninstall are mutate-class asks).
// ============================================================================

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { renameWithWin32RetrySync } from '../../substrate/durablePublish.js'
import * as path from 'node:path'
import { godotEditorHint } from '../lsp/godotLane.js'
import { vulcanEnabled, vulcanLiteMode, vulcanPort } from '../../utils/vulcan/vulcanGates.js'
import { probeGodotEditorReachable } from '../lsp/godotLane.js'
import { VULCAN_ADDON_DIGEST, VULCAN_ADDON_FILES } from './addonFiles.generated.js'
import { getVulcanClient } from './vulcanClient.js'
import { ensureVulcanToken, readVulcanToken, vulcanTokenPath } from './vulcanToken.js'

const ADDON_DIR = path.join('addons', 'mercury_vulcan')
const PLUGIN_CFG_RES = 'res://addons/mercury_vulcan/plugin.cfg'
const RUNTIME_AUTOLOAD = 'MercuryVulcanRuntimeBridge'
const DEFAULT_VULCAN_PORT = 6010

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

// ── project.godot [editor_plugins] handling (minimal, format-preserving) ─────

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

// ──: the ONE fenced project.godot mutation seam ────────
// project.godot is EDITOR-OWNED config: the editor may save it at any moment.
// The old flow ran up to three separate whole-file read-modify-write cycles
// per install — any editor save landing between a read and its write was
// silently clobbered (or clobbered us). All mutations now go through ONE
// seam: read ONCE, transform in memory (section-preserving, format-
// preserving), and publish ATOMICALLY (tmp + rename) only after a content-
// identity re-check; a concurrent external change triggers a bounded
// re-read + re-merge (decisions re-derive from the FRESH text), and
// exhaustion yields an exact conflict receipt with NO partial state.
const GODOT_MUTATION_ATTEMPTS = 3

export function mutateProjectGodot(
  projectRoot: string,
  mutate: (text: string) => { text: string; notes: string[] },
): { ok: true; notes: string[] } | { ok: false; conflict: string } {
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
      return { ok: true, notes: out.notes }
    }
    const tmp = `${file}.mercury-tmp-${process.pid}-${attempt}`
    writeFileSync(tmp, out.text)
    // Content-identity fence (never mtime): if the editor saved between our
    // read and now, discard the merge and re-derive from the fresh text.
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
        /* best effort */
      }
      continue
    }
    // Bounded win32 retry: the Godot EDITOR holds project.godot
    // open on Windows — exactly the transient EPERM class. The content fence
    // above already proved the destination unchanged; a persistent lock
    // still surfaces as the conflict result below.
    renameWithWin32RetrySync(tmp, file)
    return { ok: true, notes: out.notes }
  }
  return {
    ok: false,
    conflict:
      'project.godot kept changing under concurrent edits (is the editor saving?) — no partial write was made; retry when the editor is idle',
  }
}

// ── project.godot section helpers (autoload + mercury_vulcan/port) ──────────
// project.godot is INI-shaped: a setting "autoload/X" lives under [autoload]
// as X="…", "mercury_vulcan/port" under [mercury_vulcan] as port=….

function sectionSpan(text: string, section: string): [number, number] | null {
  const m = new RegExp(`\\[${section}\\]`).exec(text)
  if (!m) return null
  const start = m.index + m[0].length
  const rest = text.slice(start).search(/\n\[[^\]]+\]/)
  return [start, rest === -1 ? text.length : start + rest]
}

/** The persisted play-mode-bridge autoload entry, if project.godot carries one. */
export function readRuntimeAutoloadEntry(projectRoot: string): string | undefined {
  let text: string
  try {
    text = readFileSync(projectGodotPath(projectRoot), 'utf8')
  } catch {
    return undefined
  }
  const span = sectionSpan(text, 'autoload')
  if (!span) return undefined
  const m = text.slice(span[0], span[1]).match(new RegExp(`^${RUNTIME_AUTOLOAD}=(.*)$`, 'm'))
  return m ? m[1] : undefined
}

// plugin.gd's add_autoload_singleton persists the bridge into [autoload]; when
// the editor is not running during uninstall, nothing removes it — a dangling
// entry error-logs on every subsequent editor boot AND game launch.
// Pure transform: mutation happens only through mutateProjectGodot.
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

/** The port the ADDON will listen on (project setting; addon default 6010). */
export function readProjectVulcanPort(projectRoot: string): number | undefined {
  let text: string
  try {
    text = readFileSync(projectGodotPath(projectRoot), 'utf8')
  } catch {
    return undefined
  }
  const span = sectionSpan(text, 'mercury_vulcan')
  if (!span) return undefined
  const m = text.slice(span[0], span[1]).match(/^port=(\d+)$/m)
  return m ? Number(m[1]) : undefined
}

// MERCURY_GODOT_TOOLS_PORT steers only the Mercury client; the addon listens on
// the mercury_vulcan/port PROJECT SETTING — install aligns the two halves.
// Pure transforms: mutation happens only through mutateProjectGodot.
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

// ── install / uninstall / status ─────────────────────────────────────────────

export function applyVulcanInstall(projectRoot: string): string {
  if (VULCAN_ADDON_FILES.length === 0) {
    return 'the addon bundle is empty (a dev build before regen-addon ran) — run: node scripts/vulcan/regen-addon.mjs and rebuild'
  }
  const addonRoot = path.join(projectRoot, ADDON_DIR)
  for (const f of VULCAN_ADDON_FILES) {
    const target = path.join(addonRoot, f.path)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, f.content)
  }
  // ONE fenced mutation — both decisions re-derive
  // from the text the mutator receives, so a re-merge after a concurrent
  // editor save decides against the FRESH content.
  const port = vulcanPort()
  let enableNote = 'already enabled'
  let portNote = ''
  const mutated = mutateProjectGodot(projectRoot, text => {
    const notes: string[] = []
    let next = text
    const enabled = enabledPluginsFromText(next)
    if (!enabled.includes(PLUGIN_CFG_RES)) {
      next = withEnabledPlugins(next, [...enabled, PLUGIN_CFG_RES])
      notes.push('enabled')
    }
    if (port !== (vulcanPortFromText(next) ?? DEFAULT_VULCAN_PORT)) {
      next = withVulcanPort(next, port)
      notes.push('port')
    }
    return { text: next, notes }
  })
  if (!mutated.ok) {
    return `addon files staged under ${ADDON_DIR}/, but project.godot was NOT modified: ${mutated.conflict}`
  }
  if (mutated.notes.includes('enabled')) enableNote = 'enabled in project.godot'
  if (mutated.notes.includes('port')) {
    portNote = `; mercury_vulcan/port set to ${port} (matches MERCURY_GODOT_TOOLS_PORT)`
  }
  ensureVulcanToken(projectRoot)
  return [
    `installed ${VULCAN_ADDON_FILES.length} addon files under ${ADDON_DIR}/ (bundle ${VULCAN_ADDON_DIGEST.slice(0, 12)}…)`,
    `plugin ${enableNote}; session token ready (${path.join('.godot', 'mercury-vulcan-token')})${portNote}`,
    `the editor picks the plugin up on focus/restart — then op:"vulcan_status" should report it reachable on 127.0.0.1:${port}`,
  ].join('\n')
}

export function applyVulcanUninstall(projectRoot: string): string {
  const addonRoot = path.join(projectRoot, ADDON_DIR)
  const existed = existsSync(addonRoot)
  rmSync(addonRoot, { recursive: true, force: true })
  // ONE fenced mutation covers plugin-disable AND the
  // autoload strip (the old flow was two separate RMW cycles).
  const mutated = mutateProjectGodot(projectRoot, text => {
    const notes: string[] = []
    let next = text
    const enabled = enabledPluginsFromText(next)
    if (enabled.includes(PLUGIN_CFG_RES)) {
      next = withEnabledPlugins(next, enabled.filter(p => p !== PLUGIN_CFG_RES))
    }
    const stripped = withoutRuntimeAutoload(next)
    if (stripped.stripped) {
      next = stripped.text
      notes.push('autoload')
    }
    return { text: next, notes }
  })
  rmSync(vulcanTokenPath(projectRoot), { force: true })
  if (!mutated.ok) {
    return `addon files deleted and token removed, but project.godot was NOT modified: ${mutated.conflict}`
  }
  const autoloadNote = mutated.notes.includes('autoload') ? ', runtime-bridge autoload entry stripped' : ''
  return existed
    ? `mercury_vulcan removed: addon files deleted, plugin disabled, token file removed${autoloadNote}`
    : `mercury_vulcan was not installed; plugin entry + token cleaned anyway${autoloadNote}`
}

export async function describeVulcanStatus(projectRoot: string): Promise<string> {
  const s = vulcanInstallStatus(projectRoot)
  const port = vulcanPort()
  const reachable = await probeGodotEditorReachable(port)
  const client = getVulcanClient()
  const lines = [
    `flag: ${vulcanEnabled() ? 'armed' : 'OFF'}${vulcanLiteMode() ? ' (lite subset)' : ''} · project: ${projectRoot}`,
    `addon: ${s.installed ? `installed${s.digestMatch ? ', matches the bundled version' : s.bundledFiles === 0 ? ' (bundle empty — dev build)' : ', DRIFTED from the bundle (vulcan_install refreshes)'}` : 'NOT installed (op:"vulcan_install")'} · plugin ${s.enabled ? 'enabled' : 'NOT enabled'}`,
    `token file: ${readVulcanToken(projectRoot) ? 'present' : 'absent (vulcan_install writes it)'}`,
    `editor: ${reachable ? `answering on 127.0.0.1:${port}` : `not answering on 127.0.0.1:${port} — ${godotEditorHint(port)}`}`,
    `client: ${client ? client.status() : 'unavailable'}`,
  ]
  const projPort = readProjectVulcanPort(projectRoot) ?? DEFAULT_VULCAN_PORT
  if (projPort !== port) {
    lines.push(`PORT MISMATCH: Mercury dials ${port} but the addon listens on ${projPort} (project setting mercury_vulcan/port) — op:"vulcan_install" aligns them`)
  }
  // the typed provider inventory — one line per
  // provider identity; one provider dark says nothing about another.
  const { godotProviderInventory, renderProviderRows } = await import('./godotProviders.js')
  lines.push(...renderProviderRows(await godotProviderInventory(projectRoot)).map(l => `provider ${l}`))
  // skill portability — absolute machine paths and
  // control-table drift are REPORTED (never rewritten); the executable
  // resolution carries its receipt.
  const { godotPortabilityReport } = await import('./portabilityDoctor.js')
  const port2 = godotPortabilityReport(projectRoot)
  lines.push(`godot executable: ${port2.executable.resolved ?? 'NOT FOUND'} (${port2.executable.note})`)
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
