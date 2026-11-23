#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { flowShellAsk } from '../../src/permissions/rules/flowLaw.ts'
import { refusalOfShellCommand } from '../../src/permissions/wards/wardsRefusals.ts'
import { VastClient } from '../../src/models/hosting/vendors/vast.ts'
import { normalizePatternsToPath } from '../../src/permissions/rules/filesystem.ts'
import { parseRemotePath } from '../../src/platform/remote-file-target/target.ts'
import { posixRelative } from '../../src/tools/engines/structure/scanPaths.ts'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
const BASELINE = join(import.meta.dir, 'win32-seam-baseline.json')

const PLATFORM_CHECK = 'platform-check'

const TELLS: Array<[string, RegExp]> = [
  ['split-slash', /\.split\((?:'\/'|"\/")\)/g],
  ['kill-signal', /process\.kill\([^)]+,\s*['"]SIG/g],
  [PLATFORM_CHECK, /getPlatform\(\) [!=]== 'windows'|platform [!=]== '(?:win32|windows)'/g],
]

const PLATFORM_HOME = /^src\/platform\/(?:environment\/platform\.ts$|host-os\/)/

const SINGLE: Array<[file: string, checks: number, reason: string]> = [
  ['src/boot/first-run/TerminalProfileCard.tsx', 3, 'the Windows host inventory card exists on Windows only'],
  ['src/boot/main/defaultAction.ts', 1, '--multiplex (tmux) does not exist on Windows'],
  ['src/daemon/control/daemonBuild.ts', 1, 'a Nix install exists outside Windows only'],
  ['src/daemon/control/directoryIdentity.ts', 1, 'a folder without an inode is known by its normalized Windows spelling'],
  ['src/daemon/control/ownedDaemon.ts', 1, 'the owner pipe is inherited off Windows only'],
  ['src/daemon/process-sweep/processSweepWindows.ts', 1, 'the Windows process reader refuses to open elsewhere'],
  ['src/integrations/browser/session/launch.ts', 1, 'the identity of the browser follows the host'],
  ['src/integrations/browser/session/owners.ts', 1, 'the temp tree of a browser is ended by taskkill on Windows only'],
  ['src/integrations/browser/session/stealth.ts', 1, 'the navigator platform of the browser follows the host'],
  ['src/integrations/debugger/debugpyResolver.ts', 1, 'the Python commands the debugger tries are its own on each platform'],
  ['src/integrations/event-hooks/commandRunner.ts', 2, 'a bash hook runs through the Windows bash road on Windows only'],
  ['src/integrations/mcp/oauthPort.ts', 1, 'the callback port range Windows leaves free differs'],
  ['src/integrations/mcp/serverConfigs.ts', 1, 'the npx warning is for Windows, where npx is a batch shim'],
  ['src/integrations/voice/capture.ts', 3, 'the input format of ffmpeg on each platform, and its install words'],
  ['src/integrations/voice/whisperPack.ts', 2, 'Windows keeps no instruction-set list to read'],
  ['src/integrations/vulcan/engine/argv.ts', 1, 'the console sibling of the Godot executable exists on Windows only'],
  ['src/integrations/vulcan/engine/leases.ts', 2, 'a lease path is probed on disk and may not name a drive off Windows'],
  ['src/models/hosting/ssh.ts', 1, 'the OS of a box decides its inspection script'],
  ['src/models/local-server/localServerTruth.ts', 2, 'how a local server is launched and what memory it may use is told for each platform'],
  ['src/models/roads/anthropic/fixtureReplay.ts', 1, 'a recording is dehydrated of both spellings of a path on Windows only'],
  ['src/models/tensorfold/adapter/llama.ts', 2, 'the adapter installs the Windows x64 build of llama.cpp only, and names the missing-DLL exit of Windows'],
  ['src/models/tensorfold/fit.ts', 1, 'the chip of the machine is named in the words of Windows'],
  ['src/permissions/cards/shellAskParts.tsx', 1, 'the label of a folder rule follows the platform'],
  ['src/permissions/rules/uncPath.ts', 1, 'a UNC path is a risk on Windows only'],
  ['src/permissions/rules/windowsPath.ts', 2, 'the path patterns of Windows are suspect on Windows and WSL only'],
  ['src/platform/editor/externalEditor.ts', 1, 'Windows falls back to notepad when no editor is named'],
  ['src/platform/environment/sessionEnvironment.ts', 1, 'the Windows bash road exists on Windows only'],
  ['src/platform/files/fileEncoding.ts', 1, 'Windows PowerShell 5.1 needs a byte order mark on its scripts'],
  ['src/platform/git/git.ts', 2, 'a Windows path met in a git redirect off Windows is refused'],
  ['src/platform/health/sections/proofs.ts', 1, 'the POSIX render pipeline does not run from a Windows source checkout'],
  ['src/platform/node-runtime/compileCachePath.ts', 1, 'the compile cache folder has a length limit on Windows only'],
  ['src/platform/processes/gracefulShutdown.ts', 1, 'the orphaned-terminal check runs off Windows only'],
  ['src/platform/processes/processGroup.ts', 4, 'the MSYS job table and the taskkill drain exist on Windows only'],
  ['src/platform/processes/watchRoot.ts', 3, 'a watched root is resolved natively and guarded against its own removal on Windows only'],
  ['src/platform/remote-files/bridge.ts', 1, 'a remote name that Windows cannot hold is mapped on Windows only'],
  ['src/platform/remote-files/hosts.ts', 1, 'the ssh_config of the system has its own place on each platform'],
  ['src/platform/secure-storage/plainTextStorage.ts', 2, 'the read-only attribute of Windows is cleared before the credentials file is replaced'],
  ['src/platform/secure-storage/systemProtector.ts', 1, 'DPAPI sealing exists on Windows only'],
  ['src/platform/settings/mdm/probeMemo.ts', 2, 'managed settings are the registry on Windows and a plist on macOS'],
  ['src/platform/settings/mdm/rawRead.ts', 1, 'managed settings are the registry on Windows and a plist on macOS'],
  ['src/platform/settings/settings.ts', 1, 'managed settings are the registry on Windows and a plist on macOS'],
  ['src/platform/shell/bashProvider.ts', 2, 'the MSYS command frame of a bash on Windows exists on Windows only'],
  ['src/platform/shell/powershellProvider.ts', 1, 'PowerShell on Windows takes an environment of its own'],
  ['src/platform/shell/shellExec.ts', 4, 'the start refusals, the batch plan and the folder note of Windows exist on Windows only'],
  ['src/platform/shell/shellRecord.ts', 2, 'the Git Bash probe is asked on Windows only, and a sentence names the place of this platform'],
  ['src/platform/shell/windowsBatchInvocation.ts', 1, 'a batch file is planned through cmd on Windows only'],
  ['src/platform/shell/windowsShellRoad.ts', 1, 'the Windows bash road exists on Windows only'],
  ['src/platform/update-channel/installLayout.ts', 3, 'the install layout of Mercury itself, the script policies of PowerShell and the removal of a binary in use after exit'],
  ['src/platform/update-channel/installProvenance.ts', 2, 'the install probe carries its platform as a fact, and a public signature takes it as a parameter'],
  ['src/platform/update-channel/nixInstallRoot.ts', 1, 'a Nix install exists outside Windows only'],
  ['src/platform/update-channel/vendoredRuntime.ts', 4, 'bundled into the standalone verifier, which may import nothing outside src/platform/update-channel'],
  ['src/screen/composer/exampleCommands.ts', 1, 'frequent-file examples are not gathered on Windows'],
  ['src/screen/composer/imagePaste.ts', 5, 'the clipboard is read and saved by the commands of each desktop'],
  ['src/screen/keys/defaultBindings.ts', 1, 'the default chords are a table for each platform'],
  ['src/screen/keys/reservedShortcuts.ts', 1, 'the shortcuts an OS reserves are a table for each platform'],
  ['src/screen/renderer/instance/stdin.ts', 1, 'the tty device is drained without blocking where a tty device exists'],
  ['src/screen/renderer/root/console-read.ts', 1, 'the console read handle of Node is stopped on Windows only'],
  ['src/screen/renderer/terminal-session/terminalProfile.ts', 4, 'the terminal profile is resolved from a probe that carries its platform'],
  ['src/screen/renderer/terminal-session/windowsHostSetup.ts', 1, 'the Windows host inventory exists on Windows only'],
  ['src/screen/tips/tipRegistry.ts', 1, 'a tip about the PowerShell tool, for Windows only'],
  ['src/sessions/instructions/sourceText.ts', 1, 'an import line may name a drive or a share on Windows only'],
  ['src/tools/computer/call/act.ts', 1, 'the path field of a file dialog is opened by the keys of each desktop'],
  ['src/tools/engines/eval-kernels/interpreters.ts', 1, 'the Python commands the kernel tries are its own on each platform'],
  ['src/tools/engines/eval-kernels/procKernel.ts', 1, 'the Python kernel speaks over loopback on Windows only'],
  ['src/tools/kit/ocr.ts', 2, 'native OCR exists on macOS and Windows only, and a sentence names the place of this platform'],
  ['src/tools/powershell/PowerShellTool.tsx', 1, 'the bash of Git is looked for on Windows only'],
  ['src/tools/powershell/pathValidation.ts', 1, 'a rule of a command reader for the commands of one platform'],
  ['src/tools/powershell/readOnlyValidation.ts', 2, 'a rule of a command reader for the commands of one platform'],
  ['src/tools/read/readQueryTarget.ts', 1, 'a question mark cannot stand in a file name on Windows'],
  ['src/tools/shell/pathValidation.ts', 1, 'a rule of a command reader for the commands of one platform'],
  ['src/tools/shell/readOnlyValidation.ts', 2, 'a rule of a command reader for the commands of one platform'],
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
const classedSingle = new Map(SINGLE.map(([file, checks]) => [file, checks]))
let shrank = 0
for (const [key, n] of Object.entries(current)) {
  const held = baseline[key] ?? baseline[`${cameFrom.get(fileOf(key)) ?? ''} :: ${tellOf(key)}`] ?? 0
  const base = tellOf(key) === PLATFORM_CHECK ? Math.max(held, classedSingle.get(fileOf(key)) ?? 0) : held
  if (n > base && heldTells.has(tellOf(key))) grew.push(`${key}  ${base} → ${n}`)
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
  console.log(`         ${PLATFORM_CHECK}: ask a function under src/platform/host-os/, which reads the platform at the call`)
} else {
  console.log(`  [PASS] no file gained a POSIX tell or a platform check (${Object.keys(current).length} tracked)`)
}
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
const single = SINGLE.reduce((sum, [, checks]) => sum + checks, 0)
const stale = SINGLE.map(([file, checks]) => ({ file, checks, holds: current[`${movedTo(file, singleFiles, platformFiles) ?? file} :: ${PLATFORM_CHECK}`] ?? 0 })).filter(row => row.holds < row.checks)
check('every single row names platform checks its file still holds', stale.length === 0, stale.map(row => `${row.file} holds ${row.holds}, its row says ${row.checks}: lower the row in SINGLE or remove it`).join(' · '))
console.log(`  [INFO] platform checks outside src/platform/host-os: ${total} in ${platformRows.length} files · single ${single} · to move ${total - single}`)

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
