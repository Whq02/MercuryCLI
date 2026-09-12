#!/usr/bin/env bun

process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  delete process.env.MERCURY_GODOT_EXECUTABLE
  delete process.env.MERCURY_GODOT_TOOLS_LITE
}

const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const gates = await import('../../src/utils/vulcan/vulcanGates.js')
const { getVulcanClient, resetVulcanClientForTest } = await import('../../src/services/vulcan/vulcanClient.js')
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
const { _resetGodotExecutablePresenceForTesting: resetGodotPresence } = await import('../../src/services/vulcan/portabilityDoctor.js')
const godotBin = path.join(scratch, 'godot')
writeFileSync(godotBin, '#!/bin/sh\nexit 0\n')
chmodSync(godotBin, 0o755)

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
  check('NO instance files were created by any OFF path', !existsSync(path.join(proj, '.godot', 'mercury-vulcan')) && !existsSync(path.join(proj, '.godot', 'mercury-vulcan-token')))
}

section('§2 · ARMED — tool + seams')
{
  restoreEnv()
  resetVulcanClientForTest()
  process.env.MERCURY_GODOT_TOOLS = '1'
  process.env.MERCURY_GODOT_EXECUTABLE = godotBin
  resetGodotPresence()
  check('gate ON', gates.vulcanEnabled())
  check('Godot tool present inside a project', runWithCwdOverride(proj, () => hasGodot()))
  check('Godot tool present outside a project too (the flag seats it; the project is answered at call time)', runWithCwdOverride(scratch, () => hasGodot()))
  process.env.MERCURY_GODOT_EXECUTABLE = path.join(scratch, 'no-such-godot')
  resetGodotPresence()
  check('with no Godot executable on the machine the tool is withheld from the catalog, flag or no flag', runWithCwdOverride(proj, () => !hasGodot()))
  const withholding = gates.godotToolWithholding()
  check('…and the withholding names the pin that names no executable', withholding.withheld === true && withholding.why.includes('MERCURY_GODOT_EXECUTABLE') && withholding.remedy.length > 0, JSON.stringify(withholding))
  process.env.MERCURY_GODOT_EXECUTABLE = godotBin
  resetGodotPresence()
  check('the executable back, the tool is seated again', runWithCwdOverride(proj, () => hasGodot()))
  const outside = (await runWithCwdOverride(scratch, () => GodotTool.call({ op: 'vulcan_status' } as never, {} as never, {} as never, {} as never))) as { data: { result: string } }
  check('outside a project every op answers the teaching note, never a ghost surface', outside.data.result.includes('no project.godot found from the working directory'), outside.data.result.slice(0, 120))
  check('prompt section renders inside a project', runWithCwdOverride(proj, () => (gates.getVulcanSection() ?? '').includes('VULCAN')))
  check('prompt section null outside a project', runWithCwdOverride(scratch, () => gates.getVulcanSection() === null))
  check('doctrine line renders', runWithCwdOverride(proj, () => (gates.getVulcanDoctrineLine() ?? '').includes('Godot tool')))
  check('harness-map line renders (flag-gated)', (gates.getVulcanHarnessMapLine() ?? '').includes('ARMED'))
  check('a project without a discovered agent editor gets no implicit bridge client', runWithCwdOverride(proj, () => getVulcanClient() === null))
  check('no fixed bridge port and no shared token seam remain: every instance carries its own', !('vulcanPort' in gates) && !('vulcanTokenOverride' in gates) && !('VULCAN_DEFAULT_PORT' in gates))
  check('arming writes no instance files into the project', !existsSync(path.join(proj, '.godot', 'mercury-vulcan')) && !existsSync(path.join(proj, '.godot', 'mercury-vulcan-token')))
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
  const report = await installer.applyVulcanInstall(p2)
  const st = installer.vulcanInstallStatus(p2)
  check('install materializes the full bundle', report.includes(`installed ${st.bundledFiles} addon files`) && st.bundledFiles > 0 && existsSync(path.join(p2, 'addons', 'mercury_vulcan', 'plugin.cfg')) && existsSync(path.join(p2, 'addons', 'mercury_vulcan', 'core', 'server.gd')))
  check('install enables the plugin and preserves the other entry without a shared token', st.installed && st.digestMatch && st.enabled && installer.readEnabledPlugins(p2).includes('res://addons/other/plugin.cfg') && !existsSync(path.join(p2, '.godot', 'mercury-vulcan-token')))
  writeFileSync(path.join(p2, 'addons', 'mercury_vulcan', 'core', 'server.gd'), '# tampered\n')
  check('tamper flips digestMatch (status stays honest)', (() => {
    const t = installer.vulcanInstallStatus(p2)
    return t.installed && !t.digestMatch
  })())
  check('reinstall refreshes a drifted tree', (await installer.applyVulcanInstall(p2)).includes('addon files') && installer.vulcanInstallStatus(p2).digestMatch)
  writeFileSync(
    path.join(p2, 'project.godot'),
    readFileSync(path.join(p2, 'project.godot'), 'utf8') +
      '\n[autoload]\n\nGameState="*res://autoload/game_state.gd"\nMercuryVulcanRuntimeBridge="*res://addons/mercury_vulcan/core/runtime_bridge.gd"\n',
  )
  check('autoload entry readable while present', installer.readRuntimeAutoloadEntry(p2) !== undefined)
  const cleaned = await installer.applyVulcanUninstall(p2)
  check('uninstall removes files + entry + token, preserves the OTHER plugin entry', cleaned.includes('removed') && !existsSync(path.join(p2, 'addons', 'mercury_vulcan')) && !existsSync(path.join(p2, '.godot', 'mercury-vulcan-token')) && installer.readEnabledPlugins(p2).includes('res://addons/other/plugin.cfg') && !installer.vulcanInstallStatus(p2).enabled)
  check('uninstall strips the bridge autoload (receipted), preserves the OTHER autoload', cleaned.includes('[autoload] MercuryVulcanRuntimeBridge') && cleaned.includes('→ (removed)') && installer.readRuntimeAutoloadEntry(p2) === undefined && readFileSync(path.join(p2, 'project.godot'), 'utf8').includes('GameState="*res://autoload/game_state.gd"'))
  check('uninstall on a clean project stays honest', (await installer.applyVulcanUninstall(p2)).includes('was not installed'))
  await installer.applyVulcanInstall(p2)
  check('install never writes a shared fixed-port setting', !/^port=/m.test(readFileSync(path.join(p2, 'project.godot'), 'utf8')))
  await installer.applyVulcanUninstall(p2)
}

section('§6 · flag registry rows')
{
  const master = getFlagSpec('MERCURY_GODOT_TOOLS')
  check('MERCURY_GODOT_TOOLS registered opt-in/behavioral', master?.kind === 'opt-in' && master?.tier === 'behavioral')
  check('the retired fixed-port and shared-token rows are gone', getFlagSpec('MERCURY_GODOT_TOOLS_PORT') === undefined && getFlagSpec('MERCURY_GODOT_TOOLS_TOKEN') === undefined)
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
    buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-general' } }).join('\n')
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
