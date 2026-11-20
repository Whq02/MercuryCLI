#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { flowShellAsk } from '../../src/utils/permissions/flowLaw.ts'
import { refusalOfShellCommand } from '../../src/utils/wards/wardsRefusals.ts'
import { VastClient } from '../../src/services/host/vendors/vast.ts'
import { normalizePatternsToPath } from '../../src/utils/permissions/filesystem.ts'
import { parseRemotePath } from '../../src/services/remoteFiles/target.ts'
import { posixRelative } from '../../src/services/structure/scanPaths.ts'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
const BASELINE = join(import.meta.dir, 'win32-seam-baseline.json')

const PLATFORM_CHECK = 'platform-check'

const TELLS: Array<[string, RegExp]> = [
  ['split-slash', /\.split\((?:'\/'|"\/")\)/g],
  ['kill-signal', /process\.kill\([^)]+,\s*['"]SIG/g],
  [PLATFORM_CHECK, /getPlatform\(\) [!=]== 'windows'|platform [!=]== '(?:win32|windows)'/g],
]

const PLATFORM_HOME = /^src\/utils\/platform(?:\.ts$|\/)/
const ROW_8 = /^src\/(?:utils\/(?:bash|wards|permissions\/shellProtectedPaths|permissions\/decision)\/|utils\/permissions\/flowLaw\.ts$|tools\/BashTool\/(?:denyRuleReach|bashPermissions)\.ts$)/

const SINGLE: Array<[file: string, checks: number, reason: string]> = [
  ['src/cli/editorBridge.ts', 1, 'the install places of another vendor on each platform'],
  ['src/commands/tensorfold/scene.ts', 3, 'the TensorFold engine has no Windows release: Windows is served by a host or by the llama.cpp adapter'],
  ['src/components/Feedback.tsx', 2, 'the sentence names the command or the place of this platform'],
  ['src/components/TerminalProfileCard.tsx', 3, 'the Windows host inventory card exists on Windows only'],
  ['src/components/tensorfold/tensorfoldFacts.ts', 4, 'the TensorFold engine has no Windows release: Windows is served by a host or by the llama.cpp adapter'],
  ['src/components/tensorfold/tensorfoldRows.ts', 3, 'the TensorFold engine has no Windows release: Windows is served by a host or by the llama.cpp adapter'],
  ['src/constants/prompts.ts', 1, 'the sentence names the command or the place of this platform'],
  ['src/daemon/daemonBuild.ts', 1, 'a Nix install exists outside Windows only'],
  ['src/daemon/processSweepWindows.ts', 1, 'the Windows process reader refuses to open elsewhere'],
  ['src/ink/session/windowsHostSetup.ts', 1, 'the Windows host inventory exists on Windows only'],
  ['src/interactiveHelpers.tsx', 1, 'the sentence names the command or the place of this platform'],
  ['src/main/defaultAction.ts', 1, '--multiplex (tmux) does not exist on Windows'],
  ['src/screens/chat/useChatSearch.tsx', 1, 'the sentence names the command or the place of this platform'],
  ['src/services/api/errors.ts', 1, 'the sentence names the command or the place of this platform'],
  ['src/services/aseprite/asepriteApp.ts', 2, 'the install places of another vendor on each platform'],
  ['src/services/blender/addonHome.ts', 1, 'the install places of another vendor on each platform'],
  ['src/services/browser/browserResolver.ts', 2, 'the install places of another vendor on each platform'],
  ['src/services/browser/session/launch.ts', 1, 'the identity of the browser follows the host'],
  ['src/services/browser/session/owners.ts', 1, 'the temp tree of a browser is ended by taskkill on Windows only'],
  ['src/services/browser/session/stealth.ts', 1, 'the navigator platform of the browser follows the host'],
  ['src/services/dap/client/probes.ts', 1, 'the sentence names the command or the place of this platform'],
  ['src/services/desktop/nativeDriver.ts', 1, 'the sentence names the command or the place of this platform'],
  ['src/services/host/bank.ts', 1, 'the sentence names the command or the place of this platform'],
  ['src/services/host/ssh.ts', 1, 'the OS of a box decides its inspection script'],
  ['src/services/ide/blenderProject.ts', 1, 'the install places of another vendor on each platform'],
  ['src/services/ide/unityProject.ts', 2, 'the install places of another vendor on each platform'],
  ['src/services/localSetup/setupInstall.ts', 1, 'the install places of another vendor on each platform'],
  ['src/services/localSetup/setupRoad.ts', 1, 'the sentence names the command or the place of this platform'],
  ['src/services/lsp/serverCatalogue.ts', 1, 'the sentence names the command or the place of this platform'],
  ['src/services/mcp/auth.ts', 1, 'the sentence names the command or the place of this platform'],
  ['src/services/mcp/config.ts', 1, 'the npx warning is for Windows, where npx is a batch shim'],
  ['src/services/mcp/oauthPort.ts', 1, 'the callback port range Windows leaves free differs'],
  ['src/services/privateChannel/installLayout.ts', 2, 'the script policies of PowerShell are read, and a binary in use is removed after exit, on Windows only'],
  ['src/services/privateChannel/nixInstallRoot.ts', 1, 'a Nix install exists outside Windows only'],
  ['src/services/privateChannel/updateRemedy.ts', 2, 'the sentence names the command or the place of this platform'],
  ['src/services/providers/local/tensorfoldSupport.ts', 1, 'the sentence names the command or the place of this platform'],
  ['src/services/tensorfold/adapter/llama.ts', 2, 'the adapter installs the Windows x64 build of llama.cpp only, and names the missing-DLL exit of Windows'],
  ['src/services/tensorfold/engine.ts', 1, 'the TensorFold engine has no Windows release: Windows is served by a host or by the llama.cpp adapter'],
  ['src/services/tensorfold/fit.ts', 1, 'the chip of the machine is named in the words of Windows'],
  ['src/services/tensorfold/install.ts', 2, 'the TensorFold engine has no Windows release: Windows is served by a host or by the llama.cpp adapter'],
  ['src/services/tips/tipRegistry.ts', 1, 'a tip about the PowerShell tool, for Windows only'],
  ['src/services/voice/capture.ts', 3, 'the input format of ffmpeg on each platform, and its install words'],
  ['src/services/voice/whisperPack.ts', 2, 'Windows keeps no instruction-set list to read'],
  ['src/services/vulcan/engine/argv.ts', 1, 'the console sibling of the Godot executable exists on Windows only'],
  ['src/services/vulcan/portabilityHealth.ts', 3, 'the install places of another vendor on each platform'],
  ['src/tools/BashTool/readOnlyValidation.ts', 2, 'a rule of a command reader for the commands of one platform'],
  ['src/tools/PowerShellTool/PowerShellTool.tsx', 1, 'the bash of Git is looked for on Windows only'],
  ['src/tools/PowerShellTool/readOnlyValidation.ts', 2, 'a rule of a command reader for the commands of one platform'],
  ['src/utils/Shell.ts', 4, 'the start refusals, the batch plan and the folder note of Windows exist on Windows only'],
  ['src/utils/errors/classifyToolError.ts', 1, 'the sentence names the command or the place of this platform'],
  ['src/utils/exampleCommands.ts', 1, 'frequent-file examples are not gathered on Windows'],
  ['src/utils/ffmpeg.ts', 1, 'the sentence names the command or the place of this platform'],
  ['src/utils/health/sections/interface.ts', 2, 'the sentence names the command or the place of this platform'],
  ['src/utils/health/sections/proofs.ts', 1, 'the POSIX render pipeline does not run from a Windows source checkout'],
  ['src/utils/healthReport.ts', 1, 'the sentence names the command or the place of this platform'],
  ['src/utils/hooks/commandRunner.ts', 2, 'a bash hook runs through the Windows bash road on Windows only'],
  ['src/utils/ocr.ts', 1, 'the sentence names the command or the place of this platform'],
  ['src/utils/sessionEnvironment.ts', 1, 'the Windows bash road exists on Windows only'],
  ['src/utils/settings/mdm/probeMemo.ts', 2, 'managed settings are the registry on Windows and a plist on macOS'],
  ['src/utils/settings/mdm/rawRead.ts', 1, 'managed settings are the registry on Windows and a plist on macOS'],
  ['src/utils/settings/settings.ts', 1, 'managed settings are the registry on Windows and a plist on macOS'],
  ['src/utils/shell/bashProvider.ts', 2, 'the MSYS command frame of a bash on Windows exists on Windows only'],
  ['src/utils/shell/engineSession.ts', 1, 'the sentence names the command or the place of this platform'],
  ['src/utils/shell/powershellProvider.ts', 1, 'PowerShell on Windows takes an environment of its own'],
  ['src/utils/shell/shellRecord.ts', 2, 'the Git Bash probe is asked on Windows only, and a sentence names the place of this platform'],
  ['src/utils/shell/windowsBatchInvocation.ts', 1, 'a batch file is planned through cmd on Windows only'],
  ['src/utils/shell/windowsShellRoad.ts', 1, 'the Windows bash road exists on Windows only'],
  ['src/utils/shutdownRestoration.ts', 1, 'the sentence names the command or the place of this platform'],
  ['src/utils/watchRoot.ts', 3, 'a watched root is resolved natively and guarded against its own removal on Windows only'],
  ['src/utils/worktree.ts', 1, 'the tmux worktree road does not exist on Windows'],
]

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const s = statSync(p)
    if (s.isDirectory()) {
      if (e === 'node_modules' || e === '__snapshots__') continue
      walk(p, out)
    } else if ((p.endsWith('.ts') || p.endsWith('.tsx')) && e !== 'content.generated.ts') {
      out.push(p)
    }
  }
}

function measure(): Record<string, number> {
  const counts: Record<string, number> = {}
  const files: string[] = []
  walk(SRC, files)
  for (const abs of files) {
    const rel = relative(ROOT, abs).split('\\').join('/')
    const text = readFileSync(abs, 'utf8')
    for (const [tell, re] of TELLS) {
      if (tell === PLATFORM_CHECK && PLATFORM_HOME.test(rel)) continue
      const n = (text.match(re) ?? []).length
      if (n > 0) counts[`${rel} :: ${tell}`] = n
    }
  }
  return counts
}

const fileOf = (key: string): string => key.split(' :: ')[0]!
const tellOf = (key: string): string => key.split(' :: ')[1]!

function movedTo(gone: string, named: Set<string>, measured: string[]): string | undefined {
  if (existsSync(join(ROOT, gone))) return undefined
  const same = measured.filter(file => basename(file) === basename(gone) && !named.has(file))
  return same.length === 1 ? same[0] : undefined
}

const current = measure()
const relock = process.argv.includes('--relock')

let baseline: Record<string, number> = {}
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>
} catch {
  if (!relock) {
    console.log('  [FAIL] baseline missing — generate it: bun run prove-win32-seam-ratchet.ts --relock')
    process.exit(1)
  }
}

const measuredFiles = [...new Set(Object.keys(current).map(fileOf))]
const baselineFiles = new Set(Object.keys(baseline).map(fileOf))
const heldTells = new Set(Object.keys(baseline).map(tellOf))
const cameFrom = new Map<string, string>()
for (const gone of baselineFiles) {
  const now = movedTo(gone, baselineFiles, measuredFiles)
  if (now !== undefined) cameFrom.set(now, gone)
}

const grew: string[] = []
const row8: string[] = []
let shrank = 0
for (const [key, n] of Object.entries(current)) {
  const base = baseline[key] ?? baseline[`${cameFrom.get(fileOf(key)) ?? ''} :: ${tellOf(key)}`] ?? 0
  if (n > base && heldTells.has(tellOf(key))) (tellOf(key) === PLATFORM_CHECK && ROW_8.test(fileOf(key)) ? row8 : grew).push(`${key}  ${base} → ${n}`)
  else if (n < base) shrank++
}
for (const key of Object.keys(baseline)) {
  if (!(key in current) && baseline[key]! > 0) shrank++
}

if (relock) {
  if (grew.length > 0) {
    console.log('  [FAIL] the baseline only falls, and these rose:')
    for (const g of grew) console.log(`      - ${g}`)
    process.exit(1)
  }
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(BASELINE, JSON.stringify(sorted, null, 1) + '\n')
  console.log(`relocked ${Object.keys(sorted).length} entries → ${BASELINE}`)
  process.exit(0)
}

console.log('============================================================')
console.log(' win32-seam ratchet — POSIX tells and platform checks frozen per-file')
console.log('============================================================')

let failures = 0

if (grew.length > 0) {
  failures++
  console.log('  [FAIL] a count ROSE, and the table only falls:')
  for (const g of grew) console.log(`      - ${g}`)
  console.log('         split-slash, kill-signal: use a normalized helper')
  console.log(`         ${PLATFORM_CHECK}: ask a function under src/utils/platform/, which reads the platform at the call`)
} else {
  console.log(`  [PASS] no file gained a POSIX tell or a platform check (${Object.keys(current).length} tracked)`)
}
if (row8.length > 0) console.log(`  [INFO] counted, not held, while row 8 re-shapes the command readers: ${row8.join(' · ')}`)
if (shrank > 0) {
  console.log(`  [INFO] ${shrank} entr${shrank === 1 ? 'y' : 'ies'} improved or moved — relock to ratchet down:`)
  console.log('         ~/.bun/bin/bun run scripts/build/prove-win32-seam-ratchet.ts --relock')
}

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

for (const [tell] of TELLS) check(`the baseline holds ${tell}`, heldTells.has(tell), 'relock: bun run scripts/build/prove-win32-seam-ratchet.ts --relock')

const platformRows = Object.entries(current).filter(([key]) => tellOf(key) === PLATFORM_CHECK).map(([key, n]) => [fileOf(key), n] as const)
const platformFiles = platformRows.map(([file]) => file)
const singleFiles = new Set(SINGLE.map(([file]) => file))
const total = platformRows.reduce((sum, [, n]) => sum + n, 0)
const inRow8 = platformRows.filter(([file]) => ROW_8.test(file)).reduce((sum, [, n]) => sum + n, 0)
const single = SINGLE.reduce((sum, [, checks]) => sum + checks, 0)
const stale = SINGLE.map(([file, checks]) => ({ file, checks, holds: current[`${movedTo(file, singleFiles, platformFiles) ?? file} :: ${PLATFORM_CHECK}`] ?? 0 })).filter(row => row.holds < row.checks)
check('every single row names platform checks its file still holds', stale.length === 0, stale.map(row => `${row.file} holds ${row.holds}, its row says ${row.checks}: lower the row in SINGLE or remove it`).join(' · '))
console.log(`  [INFO] platform checks outside src/utils/platform: ${total} in ${platformRows.length} files · row 8 ${inRow8} · single ${single} · to move ${total - inRow8 - single}`)

const flowAsk = await flowShellAsk('npx @scope/vercel deploy', '/tmp/proj')
check('flowLaw splits scoped package names on slash grammar on every host', flowAsk?.item === 3 && flowAsk.subject === 'vercel deploy', JSON.stringify(flowAsk))

const wardVerdict = await refusalOfShellCommand({ toolName: 'Bash', input: { command: 'rm -rf /etc' }, shellCommand: 'rm -rf /etc' }, '/tmp/proj')
check('wardsRefusals splits POSIX shell paths on slash grammar on every host', wardVerdict.allow === false && wardVerdict.rule.name === 'no-root-recursive-delete', JSON.stringify(wardVerdict))

const origFetch = globalThis.fetch
let vastError = ''
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ success: true, result_url: 'https://evil.example/vast.ai/secret-token/out.log' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as never
try {
  await new VastClient('k').logs('42', new AbortController().signal)
} catch (error) {
  vastError = error instanceof Error ? error.message : String(error)
} finally {
  globalThis.fetch = origFetch
}
check('vast redacts unexpected log URL pathnames by slash segments on every host', vastError === 'unexpected log URL · https://evil.example/vast.ai/:segment/:file.log', vastError)

const belowGlobs = normalizePatternsToPath(new Map([['/repo/sub/dir', ['file.ts']]]), '/repo')
const aboveGlobs = normalizePatternsToPath(new Map([['/repo', ['sub/dir/file.ts']]]), '/repo/sub/dir')
check('filesystem permission rules normalize below and above roots using slash grammar', belowGlobs.includes('/sub/dir/file.ts') && aboveGlobs.includes('/file.ts'), JSON.stringify({ belowGlobs, aboveGlobs }))

const remote = parseRemotePath('ssh://host/a/./b//c')
check('remoteFiles parses remote paths on slash grammar on every host', remote?.path === '/a/b/c', JSON.stringify(remote))

const winRel = posixRelative('C:\\repo', 'C:\\repo\\src\\util.ts', 'win32')
check('scanPaths flips separators by the requested platform, never host path.sep', winRel === 'src/util.ts', winRel)

console.log(failures === 0 ? '\nALL WIN32-SEAM CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
