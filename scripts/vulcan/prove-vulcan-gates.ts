#!/usr/bin/env bun
// ============================================================================
//  scripts/vulcan/prove-vulcan-gates.ts
//  PROOF: VULCAN's gate polarity + byte-identical-OFF contract, the tool's
//  catalog/permission surface, lite mode, token hygiene, and the installer's
//  honesty on a fixture project. Deterministic — no editor, no sockets.
//
//   §1 OFF (default): no `Godot` in the catalog even inside a Godot project;
//      every behavioral seam (prompt section, doctrine line, harness-map
//      line) is null; no client; NO token file is ever created.
//   §2 ARMED: tool present inside a project (absent outside), seams render,
//      client exists; token file created 0600, stable, env-override wins.
//   §3 LITE: the advertised catalog shrinks to the 76-op core; a non-lite op
//      answers with the teaching refusal BEFORE any wire activity.
//   §4 PERMISSIONS: read ⇒ allow; mutate ⇒ ask (undo-step message); exec ⇒
//      ask (runs-code message); isReadOnly mirrors the optable class.
//   §5 INSTALLER: install materializes the full bundle + enables the plugin
//      (preserving other entries); status is honest incl. digest flip on
//      tamper + refresh-on-reinstall; uninstall reverts files/entry/token.
//   §6 REGISTRY: the four flags are registered with the right kinds/tiers.
// ============================================================================

import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const savedEnv = { ...process.env }
function restoreEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
  delete process.env.MERCURY_GODOT_TOOLS
  delete process.env.MERCURY_GODOT_TOOLS_LITE
  delete process.env.MERCURY_GODOT_TOOLS_PORT
  delete process.env.MERCURY_GODOT_TOOLS_TOKEN
}

const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const gates = await import('../../src/utils/vulcan/vulcanGates.js')
const { getVulcanClient, resetVulcanClientForTest } = await import('../../src/services/vulcan/vulcanClient.js')
const { ensureVulcanToken, readVulcanToken, vulcanTokenPath } = await import('../../src/services/vulcan/vulcanToken.js')
const installer = await import('../../src/services/vulcan/addonInstaller.js')
const { getAllBaseTools } = await import('../../src/tools.js')
const { GodotTool } = await import('../../src/tools/GodotTool/GodotTool.js')
const { getGodotToolDescription } = await import('../../src/tools/GodotTool/prompt.js')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'vulcan-gates-'))
const proj = path.join(scratch, 'game')
mkdirSync(proj, { recursive: true })
writeFileSync(
  path.join(proj, 'project.godot'),
  '[application]\n\nconfig/name="fixture"\n',
)
const hasGodot = () => getAllBaseTools().some(t => t.name === 'Godot')

section('§1 · OFF (default) — byte-identical absence')
{
  restoreEnv()
  resetVulcanClientForTest()
  check('gate OFF by default', !gates.vulcanEnabled())
  check('no Godot tool in the catalog even inside a project', runWithCwdOverride(proj, () => !hasGodot()))
  check('prompt section null', gates.getVulcanSection() === null)
  check('doctrine line null', gates.getVulcanDoctrineLine() === null)
  check('harness-map line null', gates.getVulcanHarnessMapLine() === null)
  check('no client', runWithCwdOverride(proj, () => getVulcanClient() === null))
  check('NO token file was created by any OFF path', !existsSync(vulcanTokenPath(proj)))
}

section('§2 · ARMED — tool + seams + token hygiene')
{
  restoreEnv()
  resetVulcanClientForTest()
  process.env.MERCURY_GODOT_TOOLS = '1'
  check('gate ON', gates.vulcanEnabled())
  check('Godot tool present inside a project', runWithCwdOverride(proj, () => hasGodot()))
  check('Godot tool absent outside a project', runWithCwdOverride(scratch, () => !hasGodot()))
  check('prompt section renders inside a project', runWithCwdOverride(proj, () => (gates.getVulcanSection() ?? '').includes('VULCAN')))
  check('prompt section null outside a project', runWithCwdOverride(scratch, () => gates.getVulcanSection() === null))
  check('doctrine line renders', runWithCwdOverride(proj, () => (gates.getVulcanDoctrineLine() ?? '').includes('Godot tool')))
  check('harness-map line renders (flag-gated)', (gates.getVulcanHarnessMapLine() ?? '').includes('ARMED'))
  check('client exists inside a project', runWithCwdOverride(proj, () => getVulcanClient() !== null))
  const tok1 = ensureVulcanToken(proj)
  const tok2 = ensureVulcanToken(proj)
  check('token created 64-hex + stable', /^[0-9a-f]{64}$/.test(tok1) && tok1 === tok2)
  const mode = statSync(vulcanTokenPath(proj)).mode & 0o777
  check('token file mode 0600', mode === 0o600, `0${mode.toString(8)}`)
  process.env.MERCURY_GODOT_TOOLS_TOKEN = 'override-token'
  check('env override wins (read + ensure)', ensureVulcanToken(proj) === 'override-token' && readVulcanToken(proj) === 'override-token')
  delete process.env.MERCURY_GODOT_TOOLS_TOKEN
  check('port default 6010 + validated override', gates.vulcanPort() === 6010 && (() => {
    process.env.MERCURY_GODOT_TOOLS_PORT = '7011'
    const ok = gates.vulcanPort() === 7011
    process.env.MERCURY_GODOT_TOOLS_PORT = 'nope'
    const fallback = gates.vulcanPort() === 6010
    delete process.env.MERCURY_GODOT_TOOLS_PORT
    return ok && fallback
  })())
}

section('§3 · LITE — the advertised surface shrinks; refusal teaches')
{
  restoreEnv()
  resetVulcanClientForTest()
  process.env.MERCURY_GODOT_TOOLS = '1'
  const full = getGodotToolDescription()
  check('full surface advertises a non-lite op', full.includes('animtree_create'))
  process.env.MERCURY_GODOT_TOOLS_LITE = '1'
  const lite = getGodotToolDescription()
  check('lite hides the non-lite op, keeps the core', !lite.includes('animtree_create') && lite.includes('node_add'))
  check('lite says so', lite.includes('LITE MODE'))
  const refused = (await GodotTool.call({ op: 'animtree_create', args: {} } as never, {} as never)) as {
    data: { result: string }
  }
  check('non-lite op refused with teaching (no wire)', refused.data.result.includes('lite subset'))
  delete process.env.MERCURY_GODOT_TOOLS_LITE
  const unknown = (await GodotTool.call({ op: 'made_up_op' } as never, {} as never)) as {
    data: { result: string }
  }
  check('unknown op teaches the categories', unknown.data.result.includes('unknown op') && unknown.data.result.includes('project'))
}

section('§4 · permission classes')
{
  restoreEnv()
  process.env.MERCURY_GODOT_TOOLS = '1'
  const read = await GodotTool.checkPermissions!({ op: 'scene_tree' } as never, {} as never, {} as never)
  check('read ⇒ allow', (read as { behavior: string }).behavior === 'allow')
  const mut = await GodotTool.checkPermissions!({ op: 'node_add', args: { parent: '.', type: 'Node2D' } } as never, {} as never, {} as never)
  check('mutate ⇒ ask naming the undo step', (mut as { behavior: string; message?: string }).behavior === 'ask' && /undo step/.test((mut as { message?: string }).message ?? ''))
  const exec = await GodotTool.checkPermissions!({ op: 'scene_play' } as never, {} as never, {} as never)
  check('exec ⇒ ask naming runs-code', (exec as { behavior: string; message?: string }).behavior === 'ask' && /runs code/.test((exec as { message?: string }).message ?? ''))
  check('isReadOnly mirrors the optable', GodotTool.isReadOnly!({ op: 'scene_tree' } as never) === true && GodotTool.isReadOnly!({ op: 'node_add' } as never) === false && GodotTool.isReadOnly!({ op: 'scene_play' } as never) === false)
}

section('§5 · installer honesty on a fixture project')
{
  restoreEnv()
  process.env.MERCURY_GODOT_TOOLS = '1'
  const p2 = path.join(scratch, 'game2')
  mkdirSync(p2, { recursive: true })
  writeFileSync(
    path.join(p2, 'project.godot'),
    '[application]\n\nconfig/name="two"\n\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/other/plugin.cfg")\n',
  )
  check('pre-install status: not installed, enabled parsing sees the other plugin only', (() => {
    const s = installer.vulcanInstallStatus(p2)
    return !s.installed && !s.enabled && installer.readEnabledPlugins(p2).length === 1
  })())
  const report = installer.applyVulcanInstall(p2)
  const st = installer.vulcanInstallStatus(p2)
  check('install materializes the full bundle', report.includes(`installed ${st.bundledFiles} addon files`) && st.bundledFiles > 0 && existsSync(path.join(p2, 'addons', 'mercury_vulcan', 'plugin.cfg')) && existsSync(path.join(p2, 'addons', 'mercury_vulcan', 'core', 'server.gd')))
  check('install enables the plugin, preserves the OTHER entry, writes the token', st.installed && st.digestMatch && st.enabled && installer.readEnabledPlugins(p2).includes('res://addons/other/plugin.cfg') && existsSync(vulcanTokenPath(p2)))
  writeFileSync(path.join(p2, 'addons', 'mercury_vulcan', 'core', 'server.gd'), '# tampered\n')
  check('tamper flips digestMatch (status stays honest)', (() => {
    const t = installer.vulcanInstallStatus(p2)
    return t.installed && !t.digestMatch
  })())
  check('reinstall refreshes a drifted tree', installer.applyVulcanInstall(p2).includes('addon files') && installer.vulcanInstallStatus(p2).digestMatch)
  // The editor persists the bridge autoload into [autoload]; uninstall must
  // strip it (dangling entries error-log on every editor boot + game launch)
  // while leaving foreign autoloads alone.
  writeFileSync(
    path.join(p2, 'project.godot'),
    readFileSync(path.join(p2, 'project.godot'), 'utf8') +
      '\n[autoload]\n\nGameState="*res://autoload/game_state.gd"\nMercuryVulcanRuntimeBridge="*res://addons/mercury_vulcan/core/runtime_bridge.gd"\n',
  )
  check('autoload entry readable while present', installer.readRuntimeAutoloadEntry(p2) !== undefined)
  const cleaned = installer.applyVulcanUninstall(p2)
  check('uninstall removes files + entry + token, preserves the OTHER plugin entry', cleaned.includes('removed') && !existsSync(path.join(p2, 'addons', 'mercury_vulcan')) && !existsSync(vulcanTokenPath(p2)) && installer.readEnabledPlugins(p2).includes('res://addons/other/plugin.cfg') && !installer.vulcanInstallStatus(p2).enabled)
  check('uninstall strips the bridge autoload, preserves the OTHER autoload', cleaned.includes('autoload entry stripped') && installer.readRuntimeAutoloadEntry(p2) === undefined && readFileSync(path.join(p2, 'project.godot'), 'utf8').includes('GameState="*res://autoload/game_state.gd"'))
  check('uninstall on a clean project stays honest', installer.applyVulcanUninstall(p2).includes('was not installed'))
  // A non-default env port must reach the ADDON's project setting on install
  // (MERCURY_GODOT_TOOLS_PORT steers only the Mercury client otherwise).
  process.env.MERCURY_GODOT_TOOLS_PORT = '6011'
  installer.applyVulcanInstall(p2)
  check('install aligns mercury_vulcan/port with the env port', installer.readProjectVulcanPort(p2) === 6011)
  installer.applyVulcanUninstall(p2)
  delete process.env.MERCURY_GODOT_TOOLS_PORT
}

section('§6 · flag registry rows')
{
  const master = getFlagSpec('MERCURY_GODOT_TOOLS')
  check('MERCURY_GODOT_TOOLS registered opt-in/behavioral', master?.kind === 'opt-in' && master?.tier === 'behavioral')
  check('PORT/TOKEN value rows', getFlagSpec('MERCURY_GODOT_TOOLS_PORT')?.kind === 'value' && getFlagSpec('MERCURY_GODOT_TOOLS_TOKEN')?.kind === 'value')
  check('LITE opt-in/infra row', getFlagSpec('MERCURY_GODOT_TOOLS_LITE')?.kind === 'opt-in' && getFlagSpec('MERCURY_GODOT_TOOLS_LITE')?.tier === 'infra')
}

section('§7 · behavioral seams — harness map, doctrine, boot menu, doctor, prompt splice')
{
  restoreEnv()
  const { computeHarnessMapLines, resetHarnessMapForTest } = await import('../../src/utils/cockpit/harnessMap.js')
  resetHarnessMapForTest()
  check('harness map: no VULCAN line when off', !computeHarnessMapLines().some(l => l.includes('VULCAN')))
  process.env.MERCURY_GODOT_TOOLS = '1'
  resetHarnessMapForTest()
  check('harness map: VULCAN line when armed (delta machinery sees the flip)', computeHarnessMapLines().some(l => l.includes('VULCAN') && l.includes('ARMED')))

  const { buildSubagentMercurySections } = await import('../../src/constants/subagentDoctrine.js')
  const doctrine = () =>
    buildSubagentMercurySections({ agentDefinition: { agentType: 'general-purpose' } }).join('\n')
  const armedDoctrine = runWithCwdOverride(proj, doctrine)
  check('subagent doctrine: VULCAN line when armed + project', armedDoctrine.includes('VULCAN'))
  delete process.env.MERCURY_GODOT_TOOLS
  const offDoctrine = runWithCwdOverride(proj, doctrine)
  check('subagent doctrine: absent when off', !offDoctrine.includes('VULCAN'))

  const { STARTUP_MENU } = await import('../../src/substrate/startupMenu.js')
  const vulcanRow = STARTUP_MENU.find(r => r.env === 'MERCURY_GODOT_TOOLS')
  const lanesRow = STARTUP_MENU.find(r => r.env === 'MERCURY_GODOT')
  check('boot menu: VULCAN row in miscellaneous with detail', vulcanRow?.group === 'miscellaneous' && (vulcanRow?.detail?.controls ?? '').length > 100)
  check('boot menu: Godot lanes row moved to miscellaneous', lanesRow?.group === 'miscellaneous')

  const repo = path.join(import.meta.dir, '..', '..')
  const doctorSrc = readFileSync(path.join(repo, 'src/utils/healthReport.ts'), 'utf8')
  check("doctor: the 'vulcan' check is wired", doctorSrc.includes("id: 'vulcan'") && doctorSrc.includes('vulcanInstallStatus'))
  const promptsSrc = readFileSync(path.join(repo, 'src/constants/prompts.ts'), 'utf8')
  check('prompt: getVulcanSection spliced into modeSections', promptsSrc.includes('getVulcanSection()'))
  const harnessSrc = readFileSync(path.join(repo, 'src/utils/cockpit/harnessMap.ts'), 'utf8')
  check('harness map: line wired via the gate module', harnessSrc.includes('getVulcanHarnessMapLine()'))
}

restoreEnv()
console.log('\n' + (failures === 0 ? '✅ vulcan gates proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
