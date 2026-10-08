#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as layout from '../../src/services/privateChannel/installLayout.js'
import type { LayoutRoots } from '../../src/services/privateChannel/installLayout.js'

const { reconcileManagedShims, resolveLayoutRoots, SHIM_MARKER_FAMILY, shimContent, uninstallLayout, writeShimSet } = layout
const optional = layout as unknown as { powershellEntryContent?: () => string; WIN32_POWERSHELL_ENTRY?: string }
const WIN32_POWERSHELL_ENTRY: string = optional.WIN32_POWERSHELL_ENTRY ?? 'mercury-powershell.ps1'
const powershellEntryContent = (): string => optional.powershellEntryContent?.() ?? ''

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

const scratch = mkdtempSync(join(tmpdir(), 'win-entries-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

section('(1) the managed set on win32 carries the PowerShell entry, named so that a bare `mercury` never resolves to it')
const roots = resolveLayoutRoots('win32')
const set = roots.shimSetPaths ?? []
check('three members: the cmd command, the git-bash facade, the PowerShell entry', set.length === 3, JSON.stringify(set))
check('the PowerShell entry is the third member', set[2]?.endsWith(WIN32_POWERSHELL_ENTRY) === true, set[2] ?? '')
check('the entry is a .ps1', WIN32_POWERSHELL_ENTRY.endsWith('.ps1'))
check('the entry is NOT named mercury.ps1 (PowerShell tries .ps1 before every PATHEXT extension, so that name would capture every bare `mercury` typed in PowerShell)', WIN32_POWERSHELL_ENTRY.toLowerCase() !== 'mercury.ps1')
check('the POSIX set is still the single sh member', (resolveLayoutRoots('darwin').shimSetPaths ?? []).length === 1)

section('(2) the PowerShell entry text: the same version resolution as the cmd command, the versioned PowerShell launcher at the end, cmd.exe nowhere')
const ps1 = powershellEntryContent()
check('carries the managed-shim marker family (so the lifecycle rewrites, heals and uninstalls it)', ps1.includes(SHIM_MARKER_FAMILY))
check('CRLF line endings, like the cmd command', ps1.includes('\r\n') && !/[^\r]\n/.test(ps1))
check('root: MERCURY_VERSIONS_DIR first', ps1.includes('$root = $env:MERCURY_VERSIONS_DIR'))
check('root: MERCURY_CONFIG_DIR > MERCURY_HOME > ~/.mercury, then <home>/versions', ps1.includes('if ($env:MERCURY_CONFIG_DIR) { $env:MERCURY_CONFIG_DIR } elseif ($env:MERCURY_HOME) { $env:MERCURY_HOME } else { Join-Path $HOME \'.mercury\' }') && ps1.includes("Join-Path $mercuryHome 'versions'"))
check('pointer: the first non-blank line of current.txt', ps1.includes("if ($line.Trim() -ne '') { $ver = $line; break }"))
check('pointer: quotes stripped and trailing whitespace trimmed (parity with the cmd and sh twins)', ps1.includes(".Replace('\"', '').TrimEnd()"))
check('pointer: a separator or dot-dot refuses before any path is built', ps1.includes("$ver.Contains('\\') -or $ver.Contains('/') -or $ver.Contains('..')") && ps1.indexOf("$ver.Contains('\\')") !== -1 && ps1.indexOf("$ver.Contains('\\')") < ps1.indexOf('$dir = Join-Path $root $ver'))
check('pointer: an empty pointer refuses plainly', ps1.includes("if ($ver -eq '') {"))
check('the versioned PowerShell launcher is run with the arguments as PowerShell parsed them (@args)', ps1.includes("$entry = Join-Path $dir 'mercury.ps1'") && ps1.includes('& $entry @args; exit $LASTEXITCODE'))
check('an installed version without a PowerShell launcher falls back to its cmd launcher', ps1.includes("$cmdEntry = Join-Path $dir 'mercury.cmd'") && ps1.includes('& $cmdEntry @args; exit $LASTEXITCODE'))
check('cmd.exe is never on this road', !/cmd\.exe|\/c\s/i.test(ps1))
check('refusals go to stderr as plain lines', (ps1.match(/\[Console\]::Error\.WriteLine\(/g) ?? []).length === 4)
check('ASCII only (Windows PowerShell reads an unmarked script in the system code page)', !/[^\x00-\x7f]/.test(ps1))
check('every statement is Windows PowerShell 5.1 syntax: no ternary, no ??, no three-argument Join-Path', !ps1.includes('??') && !/\?\s*\$/.test(ps1) && !/Join-Path [^\r\n]+ [^\r\n]+ '[^']*'\s*$/m.test(ps1))

section('(3) the set lifecycle writes, heals and uninstalls the entry with its siblings')
{
  const bin = join(scratch, 'bin')
  const versions = join(scratch, 'versions')
  mkdirSync(join(versions, '9.9.0-beta.1'), { recursive: true })
  writeFileSync(join(versions, 'current.txt'), '9.9.0-beta.1\n')
  const winRoots: LayoutRoots = { versionsDir: versions, binDir: bin, shimPath: join(bin, 'mercury.cmd'), isWindows: true }
  const out = writeShimSet(winRoots)
  check('a win32 roots literal without a set derives all three members', out.members.length === 3 && out.complete, JSON.stringify(out.members.map(m => m.path)))
  check('the PowerShell entry is written with the entry text', existsSync(join(bin, WIN32_POWERSHELL_ENTRY)) && readFileSync(join(bin, WIN32_POWERSHELL_ENTRY), 'utf8') === powershellEntryContent())
  check('the cmd command and the facade are unchanged texts', readFileSync(join(bin, 'mercury.cmd'), 'utf8') === shimContent(true) && readFileSync(join(bin, 'mercury'), 'utf8') === shimContent(false))
  const again = writeShimSet(winRoots)
  check('a second publication finds every member current', again.members.every(m => m.state === 'current'))
  rmSync(join(bin, WIN32_POWERSHELL_ENTRY), { force: true })
  const healed = reconcileManagedShims(winRoots)
  check('the reconcile heals a missing PowerShell entry (an updated install whose updater predates it)', healed !== null && healed.complete && existsSync(join(bin, WIN32_POWERSHELL_ENTRY)))
  writeFileSync(join(bin, WIN32_POWERSHELL_ENTRY), '# an operator-owned script\r\n')
  const refused = writeShimSet(winRoots)
  check('a foreign file at the entry path is refused, never clobbered', refused.members[2]?.state === 'refused-foreign' && readFileSync(join(bin, WIN32_POWERSHELL_ENTRY), 'utf8') === '# an operator-owned script\r\n')
  writeShimSet(winRoots, { force: true })
  const un = uninstallLayout(winRoots)
  check('uninstall removes all three managed members', un.removedSetMembers.length === 3 && !existsSync(join(bin, WIN32_POWERSHELL_ENTRY)) && !existsSync(join(bin, 'mercury')) && !existsSync(join(bin, 'mercury.cmd')))
}

section('(4) the git-bash facade: the Node road only for a boot the cmd launcher would not treat as bare, or one cmd.exe would rewrite')
const facade = shimContent(false)
check('the facade still delegates a bare boot to the versioned cmd launcher, byte for byte', facade.includes('if [ -f "$root/$ver/mercury.cmd" ]; then exec "$root/$ver/mercury.cmd" "$@"; fi'))
check('the Node road is gated on the versioned bundle beside the cmd launcher', facade.includes('if [ -f "$root/$ver/mercury.cmd" ] && [ -f "$root/$ver/mercury.mjs" ]; then'))
check('triggers: run as the verb, a leading-dash first argument, a non-TTY stdin', facade.includes('case "${1:-}" in run|-*) road=node ;; esac') && facade.includes('[ -t 0 ] || road=node'))
check('triggers: a print/help/version flag anywhere', facade.includes('-h|--help|-v|-V|--version) road=node ;;'))
check('triggers: an argument carrying % ^ & | < > " or a line break', facade.includes(`*['%^&|<>"']*) road=node ;;`) && facade.includes('*"$nl"*) road=node ;;'))
check('three runtime rungs in the cmd launcher\'s order: MERCURY_NODE, vendor/node/node.exe beside the bundle, a PATH node', facade.indexOf('MERCURY_NODE:-') !== -1 && facade.indexOf('MERCURY_NODE:-') < facade.indexOf('vendor/node/node.exe"') && facade.indexOf('vendor/node/node.exe"') < facade.indexOf('command -v node >/dev/null'))
check('the full range is checked (major, no prerelease, the minor floor) with the launchers\' words', facade.includes('is required (found') && facade.includes('*-*) node_unsupported') && facade.includes('-ge 20 ] || node_unsupported'))
check('the three-rung refusal carries the launchers\' words', facade.includes('no usable Node runtime — none of the three rungs answered:'))
check('the console code page is set as the cmd launcher sets it, with the PRESET marker', facade.includes('chcp.com 65001 >/dev/null 2>&1 && export MERCURY_WIN32_UTF8_PRESET=1'))
check('the compile cache uses the home the root block resolved (no second rung test) and the 200-character bound', facade.includes('cygpath -w "$home/compile-cache"') && facade.includes('[ -n "${home:-}" ] &&') && facade.includes('-le 200 ]'))
check('the post-child heal after a non-zero exit is the cmd launcher\'s sequence, TTY-gated', facade.includes(`[ -t 1 ] && [ "$rt" != "0" ]`) && facade.includes("?1049l\\x1b[?1004l\\x1b[?25h\\x1b]111\\x07"))
check('the Node road exits with the runtime\'s code', facade.includes('exit $rt'))

section('(5) the facade decides for real: a fixture layout with a cmd launcher that announces itself and a bundle that echoes argv')
{
  const fx = join(scratch, 'fx')
  const versions = join(fx, 'versions')
  const vdir = join(versions, '9.9.0-beta.2')
  mkdirSync(vdir, { recursive: true })
  writeFileSync(join(versions, 'current.txt'), '9.9.0-beta.2\n')
  writeFileSync(join(vdir, 'mercury.cmd'), '#!/bin/sh\necho CMD-ROAD\nexit 0\n')
  chmodSync(join(vdir, 'mercury.cmd'), 0o755)
  writeFileSync(join(vdir, 'mercury.mjs'), 'process.stdout.write("NODE-ROAD " + JSON.stringify(process.argv.slice(2)) + "\\n"); process.exit(Number(process.env.FX_EXIT ?? 0))\n')
  mkdirSync(join(vdir, 'vendor', 'node'), { recursive: true })
  const realNode = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
  writeFileSync(join(vdir, 'vendor', 'node', 'node.exe'), `#!/bin/sh\nexec "${realNode}" "$@"\n`)
  chmodSync(join(vdir, 'vendor', 'node', 'node.exe'), 0o755)
  const facadePath = join(fx, 'mercury')
  writeFileSync(facadePath, facade)
  chmodSync(facadePath, 0o755)
  const env = { ...process.env, MERCURY_VERSIONS_DIR: versions, MERCURY_CONFIG_DIR: join(fx, 'home'), MERCURY_LOCAL_PROBE_TARGETS: 'none', NODE_DISABLE_COMPILE_CACHE: '1' }
  const run = (args: string[], extra: Record<string, string> = {}) => spawnSync('sh', [facadePath, ...args], { encoding: 'utf8', env: { ...env, ...extra }, input: '', timeout: 30_000 })

  const r1 = run(['run', 'keep [50% done ^caret %USERPROFILE% end]'])
  check('run + a prompt with % and ^: the Node road, the argument intact', r1.stdout.startsWith('NODE-ROAD ') && r1.stdout.includes('"keep [50% done ^caret %USERPROFILE% end]"'), `status=${r1.status} out=${r1.stdout.slice(0, 120)} err=${r1.stderr.slice(0, 200)}`)
  const r2 = run(['run', 'Line one.\nLine two.'])
  check('run + a two-line prompt: both lines arrive', r2.stdout.includes('"Line one.\\nLine two."'), r2.stdout.slice(0, 120))
  const r3 = run(['--version'])
  check('a leading-dash first argument takes the Node road', r3.stdout.startsWith('NODE-ROAD ["--version"]'), r3.stdout.slice(0, 80))
  const r4 = run(['health'])
  check('a verb other than run, stdin not a TTY: the Node road (the cmd launcher would not treat a piped boot as bare)', r4.stdout.startsWith('NODE-ROAD ["health"]'), r4.stdout.slice(0, 80))
  const r5 = run(['run', 'x'], { FX_EXIT: '3' })
  check('the Node road propagates the runtime\'s exit code', r5.status === 3, `status=${r5.status}`)
  const r6 = run(['run', 'x'], { MERCURY_NODE: join(fx, 'absent-node') })
  check('a pinned-but-missing MERCURY_NODE refuses with the three-rung words, exit 1', r6.status === 1 && r6.stderr.includes('none of the three rungs answered'), `status=${r6.status} err=${r6.stderr.slice(0, 160)}`)
  const oldNode = join(fx, 'old-node')
  writeFileSync(oldNode, '#!/bin/sh\ncase "$1" in -e) printf 22.21.0; exit 0 ;; -v) echo v22.21.0; exit 0 ;; esac\nexit 0\n')
  chmodSync(oldNode, 0o755)
  const r7 = run(['run', 'x'], { MERCURY_NODE: oldNode })
  check('an unsupported Node refuses with the version words, exit 1', r7.status === 1 && r7.stderr.includes('is required (found v22.21.0'), `status=${r7.status} err=${r7.stderr.slice(0, 200)}`)

  const script = spawnSync('which', ['script'], { encoding: 'utf8' }).stdout.trim()
  if (script && process.platform === 'darwin') {
    const tty = (args: string[]) => spawnSync('script', ['-q', '/dev/null', 'sh', facadePath, ...args], { encoding: 'utf8', env, timeout: 30_000 })
    const t1 = tty([])
    check('TTY, bare boot: the cmd road exactly (the enter screen and the provenance line stay the cmd launcher\'s)', t1.stdout.includes('CMD-ROAD') && !t1.stdout.includes('NODE-ROAD'), t1.stdout.slice(0, 120))
    const t2 = tty(['fix the parser'])
    check('TTY, a bare positional prompt without metacharacters: the cmd road exactly', t2.stdout.includes('CMD-ROAD') && !t2.stdout.includes('NODE-ROAD'), t2.stdout.slice(0, 120))
    const t3 = tty(['health'])
    check('TTY, a verb other than run: the cmd road (unchanged from the previous release)', t3.stdout.includes('CMD-ROAD') && !t3.stdout.includes('NODE-ROAD'), t3.stdout.slice(0, 120))
    const t4 = tty(['fix the %age% calc'])
    check('TTY, a bare positional prompt carrying %: the Node road, the prompt intact', t4.stdout.includes('NODE-ROAD') && t4.stdout.includes('%age%'), t4.stdout.slice(0, 120))
    const t5 = tty(['run', 'fix it'])
    check('TTY, run: the Node road', t5.stdout.includes('NODE-ROAD ["run","fix it"]'), t5.stdout.slice(0, 120))
  } else {
    console.log('  [SKIP] TTY legs need BSD script(1) on macOS — the piped legs above cover the decision')
  }
}

section('(6) the words: the Windows page and the install note name the two roads a script has')
{
  const page = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'INSTALL-WINDOWS-FROM-SOURCE.md'), 'utf8')
  check('the Windows page names the PowerShell entry road', page.includes('mercury-powershell run'))
  check('the Windows page names the standard-input road for cmd.exe', page.includes('mercury run --format rows - < prompt.txt'))
  check('the Windows page says what cmd.exe does to a command-line prompt', page.includes('`%NAME%` is expanded and a line break ends the command'))
  check('the Windows page keeps the bare boot unchanged in words', page.includes('a bare `mercury` opens the enter screen as before'))
  check('the Windows page names nothing as old or removed', !/\b(old|removed|deprecated|legacy)\b/i.test(page.slice(page.indexOf('### A prompt from a script'), page.indexOf('## 10. Make a'))))
  // @ts-ignore -- untyped .mjs module
  const templates = await import('../release/launcherTemplates.mjs')
  const installing: string = templates.installingDoc(templates.parseEnginesNode('>=24.20.0 <25'), '9.9.9')
  check('INSTALLING.md names the PowerShell entry beside the stable command', installing.includes('mercury-powershell.ps1') && installing.includes('mercury-powershell run "<prompt>"'))
  check('INSTALLING.md names the standard-input road', installing.includes('mercury run - < prompt.txt'))
}

if (failures > 0) {
  console.log(`\nRED: ${failures} check(s) failed — prove-windows-faithful-entries`)
  process.exit(1)
}
console.log('\nGREEN: the Windows faithful entries hold — prove-windows-faithful-entries')
process.exit(0)
