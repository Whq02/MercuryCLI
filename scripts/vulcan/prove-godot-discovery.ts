#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'godot-disc-home-'))
process.env.MERCURY_GODOT_TOOLS = '1'
process.env.MERCURY_GODOT_TOOLS_PORT = String(29000 + (process.pid % 900))
delete process.env.MERCURY_GODOT
delete process.env.MERCURY_GODOT_TOOLS_LITE

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const census = await import(join(ROOT, 'src/services/vulcan/godotProcessCensus.ts'))
const doctor = await import(join(ROOT, 'src/services/vulcan/portabilityDoctor.ts'))
const presence = await import(join(ROOT, 'src/services/vulcan/editorPresence.ts'))
const classCache = await import(join(ROOT, 'src/services/vulcan/classCache.ts'))
const installer = await import(join(ROOT, 'src/services/vulcan/addonInstaller.ts'))
const capsule = await import(join(ROOT, 'src/services/vulcan/godotCapsule.ts'))
const providers = await import(join(ROOT, 'src/services/vulcan/godotProviders.ts'))
const optable = await import(join(ROOT, 'src/utils/vulcan/optable.generated.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail.slice(0, 200) : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Godot discovery — census · executable · presence · class cache · receipts')
console.log('============================================================')

const scratch = mkdtempSync(join(tmpdir(), 'godot-disc-'))
try {
  section('1. the process census — one owner, fixed argv, pure parsers')
  const MAC_APP = '/Users/sam/Downloads/Godot 2.app/Contents/MacOS/Godot'
  const MAC_PROJ = '/Users/sam/Projects/My Game'
  const darwin = census.parseDarwinCensus(
    ['  310 /usr/libexec/logd', `41230 ${MAC_APP}`, `41299 ${MAC_APP}`, '  500 /Applications/Visual Studio Code.app/Contents/MacOS/Electron', ''].join('\n'),
    [
      '  310 /usr/libexec/logd',
      `41230 ${MAC_APP} --editor --headless --path ${MAC_PROJ}`,
      `41299 ${MAC_APP} --path ${MAC_PROJ} --remote-debug tcp://127.0.0.1:6007 res://main.tscn`,
      '  500 /Applications/Visual Studio Code.app/Contents/MacOS/Electron --type=renderer',
    ].join('\n'),
  )
  check('darwin: the two Godot rows and only those', darwin.length === 2 && darwin.every((p: { executable: string }) => p.executable === MAC_APP), JSON.stringify(darwin.map((p: { pid: number }) => p.pid)))
  const macEditor = darwin.find((p: { pid: number }) => p.pid === 41230)!
  check('darwin: an app-bundle path with a SPACE survives (comm joined with args by prefix)', macEditor.executable === MAC_APP && macEditor.args.startsWith('--editor'))
  check('darwin: editor + headless flags and the --path project parsed', macEditor.editor === true && macEditor.headless === true && macEditor.project === MAC_PROJ, `${macEditor.project}`)
  const macPlay = darwin.find((p: { pid: number }) => p.pid === 41299)!
  check('darwin: the play child is not an editor but names its project', macPlay.editor === false && macPlay.project === MAC_PROJ)

  const linux = census.parseLinuxCensus(
    ['    1 /sbin/init', ' 2222 godot4 --editor --path /home/sam/game', ' 2300 /usr/bin/python3 godot-fake.py', ''].join('\n'),
    (pid: number) => (pid === 2222 ? '/home/sam/.local/bin/godot4.linuxbsd.editor.x86_64' : undefined),
  )
  check('linux: argv[0] names godot, /proc/<pid>/exe gives the real executable', linux.length === 1 && linux[0].executable === '/home/sam/.local/bin/godot4.linuxbsd.editor.x86_64' && linux[0].project === '/home/sam/game' && linux[0].editor, JSON.stringify(linux))

  const WIN_EXE = 'C:\\Users\\sam\\AppData\\Local\\Programs\\Godot\\Godot_v4.7.2-stable_mono_win64.exe'
  const win = census.parseWin32Census(
    [
      `18344|${WIN_EXE}|"${WIN_EXE}" --path "C:\\Users\\sam\\Projects\\My Game" --editor`,
      '20|C:\\Windows\\System32\\svchost.exe|svchost.exe -k netsvcs',
      '',
    ].join('\r\n'),
  )
  check('win32: the CIM row parses pid · ExecutablePath · quoted --path project · --editor', win.length === 1 && win[0].pid === 18344 && win[0].executable === WIN_EXE && win[0].project === 'C:\\Users\\sam\\Projects\\My Game' && win[0].editor && !win[0].headless, JSON.stringify(win))
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const cmds = census.censusCommands(platform)
    check(`${platform}: every table read is an argv array with no path or pid spliced in`, cmds.length >= 1 && cmds.every((c: { file: string; args: string[] }) => Array.isArray(c.args) && !c.args.some((a: string) => /[/\\]Users|\d{3,}/.test(a) && !a.includes('ProcessId'))))
  }
  check('win32: the CIM filter is fixed to godot% (no interpolation)', census.censusCommands('win32')[0].args.some((a: string) => a.includes("Name LIKE 'godot%'")))
  check('identity: Godot / godot4 / versioned mono / steam builds / the flatpak export; never godot-lsp', ['Godot', 'godot4.exe', 'Godot_v4.7.2-stable_mono_win64.exe', 'godot.windows.editor.x86_64.exe', 'org.godotengine.Godot'].every(census.isGodotExecutable) && !census.isGodotExecutable('godot-lsp'))
  check('editorsForProject: --path identity is separator- and case-tolerant on win32', census.editorsForProject(win, 'c:/users/sam/projects/my game', 'win32').length === 1 && census.editorsForProject(win, 'C:\\Users\\sam\\Other', 'win32').length === 0)

  section('2. the executable receipt — a running editor is never NOT FOUND')
  const winEnv = { LOCALAPPDATA: 'C:\\Users\\sam\\AppData\\Local', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', USERPROFILE: 'C:\\Users\\sam', ProgramData: 'C:\\ProgramData', PATH: 'C:\\Windows\\System32' }
  const winRoots: string[] = doctor.godotWellKnownRoots('win32', winEnv)
  check('win32 roots: %LOCALAPPDATA%\\Programs\\Godot, Program Files, the Steam library, the winget and scoop shims', ['C:\\Users\\sam\\AppData\\Local\\Programs\\Godot', 'C:\\Program Files\\Godot', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Godot Engine', 'C:\\Users\\sam\\AppData\\Local\\Microsoft\\WinGet\\Links', 'C:\\Users\\sam\\scoop\\shims'].every(r => winRoots.includes(r)), winRoots.join(' | '))
  const macRoots: string[] = doctor.godotWellKnownRoots('darwin', { HOME: '/Users/sam' })
  check('darwin roots: /Applications, ~/Applications, the Steam library', ['/Applications', '/Users/sam/Applications', '/Users/sam/Library/Application Support/Steam/steamapps/common/Godot Engine'].every(r => macRoots.includes(r)))
  const linuxRoots: string[] = doctor.godotWellKnownRoots('linux', { HOME: '/home/sam' })
  check('linux roots: the PATH bins, flatpak exports, the Steam library', ['/usr/bin', '/var/lib/flatpak/exports/bin', '/home/sam/.local/share/Steam/steamapps/common/Godot Engine'].every(r => linuxRoots.includes(r)))

  const tree: Record<string, string[]> = {
    'C:\\Users\\sam\\AppData\\Local\\Programs\\Godot': ['Godot_v4.7.2-stable_mono_win64.exe', 'Godot_v4.7.2-stable_mono_win64_console.exe', 'GodotSharp'],
    'C:\\Users\\sam\\AppData\\Local\\Microsoft\\WinGet\\Packages': ['GodotEngine.GodotEngine_Microsoft.Winget.Source_8wekyb3d8bbwe'],
    'C:\\Users\\sam\\AppData\\Local\\Microsoft\\WinGet\\Packages\\GodotEngine.GodotEngine_Microsoft.Winget.Source_8wekyb3d8bbwe': ['godot.exe'],
  }
  const dirs = new Set([...Object.keys(tree), 'C:\\Users\\sam\\AppData\\Local\\Programs\\Godot\\GodotSharp'])
  const fakeFs = {
    list: (dir: string) => tree[dir] ?? [],
    isDir: (p: string) => dirs.has(p),
    executable: (p: string) => !dirs.has(p) && Object.entries(tree).some(([d, names]) => names.some(n => join(d, n) === p || `${d}\\${n}` === p)),
  }
  const field = await doctor.resolveGodotExecutable({ platform: 'win32', env: winEnv, census: [], fs: fakeFs })
  check('the field root resolves: %LOCALAPPDATA%\\Programs\\Godot, the console wrapper ranked last', field.source === 'well-known-location' && /Godot_v4\.7\.2-stable_mono_win64\.exe$/.test(field.resolved ?? '') && !/console/.test(field.resolved ?? ''), `${field.source}: ${field.resolved}`)
  const wingetOnly = await doctor.resolveGodotExecutable({ platform: 'win32', env: winEnv, census: [], fs: { ...fakeFs, list: (d: string) => (d.includes('Programs\\Godot') ? [] : tree[d] ?? []) } })
  check('the winget package dir is walked one level down', /WinGet\\Packages\\GodotEngine\.GodotEngine[^\\]*\\godot\.exe$/.test(wingetOnly.resolved ?? ''), `${wingetOnly.resolved}`)
  const running = await doctor.resolveGodotExecutable({ platform: 'win32', env: { ...winEnv, LOCALAPPDATA: 'C:\\nowhere' }, census: win, projectRoot: 'C:\\Users\\sam\\Projects\\My Game', fs: { list: () => [], isDir: () => false, executable: () => false } })
  check('a RUNNING editor is never NOT FOUND: its own executable path, source running-editor', running.source === 'running-editor' && running.resolved === WIN_EXE && /pid 18344/.test(running.note), `${running.source}: ${running.note}`)
  const other = await doctor.resolveGodotExecutable({ platform: 'win32', env: { ...winEnv, LOCALAPPDATA: 'C:\\nowhere' }, census: win, projectRoot: 'C:\\Users\\sam\\Other', fs: { list: () => [], isDir: () => false, executable: () => false } })
  check('an editor on ANOTHER project still resolves (after PATH and the roots)', other.source === 'running-editor' && other.resolved === WIN_EXE)
  const none = await doctor.resolveGodotExecutable({ platform: 'win32', env: winEnv, census: [], fs: { list: () => [], isDir: () => false, executable: () => false } })
  check('not-found names how many roots were walked (never a bare NOT FOUND)', none.source === 'not-found' && none.probed.length >= 8 && /well-known root/.test(none.note), none.note)
  const mac = await doctor.resolveGodotExecutable({ platform: 'darwin', env: { HOME: '/Users/sam', PATH: '/usr/bin' }, census: [], fs: { list: (d: string) => (d === '/Applications' ? ['Godot.app', 'Godot 2.app', 'Safari.app'] : []), isDir: () => false, executable: (p: string) => p.endsWith('/Contents/MacOS/Godot') } })
  check('darwin: Godot*.app bundles resolve to Contents/MacOS/Godot (no godot on PATH)', mac.source === 'well-known-location' && /\/Applications\/Godot[^/]*\.app\/Contents\/MacOS\/Godot$/.test(mac.resolved ?? ''), `${mac.resolved}`)

  section('3. three named states — never "closed" for a running editor')
  const port = Number(process.env.MERCURY_GODOT_TOOLS_PORT)
  const noEditor = presence.derivePresence(port, false, { ok: true, processes: [] }, MAC_PROJ)
  const unbridged = presence.derivePresence(port, false, { ok: true, processes: darwin }, MAC_PROJ)
  const bridged = presence.derivePresence(port, true, { ok: true, processes: darwin }, MAC_PROJ)
  const guiUnbridged = presence.derivePresence(port, false, { ok: true, processes: [{ ...macEditor, headless: false, pid: 777 }] }, MAC_PROJ)
  check('states: no-editor / editor-unbridged / bridge-up', noEditor.state === 'no-editor' && unbridged.state === 'editor-unbridged' && bridged.state === 'bridge-up')
  check('the unbridged words name the running editor and never say closed', /editor running \(pid 41230, headless\), bridge dark — open but unbridged/.test(unbridged.words) && !/closed/.test(unbridged.words), unbridged.words)
  const unread = presence.derivePresence(port, false, { ok: false, processes: [] }, MAC_PROJ)
  check('a failed census never claims "no editor" as proven', /process table could not be read/.test(unread.words), unread.words)
  check('an editor on another project reads as no editor on THIS one, counted', /no editor running on this project \(1 on other projects\)/.test(presence.derivePresence(port, false, { ok: true, processes: [{ ...macEditor, project: '/elsewhere' }] }, MAC_PROJ).words))
  const nudgeHeadless = presence.presenceNudge(unbridged, { installed: true, enabled: true })
  check('headless nudge: restart, with the editor\'s OWN executable', /headless \(pid 41230\)/.test(nudgeHeadless) && /restart it/.test(nudgeHeadless) && nudgeHeadless.includes(MAC_APP), nudgeHeadless)
  const nudgeGui = presence.presenceNudge(guiUnbridged, { installed: true, enabled: true })
  check('GUI nudge: Reload from disk (never Ignore), then the Plugins tab or Reload Current Project — Godot\'s own mechanism', /Reload from disk/.test(nudgeGui) && /never "Ignore external changes"/.test(nudgeGui) && /Project Settings > Plugins/.test(nudgeGui) && /Reload Current Project/.test(nudgeGui), nudgeGui.slice(0, 160))
  check('the nudge says whether Mercury can trigger it: not unbridged, yes over an up bridge', /cannot reach an unbridged editor/.test(nudgeGui) && /vulcan_install reloads the plugin over it/.test(nudgeGui))
  check('not installed ⇒ vulcan_install leads the nudge', presence.presenceNudge(noEditor, { installed: false, enabled: false }).startsWith('op:"vulcan_install"'))
  check('installed but not enabled ⇒ the enabled row is named', /not enabled in project.godot/.test(presence.presenceNudge(unbridged, { installed: true, enabled: false })))
  check('bridge up ⇒ no nudge', presence.presenceNudge(bridged, { installed: true, enabled: true }) === '')
  check('capsule source words carry the state, never closed', presence.staticCapsuleSource(unbridged).startsWith('static (editor running (pid 41230') && !/closed/.test(presence.staticCapsuleSource(noEditor)) && presence.editorOnlySliceWords(unbridged) === '(editor open but unbridged)' && presence.editorOnlySliceWords(noEditor) === '(no editor running)')

  section('4. the class cache — stale detection, the import-pass argv, the explanation')
  const proj = join(scratch, 'game')
  mkdirSync(join(proj, 'scripts'), { recursive: true })
  mkdirSync(join(proj, '.godot'), { recursive: true })
  writeFileSync(join(proj, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Disc"\nconfig/features=PackedStringArray("4.6", "Forward Plus")\n')
  writeFileSync(join(proj, 'scripts', 'player.gd'), 'class_name Player\nextends CharacterBody2D\n')
  writeFileSync(join(proj, 'scripts', 'plain.gd'), 'extends Node\n')
  const old = new Date(Date.now() - 60_000)
  utimesSync(join(proj, 'scripts', 'player.gd'), old, old)
  const absent = classCache.classCacheReport(proj)
  check('no cache file ⇒ absent, every class_name script stale (cache-missing), the op named', absent.state === 'absent' && absent.stale.length === 1 && absent.stale[0].reason === 'cache-missing' && absent.hint.includes('project_refresh_classes'), absent.hint)
  writeFileSync(join(proj, '.godot', 'global_script_class_cache.cfg'), 'list=Array[Dictionary]([{\n"base": &"CharacterBody2D",\n"class": &"Player",\n"icon": "",\n"language": &"GDScript",\n"path": "res://scripts/player.gd"\n}])\n')
  const fresh = classCache.classCacheReport(proj)
  check('cache newer than every class_name script ⇒ fresh, no hint', fresh.state === 'fresh' && fresh.hint === '' && fresh.classTotal === 1 && fresh.declaredTotal === 1)
  await new Promise(resolve => setTimeout(resolve, 20))
  writeFileSync(join(proj, 'scripts', 'enemy.gd'), '# an enemy\nclass_name Enemy\nextends Node2D\n')
  const future = new Date(Date.now() + 5_000)
  utimesSync(join(proj, 'scripts', 'player.gd'), future, future)
  const stale = classCache.classCacheReport(proj)
  check('a new class_name script ⇒ missing-from-cache; a rewritten known one ⇒ newer-than-cache', stale.state === 'stale' && stale.stale.some((s: { class: string; reason: string }) => s.class === 'Enemy' && s.reason === 'missing-from-cache') && stale.stale.some((s: { class: string; reason: string }) => s.class === 'Player' && s.reason === 'newer-than-cache'), JSON.stringify(stale.stale))
  check('the stale hint names the cache file and the op', stale.hint.includes('global_script_class_cache.cfg') && stale.hint.includes('op:"project_refresh_classes"') && /Could not find type/.test(stale.hint), stale.hint)
  const godotError = 'SCRIPT ERROR: Parse Error: Could not find type "Enemy" in the current scope.\n          at: GDScript::reload (res://scripts/use_enemy.gd:4)\n'
  const explained = classCache.explainHeadlessFailure(godotError, stale)
  check('a headless "Could not find type" for a declared class names the stale cache + the op', typeof explained === 'string' && explained.includes('"Enemy"') && explained.includes('global_script_class_cache.cfg') && explained.includes('project_refresh_classes'), explained)
  check('an undeclared type is left alone (a typo stays a typo)', classCache.explainHeadlessFailure('Could not find type "Nope" in the current scope.', stale) === undefined)
  const inv = classCache.refreshInvocation('/opt/godot', proj)
  check('the exact Godot 4.x import pass, as an argv array', inv.file === '/opt/godot' && JSON.stringify(inv.args) === JSON.stringify(['--headless', '--import', '--path', proj]))
  const cap = capsule.staticGodotCapsule(proj, undefined, unbridged)
  check('the static capsule carries class_cache with the stale rows and the hint', cap.class_cache.state === 'stale' && cap.class_cache.stale.length === 2 && cap.class_cache.hint.includes('project_refresh_classes') && cap.global_class_count === 1)
  check('the static capsule words: source/engine/edited_scene name the editor state', cap.source.includes('open but unbridged') && cap.engine.includes('open but unbridged') && cap.edited_scene === '(editor open but unbridged)', cap.engine)

  section('5. every project.godot edit is receipted, on the change-record road')
  const calls: string[] = []
  const road = {
    before: async (file: string) => {
      calls.push(`before:${file.endsWith('project.godot')}`)
    },
    after: (file: string, previous: string, next: string) => {
      calls.push(`after:${file.endsWith('project.godot')}:${previous.length < next.length}`)
    },
  }
  const noCensus = { census: { ok: true, processes: [] } }
  const install = await installer.applyVulcanInstall(proj, road, noCensus)
  const text = readFileSync(join(proj, 'project.godot'), 'utf8')
  check('install answer: one receipt line per row — enabled plugin, port, autoload', /project\.godot \[editor_plugins\] enabled: \(absent\) → res:\/\/addons\/mercury_vulcan\/plugin\.cfg — /.test(install) && new RegExp(`project\\.godot \\[mercury_vulcan\\] port: \\(absent\\) → ${port} — `).test(install) && /project\.godot \[autoload\] MercuryVulcanRuntimeBridge: \(absent\) → "\*res:\/\/addons\/mercury_vulcan\/core\/runtime_bridge\.gd" — /.test(install), install.split('\n').slice(0, 5).join(' | '))
  check('the autoload row lands in res:// form, written by Mercury (not left to the editor)', text.includes('[autoload]') && text.includes(`MercuryVulcanRuntimeBridge=${installer.RUNTIME_AUTOLOAD_ROW_VALUE}`))
  check('the receipt explains the editor\'s uid:// respelling law', /respells the row as uid:\/\//.test(install))
  check('the change-record road fired: before the write, then after with previous/next', JSON.stringify(calls) === JSON.stringify(['before:true', 'after:true:true']), JSON.stringify(calls))
  check('the answer names the editor state and the nudge (no editor running here)', /editor: no editor running/.test(install) && /next: open the project in the Godot editor/.test(install), install.split('\n').slice(-2).join(' | '))
  const again = await installer.applyVulcanInstall(proj, road, noCensus)
  check('a second install: no change needed, no road call', /project\.godot: no change needed/.test(again) && calls.length === 2)
  check('uid:// spelling is explained as Godot\'s own (path_to_uid), res:// as Mercury\'s receipted row', /path_to_uid/.test(installer.explainRuntimeAutoloadRow('"*uid://d2k0ug6hfbri0"', true)) && /receipted/.test(installer.explainRuntimeAutoloadRow(installer.RUNTIME_AUTOLOAD_ROW_VALUE, true)) && /vulcan_install/.test(installer.explainRuntimeAutoloadRow(undefined, true)))
  const rows = await providers.godotProviderInventory(proj, { census: { ok: true, processes: [{ ...macEditor, project: proj }] } })
  const vulcanRow = rows.find((r: { id: string }) => r.id === 'vulcan')!
  check('provider row: installed + unbridged editor ⇒ not-answering with the state and the nudge', vulcanRow.state === 'not-answering' && /open but unbridged/.test(vulcanRow.failureReason ?? '') && /restart it/.test(vulcanRow.failureReason ?? ''), vulcanRow.failureReason)
  const uninstall = await installer.applyVulcanUninstall(proj, road)
  const after = readFileSync(join(proj, 'project.godot'), 'utf8')
  check('uninstall receipts: the enabled row and the autoload row, both stripped', /\[editor_plugins\] enabled: res:\/\/addons\/mercury_vulcan\/plugin\.cfg → \(empty\)/.test(uninstall) && /\[autoload\] MercuryVulcanRuntimeBridge: "\*res:\/\/addons\/mercury_vulcan\/core\/runtime_bridge\.gd" → \(removed\)/.test(uninstall) && !after.includes('MercuryVulcanRuntimeBridge'), uninstall)
  const single = installer.formatProjectGodotReceipt({ section: 'autoload', key: 'X', previous: 'a', next: 'b', why: 'because' })
  check('receipt shape: file · [section] · key · previous → next · why', single === 'project.godot [autoload] X: a → b — because')

  section('6. the words — doctor row, prompt, plugin guard, optable')
  const health = readFileSync(join(ROOT, 'src/utils/healthReport.ts'), 'utf8')
  check('the doctor row reads the presence owner and its nudge', health.includes("await import('../services/vulcan/editorPresence.js')") && health.includes('fix: presenceNudge(presence, s)') && !/focus\/restart the editor/.test(health))
  const prompt = readFileSync(join(ROOT, 'src/tools/GodotTool/prompt.ts'), 'utf8')
  check('the tool prompt names the three states and project_refresh_classes', /no editor running \/ editor open but unbridged \/ bridge up/.test(prompt) && prompt.includes('project_refresh_classes') && !/picks it up on focus/.test(prompt))
  const plugin = readFileSync(join(ROOT, 'assets/vulcan/addon/plugin.gd'), 'utf8')
  check('plugin.gd writes the autoload row only when absent, as the plain res:// setting (no add_autoload_singleton, no per-boot rewrite)', /if not ProjectSettings\.has_setting\("autoload\/" \+ RUNTIME_AUTOLOAD\):\n\t\tProjectSettings\.set_setting\("autoload\/" \+ RUNTIME_AUTOLOAD, "\*" \+ RUNTIME_BRIDGE_PATH\)/.test(plugin) && !/^\s*add_autoload_singleton\(/m.test(plugin))
  const server = readFileSync(join(ROOT, 'assets/vulcan/addon/core/server.gd'), 'utf8')
  const editorCat = readFileSync(join(ROOT, 'assets/vulcan/addon/categories/editor.gd'), 'utf8')
  check('the server carries a start stamp and editor_state reports it (the reload confirmation)', /started_ms = Time\.get_ticks_msec\(\)/.test(server) && editorCat.includes('"vulcan_server_started_ms"') && server.includes('"project_refresh_classes"'))
  const op = optable.vulcanOp('project_refresh_classes')
  check('project_refresh_classes: a frontier exec op, Mercury-side', op?.cls === 'exec' && op?.category === 'frontier' && /headless --import/.test(op?.summary ?? ''))
  const tool = readFileSync(join(ROOT, 'src/tools/GodotTool/GodotTool.ts'), 'utf8')
  check('the tool answers it locally and rides the file-history road for installs', /LOCAL_OPS = new Set\(\[[^\]]*'project_refresh_classes'/.test(tool) && tool.includes('fileHistoryTrackEdit(context.updateFileHistoryState, file, parentMessage.uuid') && tool.includes('notifyVscodeFileUpdated(file, previous, next)'))
  check('the reload script defers the toggle so the answer leaves first', /call_deferred\("set_plugin_enabled", "mercury_vulcan", false\)/.test(installer.PLUGIN_RELOAD_SCRIPT) && /call_deferred\("set_plugin_enabled", "mercury_vulcan", true\)/.test(installer.PLUGIN_RELOAD_SCRIPT))
} finally {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
}

console.log('\n' + (failures === 0 ? '✅ godot discovery proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
