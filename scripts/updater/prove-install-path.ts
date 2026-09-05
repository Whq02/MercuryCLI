#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PathEntryIo, PathEntryOutcome, UserPathRead } from '../../src/services/privateChannel/installPath.js'
import type { LayoutRoots } from '../../src/services/privateChannel/installLayout.js'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

const scratch = mkdtempSync(join(tmpdir(), 'install path '))
process.env.HOME = join(scratch, 'home-import')
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home-import', '.mercury')
mkdirSync(process.env.HOME, { recursive: true })
for (const k of ['MERCURY_HOME', 'MERCURY_VERSIONS_DIR', 'MERCURY_USER_PATH_FILE', 'MERCURY_UPDATE_FAULT']) delete process.env[k]

const {
  ensureBinDirOnPath,
  manualPathLine,
  parseUserPathReadOutput,
  PATH_SENTINEL,
  planBinDirOnPath,
  realPathEntryIo,
  shGuardedLine,
  spellUnderHome,
  textNamesDir,
  userPathListsDir,
  WIN32_READ_USER_PATH_PS1,
  WIN32_USER_PATH_STORE,
  WIN32_WRITE_USER_PATH_PS1,
} = await import('../../src/services/privateChannel/installPath.js')
const { describePathOutcome } = await import('../../src/cli/installVerb.js')
const { cmdLauncher, parseEnginesNode, posixLauncher, ps1Launcher } = (await import('../release/launcherTemplates.mjs')) as {
  cmdLauncher: (p: unknown) => string
  parseEnginesNode: (range: string | undefined) => unknown
  posixLauncher: (p: unknown) => string
  ps1Launcher: (p: unknown) => string
}
const { readCompatFloor, releaseLayoutSection } = (await import('../release/payloadContract.mjs')) as {
  readCompatFloor: () => unknown
  releaseLayoutSection: (dir: string, target: string, floor: unknown) => Record<string, unknown>
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string; engines?: { node?: string } }
const VERSION = pkg.version
const NODE_POLICY = parseEnginesNode(pkg.engines?.node)
const IS_WIN = process.platform === 'win32'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n── ${title} ──`)
const count = (text: string, needle: string): number => text.split(needle).length - 1
const has = (cmd: string): boolean => spawnSync(IS_WIN ? 'where' : 'sh', IS_WIN ? [cmd] : ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0

interface FakeOpts {
  home: string
  env?: Record<string, string>
  files?: Record<string, string>
  resolve?: string | null
  userPath?: UserPathRead
  failAppend?: string
  failRead?: boolean
  failWrite?: string
}
function fakeIo(opts: FakeOpts) {
  const files = new Map(Object.entries(opts.files ?? {}))
  const appends: { path: string; text: string }[] = []
  const writes: { expected: string; value: string; kind: string }[] = []
  let resolves = 0
  const io: PathEntryIo = {
    env: { PATH: '/usr/bin:/bin', ...(opts.env ?? {}) },
    home: opts.home,
    readFile: p => {
      if (opts.failRead) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' })
      return files.get(p) ?? null
    },
    appendFile: (p, t) => {
      if (opts.failAppend !== undefined && p.endsWith(opts.failAppend)) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' })
      }
      files.set(p, (files.get(p) ?? '') + t)
      appends.push({ path: p, text: t })
    },
    resolveCommand: () => {
      resolves++
      return opts.resolve ?? null
    },
    readUserPath: () => opts.userPath ?? { state: 'failed', note: 'no store in this fixture' },
    writeUserPath: (expected, value, kind) => {
      if (opts.failWrite !== undefined) throw new Error(opts.failWrite)
      writes.push({ expected, value, kind })
    },
  }
  return { io, files, appends, writes, resolves: () => resolves }
}

const HOME_P = '/home/sam'
const posixRoots = (home: string, binDir = join(home, '.local', 'bin')): LayoutRoots => ({
  versionsDir: join(home, '.mercury', 'versions'),
  binDir,
  shimPath: join(binDir, 'mercury'),
  shimSetPaths: [join(binDir, 'mercury')],
  isWindows: false,
})
const WIN_BIN = 'C:\\Users\\Sam\\AppData\\Local\\Mercury\\bin'
const winRoots: LayoutRoots = {
  versionsDir: 'C:\\Users\\Sam\\.mercury\\versions',
  binDir: WIN_BIN,
  shimPath: `${WIN_BIN}\\mercury.cmd`,
  shimSetPaths: [`${WIN_BIN}\\mercury.cmd`, `${WIN_BIN}\\mercury`],
  isWindows: true,
}
const P_LINE = 'export PATH="$HOME/.local/bin:$PATH"'
const P_GUARD = `${shGuardedLine('$HOME/.local/bin')}\n`

section('§1 the POSIX decision through the seam')
{
  const roots = posixRoots(HOME_P)
  {
    const f = fakeIo({ home: HOME_P, env: { PATH: `/usr/bin:${HOME_P}/.local/bin/:/bin`, SHELL: '/bin/zsh' } })
    const out = ensureBinDirOnPath(roots, f.io)
    check('the folder on this process PATH (any spelling) ⇒ on-path, no lookup, no write', out.state === 'on-path' && f.resolves() === 0 && f.appends.length === 0)
    check('the on-path line is calm', describePathOutcome(out, false, HOME_P) === `PATH: ${HOME_P}/.local/bin is already on your PATH`)
  }
  {
    const f = fakeIo({ home: HOME_P, env: { SHELL: '/bin/zsh' }, resolve: '/opt/other/bin/mercury' })
    const out = ensureBinDirOnPath(roots, f.io)
    check('a `mercury` that already resolves elsewhere ⇒ reachable, PATH unchanged, no write', out.state === 'reachable' && out.state === 'reachable' && out.resolved === '/opt/other/bin/mercury' && f.appends.length === 0)
    check('the reachable line says what runs and that nothing changed', describePathOutcome(out, false, HOME_P) === 'PATH: unchanged — a `mercury` command already runs from /opt/other/bin/mercury')
  }
  {
    const f = fakeIo({ home: HOME_P, env: { SHELL: '/bin/zsh' }, resolve: roots.shimPath })
    check('a lookup that lands on OUR shim counts as on-path', ensureBinDirOnPath(roots, f.io).state === 'on-path')
  }
  {
    const f = fakeIo({ home: HOME_P, env: { SHELL: '/bin/zsh' } })
    const plan = planBinDirOnPath(roots, f.io)
    check('the plan names ~/.zshrc and writes nothing', plan.state === 'would-write' && plan.targets.join() === `${HOME_P}/.zshrc` && f.appends.length === 0)
    check('the dry-run line names the act', describePathOutcome(plan, false, HOME_P) === `PATH: would add ${HOME_P}/.local/bin in ~/.zshrc`)
    const out = ensureBinDirOnPath(roots, f.io)
    check('zsh ⇒ written to ~/.zshrc, the current-shell line spelled with $HOME', out.state === 'written' && out.targets.join() === `${HOME_P}/.zshrc` && out.line === P_LINE)
    check('the file holds exactly the guarded line with the sentinel', f.files.get(`${HOME_P}/.zshrc`) === P_GUARD && count(P_GUARD, PATH_SENTINEL) === 1)
    check('the written line reads as one sentence', describePathOutcome(out, false, HOME_P) === `PATH: added ${HOME_P}/.local/bin in ~/.zshrc — open a new terminal, or run: ${P_LINE}`)
    check('the rest of this run sees the folder first on PATH', (f.io.env.PATH ?? '').startsWith(`${HOME_P}/.local/bin:`))
    const guard = shGuardedLine('$HOME/.local/bin')
    const once = spawnSync('sh', ['-c', `${guard}\nprintf '%s' "$PATH"`], { encoding: 'utf8', env: { HOME: HOME_P, PATH: '/usr/bin:/bin' } }).stdout
    const twice = spawnSync('sh', ['-c', `${guard}\n${guard}\nprintf '%s' "$PATH"`], { encoding: 'utf8', env: { HOME: HOME_P, PATH: '/usr/bin:/bin' } }).stdout
    check('the guarded line prepends the folder under sh', once === `${HOME_P}/.local/bin:/usr/bin:/bin`, once)
    check('the guard makes a second evaluation a no-op (sourced twice ⇒ once on PATH)', twice === once, twice)
    const zshOnce = has('zsh')
      ? spawnSync('zsh', ['-c', `${guard}\n${guard}\nprintf '%s' "$PATH"`], { encoding: 'utf8', env: { HOME: HOME_P, PATH: '/usr/bin:/bin' } }).stdout
      : once
    check('the same line behaves under zsh', zshOnce === once, zshOnce)
    f.io.env.PATH = '/usr/bin:/bin'
    const again = ensureBinDirOnPath(roots, f.io)
    check('a second run ⇒ present (the sentinel), the file untouched', again.state === 'present' && f.appends.length === 1 && f.files.get(`${HOME_P}/.zshrc`) === P_GUARD)
    check('the present line points at a new terminal', describePathOutcome(again, false, HOME_P) === `PATH: ~/.zshrc already names ${HOME_P}/.local/bin — open a new terminal, or run: ${P_LINE}`)
  }
  {
    const f = fakeIo({ home: HOME_P, env: { SHELL: '/usr/local/bin/zsh' }, files: { [`${HOME_P}/.zshrc`]: 'alias ll=ls' } })
    ensureBinDirOnPath(roots, f.io)
    check('an rc without a trailing newline gets the line on its own line', f.files.get(`${HOME_P}/.zshrc`) === `alias ll=ls\n${P_GUARD}`)
  }
  for (const own of ['export PATH="$HOME/.local/bin:$PATH"\n', 'PATH=~/.local/bin:$PATH\n', `export PATH=${HOME_P}/.local/bin:$PATH\n`, 'export PATH="${HOME}/.local/bin:$PATH"\n']) {
    const f = fakeIo({ home: HOME_P, env: { SHELL: '/bin/zsh' }, files: { [`${HOME_P}/.zshrc`]: own } })
    const out = ensureBinDirOnPath(roots, f.io)
    check(`an rc that already names the folder is left alone (${own.trim()})`, out.state === 'present' && f.appends.length === 0)
  }
  {
    const f = fakeIo({ home: HOME_P, env: { SHELL: '/bin/bash' } })
    const out = ensureBinDirOnPath(roots, f.io)
    check('bash with no profile ⇒ ~/.bashrc and ~/.profile (never a new ~/.bash_profile beside nothing else… the POSIX profile)', out.state === 'written' && out.targets.join() === `${HOME_P}/.bashrc,${HOME_P}/.profile`)
    check('both files carry the line exactly once', count(f.files.get(`${HOME_P}/.bashrc`) ?? '', PATH_SENTINEL) === 1 && count(f.files.get(`${HOME_P}/.profile`) ?? '', PATH_SENTINEL) === 1)
    check('the bash line names both files', describePathOutcome(out, false, HOME_P) === `PATH: added ${HOME_P}/.local/bin in ~/.bashrc and ~/.profile — open a new terminal, or run: ${P_LINE}`)
  }
  {
    const f = fakeIo({ home: HOME_P, env: { SHELL: '/bin/bash' }, files: { [`${HOME_P}/.bash_profile`]: '# mine\n' } })
    const out = ensureBinDirOnPath(roots, f.io)
    check('bash with an existing ~/.bash_profile ⇒ that profile (the first bash reads)', out.state === 'written' && out.targets.join() === `${HOME_P}/.bashrc,${HOME_P}/.bash_profile`)
  }
  {
    const f = fakeIo({ home: HOME_P, env: { SHELL: '/bin/bash' }, files: { [`${HOME_P}/.profile`]: '# mine\n' } })
    const out = ensureBinDirOnPath(roots, f.io)
    check('bash with only ~/.profile ⇒ ~/.profile (a new ~/.bash_profile would silence it)', out.state === 'written' && out.targets.join() === `${HOME_P}/.bashrc,${HOME_P}/.profile` && !f.files.has(`${HOME_P}/.bash_profile`))
  }
  {
    const stock = '# set PATH so it includes user\'s private bin if it exists\nif [ -d "$HOME/.local/bin" ] ; then\n    PATH="$HOME/.local/bin:$PATH"\nfi\n'
    const f = fakeIo({ home: HOME_P, env: { SHELL: '/bin/bash' }, files: { [`${HOME_P}/.profile`]: stock } })
    const out = ensureBinDirOnPath(roots, f.io)
    check('the stock ~/.profile block that adds ~/.local/bin at login ⇒ present, nothing written', out.state === 'present' && out.targets.join() === `${HOME_P}/.profile` && f.appends.length === 0)
  }
  {
    const f = fakeIo({ home: HOME_P, env: { SHELL: '/usr/bin/fish' } })
    const out = ensureBinDirOnPath(roots, f.io)
    const conf = f.files.get(`${HOME_P}/.config/fish/conf.d/mercury.fish`) ?? ''
    check('fish ⇒ its own conf.d file, fish_add_path with the contains fallback', out.state === 'written' && out.targets.join() === `${HOME_P}/.config/fish/conf.d/mercury.fish` && conf.includes('fish_add_path --path "$HOME/.local/bin"') && conf.includes('set -gx PATH "$HOME/.local/bin" $PATH') && conf.includes(PATH_SENTINEL))
    check('the fish current-shell line is fish_add_path', out.line === 'fish_add_path "$HOME/.local/bin"')
    f.io.env.PATH = '/usr/bin:/bin'
    check('a second fish run ⇒ present', ensureBinDirOnPath(roots, f.io).state === 'present' && f.appends.length === 1)
    const g = fakeIo({ home: HOME_P, env: { SHELL: '/usr/bin/fish' }, files: { [`${HOME_P}/.config/fish/config.fish`]: 'fish_add_path ~/.local/bin\n' } })
    check('a config.fish that already names the folder ⇒ present', ensureBinDirOnPath(roots, g.io).state === 'present' && g.appends.length === 0)
  }
  {
    const f = fakeIo({ home: HOME_P, env: { SHELL: '/bin/tcsh' } })
    const out = ensureBinDirOnPath(roots, f.io)
    check('an unknown shell ⇒ refused, nothing written, the exact line named', out.state === 'refused' && out.reason.includes('tcsh') && out.line === P_LINE && f.appends.length === 0)
    check('the refusal is the note, and it names the line', describePathOutcome(out, false, HOME_P) === `note: ${HOME_P}/.local/bin is not on your PATH — your shell (tcsh) has no startup file this installer knows; add it yourself: ${P_LINE}`)
    const g = fakeIo({ home: HOME_P })
    const unset = ensureBinDirOnPath(roots, g.io)
    check('SHELL unset ⇒ refused, nothing written', unset.state === 'refused' && unset.reason.includes('SHELL is not set') && g.appends.length === 0)
  }
  {
    const f = fakeIo({ home: HOME_P, env: { SHELL: '/bin/bash' }, failAppend: '.profile' })
    const out = ensureBinDirOnPath(roots, f.io)
    check('a permission failure ⇒ refused, naming the file, the error and what was already written', out.state === 'refused' && out.reason.includes('could not write ~/.profile') && out.reason.includes('EACCES') && out.reason.includes('already written: ~/.bashrc'))
    check('the PATH of this run is not extended after a refusal', !(f.io.env.PATH ?? '').includes('.local/bin'))
    const g = fakeIo({ home: HOME_P, env: { SHELL: '/bin/zsh' }, failRead: true })
    const read = ensureBinDirOnPath(roots, g.io)
    check('an unreadable startup file ⇒ refused before any write', read.state === 'refused' && read.reason.includes('could not be read') && g.appends.length === 0)
  }
  {
    const outside = posixRoots(HOME_P, '/opt/mercury/bin')
    const f = fakeIo({ home: HOME_P, env: { SHELL: '/bin/zsh' } })
    const out = ensureBinDirOnPath(outside, f.io)
    check('a folder outside the home is spelled absolute', out.state === 'written' && out.line === 'export PATH="/opt/mercury/bin:$PATH"' && (f.files.get(`${HOME_P}/.zshrc`) ?? '').includes('"/opt/mercury/bin:$PATH"'))
    check('spellUnderHome: under the home ⇒ $HOME, the home itself, outside ⇒ absolute, ~ on request', spellUnderHome('/home/sam/.local/bin', '/home/sam/') === '$HOME/.local/bin' && spellUnderHome('/home/sam', '/home/sam') === '$HOME' && spellUnderHome('/opt/x', '/home/sam') === '/opt/x' && spellUnderHome('/home/sam/.zshrc', '/home/sam', '~') === '~/.zshrc')
    check('textNamesDir: sentinel, absolute, $HOME, ${HOME}, ~ — and not a different folder', textNamesDir(`# ${PATH_SENTINEL}`, '/home/sam/.local/bin', HOME_P) && textNamesDir('/home/sam/.local/bin', '/home/sam/.local/bin', HOME_P) && textNamesDir('${HOME}/.local/bin', '/home/sam/.local/bin', HOME_P) && !textNamesDir('export PATH="$HOME/bin:$PATH"', '/home/sam/.local/bin', HOME_P))
  }
}

section('§2 the win32 decision through the seam — the law of the empty value')
{
  const STOCK = '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps'
  const W_LINE = manualPathLine(winRoots, { env: {}, home: 'C:\\Users\\Sam' })
  check('the win32 by-hand line is the settings route, never a shell line that can wipe', W_LINE.startsWith('Settings › ') && W_LINE.endsWith(`Path › New: ${WIN_BIN}`))
  {
    const f = fakeIo({ home: 'C:\\Users\\Sam', userPath: { state: 'failed', note: 'boom' } })
    const out = ensureBinDirOnPath(winRoots, f.io)
    check('a FAILED read ⇒ refused, no write, the note carried', out.state === 'refused' && out.reason.includes('could not be read (boom)') && f.writes.length === 0)
    check('the refusal names the settings route', describePathOutcome(out, true) === `note: ${WIN_BIN} is not on your PATH — ${out.reason}; add it yourself: ${W_LINE}`)
  }
  {
    const f = fakeIo({ home: 'C:\\Users\\Sam', userPath: { state: 'absent' } })
    const out = ensureBinDirOnPath(winRoots, f.io)
    check('an ABSENT value ⇒ refused, no write', out.state === 'refused' && out.reason.includes('no value') && f.writes.length === 0)
  }
  for (const empty of ['', '   ', ';;', ' ; ']) {
    const f = fakeIo({ home: 'C:\\Users\\Sam', userPath: { state: 'ok', value: empty, kind: 'ExpandString' } })
    const out = ensureBinDirOnPath(winRoots, f.io)
    check(`an EMPTY value (${JSON.stringify(empty)}) ⇒ refused, no write — never written over`, out.state === 'refused' && out.reason.includes('empty') && f.writes.length === 0)
  }
  {
    const f = fakeIo({ home: 'C:\\Users\\Sam', env: { PATH: 'C:\\Windows\\System32;C:\\Windows' }, userPath: { state: 'ok', value: STOCK, kind: 'ExpandString' } })
    const out = ensureBinDirOnPath(winRoots, f.io)
    check('a real value ⇒ written: appended once at the end, the %VAR% spelling kept, the kind kept, compare-and-swap on the read', out.state === 'written' && out.targets.join() === WIN32_USER_PATH_STORE && f.writes.length === 1 && f.writes[0]!.expected === STOCK && f.writes[0]!.value === `${STOCK};${WIN_BIN}` && f.writes[0]!.kind === 'ExpandString')
    check('the rest of this run sees the folder at the end of PATH (the Windows order)', f.io.env.PATH === `C:\\Windows\\System32;C:\\Windows;${WIN_BIN}`)
    check('the written line reads as one sentence', describePathOutcome(out, true) === `PATH: added ${WIN_BIN} to your user PATH — open a new terminal`)
  }
  {
    const f = fakeIo({ home: 'C:\\Users\\Sam', userPath: { state: 'ok', value: 'C:\\Tools;', kind: 'String' } })
    ensureBinDirOnPath(winRoots, f.io)
    check('a trailing ; is trimmed before the append, and REG_SZ stays REG_SZ', f.writes[0]?.value === `C:\\Tools;${WIN_BIN}` && f.writes[0]?.kind === 'String')
  }
  {
    const env = { LOCALAPPDATA: 'C:\\Users\\Sam\\AppData\\Local' }
    const f = fakeIo({ home: 'C:\\Users\\Sam', env, userPath: { state: 'ok', value: `${STOCK};%LOCALAPPDATA%\\Mercury\\bin`, kind: 'ExpandString' } })
    const out = ensureBinDirOnPath(winRoots, f.io)
    check('a value that lists the folder as %LOCALAPPDATA%\\… ⇒ present, no write', out.state === 'present' && f.writes.length === 0)
    check('the present line says the user PATH lists it', describePathOutcome(out, true) === `PATH: your user PATH already lists ${WIN_BIN} — open a new terminal`)
    const g = fakeIo({ home: 'C:\\Users\\Sam', userPath: { state: 'ok', value: `${STOCK};c:\\users\\sam\\appdata\\local\\mercury\\BIN\\`, kind: 'ExpandString' } })
    check('a value that lists it in another case with a trailing backslash ⇒ present', ensureBinDirOnPath(winRoots, g.io).state === 'present' && g.writes.length === 0)
    check('userPathListsDir ignores empty entries and unknown %VARS%', !userPathListsDir(';%NOPE%\\x;', WIN_BIN, {}) && userPathListsDir(`x;${WIN_BIN}`, WIN_BIN, {}))
  }
  {
    const f = fakeIo({ home: 'C:\\Users\\Sam', userPath: { state: 'ok', value: STOCK, kind: 'ExpandString' }, failWrite: 'the user PATH changed since it was read; nothing was written' })
    const out = ensureBinDirOnPath(winRoots, f.io)
    check('a store that moved between read and write ⇒ refused with the store\'s own words', out.state === 'refused' && out.reason === 'the user PATH changed since it was read; nothing was written')
  }
  {
    const store = join(scratch, 'user-path.json')
    process.env.MERCURY_USER_PATH_FILE = store
    const io = (): PathEntryIo => ({ ...realPathEntryIo(), env: { PATH: '/usr/bin:/bin' }, home: 'C:\\Users\\Sam', resolveCommand: () => null })
    const absent = ensureBinDirOnPath(winRoots, io())
    check('the file store: no file ⇒ absent ⇒ refused, no file created', absent.state === 'refused' && !existsSync(store))
    writeFileSync(store, `${JSON.stringify({ kind: 'ExpandString', value: STOCK })}\n`)
    const written = ensureBinDirOnPath(winRoots, io())
    const after = JSON.parse(readFileSync(store, 'utf8')) as { kind: string; value: string }
    check('the file store: seeded ⇒ written in place, kind and spelling kept', written.state === 'written' && after.kind === 'ExpandString' && after.value === `${STOCK};${WIN_BIN}`)
    check('the file store: a second run ⇒ present', ensureBinDirOnPath(winRoots, io()).state === 'present')
    let moved = ''
    try {
      io().writeUserPath('stale', 'stale;x', 'ExpandString')
    } catch (e) {
      moved = e instanceof Error ? e.message : String(e)
    }
    check('the file store refuses a write whose read went stale', moved.includes('changed since it was read'))
    let empty = ''
    try {
      io().writeUserPath(after.value, '', 'ExpandString')
    } catch (e) {
      empty = e instanceof Error ? e.message : String(e)
    }
    check('the file store refuses an empty write outright', empty.includes('empty'))
    writeFileSync(store, 'not json\n')
    check('the file store: a malformed record ⇒ failed read ⇒ refused', ensureBinDirOnPath(winRoots, io()).state === 'refused')
    delete process.env.MERCURY_USER_PATH_FILE
  }
  {
    const read = WIN32_READ_USER_PATH_PS1
    const write = WIN32_WRITE_USER_PATH_PS1
    check('the reader opens HKCU\\Environment read-only and reads Path UNEXPANDED', read.includes("OpenSubKey('Environment', $false)") && read.includes('DoNotExpandEnvironmentNames'))
    check('the reader answers ABSENT / FAILED / KIND + VALUE on separate first lines', read.includes("Write-Output 'ABSENT'") && read.includes("'FAILED ") && read.includes("'KIND ' + $kind.ToString()") && read.includes("'VALUE ' + [string]$raw"))
    check('the writer takes value, expected and kind from the ENVIRONMENT, never the command text', write.includes('$env:MERCURY_PATH_EXPECTED') && write.includes('$env:MERCURY_PATH_VALUE') && write.includes('$env:MERCURY_PATH_KIND') && !write.includes('${'))
    check('the writer refuses an empty value and a moved value (case-sensitive compare) before touching the key', write.indexOf("'EMPTY ") >= 0 && write.indexOf("'EMPTY ") < write.indexOf('SetValue') && write.includes('-cne $expected') && write.indexOf("'MOVED ") >= 0 && write.indexOf("'MOVED ") < write.indexOf('SetValue'))
    check('the writer keeps the kind (ExpandString by default, String when read so)', write.includes("$key.SetValue('Path', $value, $kind)") && write.includes('RegistryValueKind]::ExpandString') && write.includes("if ($kindName -eq 'String')"))
    check('the writer broadcasts WM_SETTINGCHANGE (SendMessageTimeout, 0x1A, Environment) to every top-level window, crash-swallowed', write.includes('SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, \'Environment\'') && /try \{\n\s*Add-Type[\s\S]*?\} catch \{ \}/.test(write))
    check('the here-string closes at the start of a line', /\n'@\n/.test(write))
    check('neither block uses the $_ automatic variable ($PSItem stands in — a pasted block survives markdown)', !read.includes('$_') && !write.includes('$_'))
    check('parse: ABSENT', parseUserPathReadOutput('ABSENT\r\n').state === 'absent')
    const failed = parseUserPathReadOutput('FAILED boom\r\n')
    check('parse: FAILED carries the note', failed.state === 'failed' && failed.note === 'boom')
    const ok = parseUserPathReadOutput('KIND ExpandString\r\nVALUE %A%;B \r\n')
    check('parse: KIND + VALUE, the value byte-exact (trailing space kept, CR stripped)', ok.state === 'ok' && ok.kind === 'ExpandString' && ok.value === '%A%;B ')
    check('parse: another kind ⇒ failed (only REG_EXPAND_SZ / REG_SZ are written)', parseUserPathReadOutput('KIND Binary\r\nVALUE x\r\n').state === 'failed')
    check('parse: garbage ⇒ failed', parseUserPathReadOutput('').state === 'failed' && parseUserPathReadOutput('hello').state === 'failed')
    if (has('pwsh')) {
      const parseScript = [
        '$errs = $null',
        '$tokens = $null',
        '[System.Management.Automation.Language.Parser]::ParseFile($env:MERCURY_PS1_FILE, [ref]$tokens, [ref]$errs) | Out-Null',
        'Write-Output $errs.Count',
      ].join('\n')
      for (const [name, text] of [['reader', read], ['writer', write]] as const) {
        const file = join(scratch, `${name}.ps1`)
        writeFileSync(file, text)
        const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', parseScript], { encoding: 'utf8', env: { ...process.env, MERCURY_PS1_FILE: file }, timeout: 60_000 })
        check(`pwsh parses the ${name} block with zero errors`, r.status === 0 && r.stdout.trim() === '0', (r.stdout + r.stderr).slice(0, 200))
      }
      if (!IS_WIN) {
        const io: PathEntryIo = { ...realPathEntryIo({ powershell: () => 'pwsh' }), env: { PATH: '/usr/bin:/bin' }, home: 'C:\\Users\\Sam', resolveCommand: () => null }
        const out = ensureBinDirOnPath(winRoots, io)
        check('a real pwsh run on a host without a registry ⇒ the read fails ⇒ refused, nothing written', out.state === 'refused' && out.reason.includes('could not be read'), out.state === 'refused' ? out.reason : out.state)
      }
    } else {
      console.log('  [SKIP] pwsh is not installed here — the blocks are pinned by text only')
    }
  }
}

section('§3 the REAL bundle through the REAL launcher: a new terminal finds mercury')
if (IS_WIN) {
  console.log('  [SKIP] §3/§4 drive the POSIX launcher and POSIX shells — the cmd launcher rides windows-launcher.yml on a real ConPTY')
} else {
  const DIST = join(ROOT, 'dist')
  if (!existsSync(join(DIST, 'mercury.mjs'))) {
    console.log('  [FAIL] dist/mercury.mjs absent — run bun run build.ts first')
    failures++
  } else {
    const payload = join(scratch, 'payload', 'mercury')
    mkdirSync(payload, { recursive: true })
    for (const member of ['mercury.mjs', 'manifest.json', 'splash.mjs', 'splash-core.mjs', 'verify-artifact.mjs']) cpSync(join(DIST, member), join(payload, member))
    cpSync(join(DIST, 'vendor', 'ripgrep'), join(payload, 'vendor', 'ripgrep'), { recursive: true })
    writeFileSync(join(payload, 'mercury'), posixLauncher(NODE_POLICY))
    writeFileSync(join(payload, 'install.sh'), '#!/bin/sh\n# fixture installer stub\n')
    for (const f of ['mercury', 'install.sh']) chmodSync(join(payload, f), 0o755)
    for (const doc of ['README-FIRST.md', 'INSTALLING.md', 'UPDATING.md', 'RELEASE-NOTES.md', 'NOTICES.md']) writeFileSync(join(payload, doc), `# fixture ${doc}\n`)
    writeFileSync(join(payload, 'mercury-vscode.vsix'), 'fixture-vsix\n')
    const manifest = JSON.parse(readFileSync(join(payload, 'manifest.json'), 'utf8')) as Record<string, unknown>
    const TARGET = process.platform === 'darwin' ? 'macos-arm64' : 'linux-x64'
    manifest.releaseLayout = releaseLayoutSection(payload, TARGET, readCompatFloor())
    writeFileSync(join(payload, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const launcher = join(payload, 'mercury')

    const nodeBin = spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout.trim()
    const nodeDir = join(scratch, 'nodebin')
    mkdirSync(nodeDir)
    symlinkSync(nodeBin, join(nodeDir, 'node'))
    const HERMETIC_PATH = `${nodeDir}:/usr/bin:/bin`
    const baseEnv = (home: string, shell: string, extra: Record<string, string> = {}): Record<string, string> => ({
      PATH: HERMETIC_PATH,
      HOME: home,
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      SHELL: shell,
      CI: '1',
      TERM: 'dumb',
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_SPLASH: 'off',
      ...extra,
    })
    const run = (args: string[], home: string, shell: string, extra: Record<string, string> = {}, cmd = launcher) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 180_000, env: baseEnv(home, shell, extra) })
      return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` }
    }
    const newShellRun = (shell: string, flags: string, home: string, command: string) =>
      spawnSync(shell, [flags, '-c', command], { encoding: 'utf8', timeout: 60_000, env: { HOME: home, PATH: HERMETIC_PATH, TERM: 'dumb', MERCURY_NODE: nodeBin } })
    const newShell = (shell: string, flags: string, home: string, command = 'command -v mercury'): string =>
      (newShellRun(shell, flags, home, command).stdout ?? '').trim().split('\n').pop() ?? ''
    const home = (name: string): string => {
      const h = join(scratch, `home-${name}`)
      mkdirSync(h, { recursive: true })
      return h
    }

    {
      const h = home('zsh')
      const bin = join(h, '.local', 'bin')
      const r = run(['install'], h, '/bin/zsh')
      check('install from the archive launcher exits 0', r.code === 0, r.all.slice(0, 400))
      check('install says it added the folder in ~/.zshrc and names the current-shell line', r.stdout.includes(`PATH: added ${bin} in ~/.zshrc — open a new terminal, or run: ${P_LINE}`), r.stdout)
      check('the old moot note is gone', !r.stdout.includes('to your PATH to use'))
      const zshrc = existsSync(join(h, '.zshrc')) ? readFileSync(join(h, '.zshrc'), 'utf8') : ''
      check('~/.zshrc holds exactly the one guarded line', zshrc === P_GUARD)
      check('the line names the stable folder, never a version directory', zshrc.includes('$HOME/.local/bin') && !zshrc.includes('versions'))
      if (has('zsh')) {
        check('a NEW interactive login zsh finds mercury (the stable command)', newShell('zsh', '-il', h) === join(bin, 'mercury'), newShell('zsh', '-il', h))
        const v = newShellRun('zsh', '-il', h, 'mercury --version')
        check('… and it answers --version through the shim', (v.stdout ?? '').includes(VERSION), `exit ${v.status}: ${(v.stdout ?? '') + (v.stderr ?? '')}`.slice(0, 400))
      } else console.log('  [SKIP] zsh is not installed here')
      const again = run(['install'], h, '/bin/zsh')
      check('the second install writes nothing and says ~/.zshrc already names it', again.code === 0 && again.stdout.includes(`PATH: ~/.zshrc already names ${bin} — open a new terminal`) && readFileSync(join(h, '.zshrc'), 'utf8') === zshrc, again.stdout)
    }
    {
      const h = home('bash')
      const bin = join(h, '.local', 'bin')
      const r = run(['install'], h, '/bin/bash')
      check('bash: install writes ~/.bashrc and ~/.profile', r.code === 0 && r.stdout.includes(`PATH: added ${bin} in ~/.bashrc and ~/.profile`), r.stdout)
      check('each carries the line once', count(readFileSync(join(h, '.bashrc'), 'utf8'), PATH_SENTINEL) === 1 && count(readFileSync(join(h, '.profile'), 'utf8'), PATH_SENTINEL) === 1)
      check('a NEW interactive login bash finds mercury (via the profile)', newShell('bash', '-il', h) === join(bin, 'mercury'), newShell('bash', '-il', h))
      check('a NEW interactive non-login bash finds mercury (via ~/.bashrc)', newShell('bash', '-i', h) === join(bin, 'mercury'), newShell('bash', '-i', h))
    }
    if (has('fish')) {
      const h = home('fish')
      const bin = join(h, '.local', 'bin')
      const r = run(['install'], h, '/usr/bin/fish')
      check('fish: install writes its conf.d file', r.code === 0 && r.stdout.includes('conf.d/mercury.fish'), r.stdout)
      check('a NEW login fish finds mercury', newShell('fish', '-l', h) === join(bin, 'mercury'), newShell('fish', '-l', h))
    } else console.log('  [SKIP] fish is not installed here — the fish file is pinned through the seam (§1)')
    {
      const h = home('dry')
      const bin = join(h, '.local', 'bin')
      const r = run(['install', '--dry-run'], h, '/bin/zsh')
      check('--dry-run names the PATH act it would perform and writes nothing', r.code === 0 && r.stdout.includes(`PATH: would add ${bin} in ~/.zshrc`) && !existsSync(join(h, '.zshrc')), r.stdout)
      const j = run(['install', '--json'], h, '/bin/zsh')
      const parsed = JSON.parse(j.stdout) as { path?: PathEntryOutcome; binDirOnPath?: boolean }
      check('--json carries the outcome (state, dir, targets, line) and the untouched binDirOnPath observation', j.code === 0 && parsed.path?.state === 'written' && parsed.path.dir === bin && parsed.path.targets.join() === join(h, '.zshrc') && parsed.path.line === P_LINE && parsed.binDirOnPath === false, j.stdout.slice(0, 300))
    }
    {
      const h = home('tcsh')
      const bin = join(h, '.local', 'bin')
      const r = run(['install'], h, '/bin/tcsh')
      check('an unknown shell: the note names the folder, the reason and the exact line; nothing written', r.code === 0 && r.stdout.includes(`note: ${bin} is not on your PATH — your shell (tcsh) has no startup file this installer knows; add it yourself: ${P_LINE}`) && !existsSync(join(h, '.profile')) && !existsSync(join(h, '.zshrc')), r.stdout)
    }
    {
      const h = home('onpath')
      const bin = join(h, '.local', 'bin')
      mkdirSync(bin, { recursive: true })
      const r = run(['install'], h, '/bin/zsh', { PATH: `${bin}:${HERMETIC_PATH}` })
      check('a folder already on PATH ⇒ "already on your PATH", no startup file touched', r.code === 0 && r.stdout.includes(`PATH: ${bin} is already on your PATH`) && !existsSync(join(h, '.zshrc')), r.stdout)
    }
    {
      const h = home('reach')
      const other = join(scratch, 'otherbin')
      mkdirSync(other, { recursive: true })
      writeFileSync(join(other, 'mercury'), '#!/bin/sh\necho other\n')
      chmodSync(join(other, 'mercury'), 0o755)
      const r = run(['install'], h, '/bin/zsh', { PATH: `${other}:${HERMETIC_PATH}` })
      check('a `mercury` that already resolves (another launcher\'s hand-over) ⇒ PATH unchanged, no note, nothing written', r.code === 0 && r.stdout.includes(`PATH: unchanged — a \`mercury\` command already runs from ${join(other, 'mercury')}`) && !r.stdout.includes('note: ') && !existsSync(join(h, '.zshrc')), r.stdout)
    }
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      const h = home('readonly')
      writeFileSync(join(h, '.zshrc'), '# locked\n')
      chmodSync(join(h, '.zshrc'), 0o444)
      const r = run(['install'], h, '/bin/zsh')
      check('an unwritable ~/.zshrc ⇒ the note names the file, the error and the line; the install itself succeeds', r.code === 0 && r.stdout.includes('note: ') && r.stdout.includes('could not write ~/.zshrc') && r.stdout.includes('EACCES') && r.stdout.includes(`add it yourself: ${P_LINE}`) && r.stdout.includes('installed: '), r.stdout)
      check('the locked file is byte-identical', readFileSync(join(h, '.zshrc'), 'utf8') === '# locked\n')
      chmodSync(join(h, '.zshrc'), 0o644)
    } else console.log('  [SKIP] running as root — a read-only file is writable, the permission arm is pinned through the seam (§1)')

    section('§4 the launchers: ONE provenance line per session, and the terminal reaches the runtime')
    if (!has('python3')) {
      console.log('  [SKIP] python3 is not installed here — the PTY legs need it; the gate is pinned by text below')
    } else {
      const PTY_PY = [
        'import os, pty, select, sys',
        'argv = sys.argv[1:]',
        'pid, fd = pty.fork()',
        'if pid == 0:',
        '    os.execvp(argv[0], argv)',
        'out = b""',
        'while True:',
        '    ready, _, _ = select.select([fd], [], [], 120)',
        '    if fd not in ready:',
        '        out += b"[pty] timed out"',
        '        break',
        '    try:',
        '        data = os.read(fd, 65536)',
        '    except OSError:',
        '        break',
        '    if not data:',
        '        break',
        '    out += data',
        '_, status = os.waitpid(pid, 0)',
        'sys.stdout.buffer.write(out)',
        'sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128)',
      ].join('\n')
      const ptyRun = (argv: string[], env: Record<string, string>): { out: string; code: number } => {
        const r = spawnSync('python3', ['-c', PTY_PY, ...argv], { encoding: 'utf8', timeout: 180_000, env: { ...env, PYTHONIOENCODING: 'utf8' } })
        return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? -1 }
      }
      const PROVENANCE = 'mercury: provenance'
      {
        const h = home('pty')
        const bin = join(h, '.local', 'bin')
        const installed = ptyRun([launcher, 'install'], baseEnv(h, '/bin/zsh'))
        check('a real `install` under a PTY prints NO provenance line (it printed one per launcher boot before)', installed.code === 0 && installed.out.includes('installed: ') && count(installed.out, PROVENANCE) === 0, installed.out.slice(0, 300))
        const version = ptyRun([join(bin, 'mercury'), '--version'], baseEnv(h, '/bin/zsh'))
        check('the stable command answering --version under a PTY prints NO provenance line (a first run read it twice before)', version.code === 0 && version.out.includes(VERSION) && count(version.out, PROVENANCE) === 0, version.out.slice(0, 300))
      }
      {
        const fake = join(scratch, 'fake-node')
        const log = join(scratch, 'fake-node.log')
        writeFileSync(fake, ['#!/bin/sh', `case "$1" in -p) exec "${nodeBin}" "$@" ;; esac`, `if [ -t 0 ] && [ -t 1 ] && [ -t 2 ]; then t=tty; else t=notty; fi`, `printf '%s|%s\\n' "$t" "$*" >> "${log}"`, 'exit 0', ''].join('\n'))
        chmodSync(fake, 0o755)
        const h = home('fake')
        const drive = (args: string[], pty: boolean): string[] => {
          writeFileSync(log, '')
          const env = baseEnv(h, '/bin/zsh', { MERCURY_NODE: fake })
          if (pty) ptyRun([launcher, ...args], env)
          else spawnSync(launcher, args, { encoding: 'utf8', timeout: 60_000, env })
          return readFileSync(log, 'utf8').split('\n').filter(l => l !== '')
        }
        const bare = drive([], true)
        const verifyLines = bare.filter(l => l.includes('verify-artifact.mjs --launcher'))
        const bootLine = bare.find(l => l.includes('mercury.mjs'))
        check('a bare interactive boot runs the provenance verify exactly ONCE, before the boot line', verifyLines.length === 1 && bootLine !== undefined && bare.indexOf(verifyLines[0]!) < bare.indexOf(bootLine), bare.join(' / '))
        check('the boot line inherits the terminal (stdin, stdout and stderr are the PTY)', bootLine?.startsWith('tty|') === true, bootLine)
        check('a prompt argument (a takeover) keeps the line', drive(['fix it'], true).filter(l => l.includes('verify-artifact.mjs')).length === 1)
        for (const [label, args] of [['a verb (doctor)', ['doctor']], ['a verb (update --check)', ['update', '--check']], ['a dash-first flag (--continue)', ['--continue']], ['--version', ['--version']], ['-p', ['-p', 'hi']]] as const) {
          const lines = drive([...args], true)
          check(`${label} under a PTY runs no provenance verify`, lines.filter(l => l.includes('verify-artifact.mjs')).length === 0 && lines.some(l => l.includes('mercury.mjs')), lines.join(' / '))
        }
        const piped = drive([], false)
        check('a piped bare boot runs no provenance verify (byte-clean automation)', piped.filter(l => l.includes('verify-artifact.mjs')).length === 0 && piped.some(l => l.startsWith('notty|') && l.includes('mercury.mjs')), piped.join(' / '))
      }
    }
    {
      const posix = posixLauncher(NODE_POLICY)
      const cmd = cmdLauncher(NODE_POLICY)
      const ps1 = ps1Launcher(NODE_POLICY)
      check('POSIX: the bare-boot decision is computed BEFORE the verify and gates it', posix.indexOf('MERCURY_TAKEOVER=1') !== -1 && posix.indexOf('MERCURY_TAKEOVER=1') < posix.indexOf('verify-artifact.mjs" --launcher') && posix.includes('[ "$MERCURY_TAKEOVER" = "1" ] && [ -t 0 ] && [ -t 2 ] && [ -f "$dir/verify-artifact.mjs" ]'))
      check('POSIX: the decision is computed once (one assignment, one verb case)', count(posix, 'MERCURY_TAKEOVER=1') === 1 && count(posix, '-*) MERCURY_TAKEOVER=0 ;;') === 1)
      check('cmd: the bare-boot decision precedes and gates the verify', cmd.indexOf('set "MERCURY_TAKEOVER=1"') >= 0 && cmd.indexOf('set "MERCURY_TAKEOVER=1"') < cmd.indexOf('verify-artifact.mjs" --launcher') && cmd.includes('if "%MERCURY_TAKEOVER%"=="1" if exist "%DIR%verify-artifact.mjs"') && count(cmd, 'set "MERCURY_TAKEOVER=1"') === 1)
      check('PS1: the takeover verdict gates the verify', ps1.indexOf('$takeover = $true') >= 0 && ps1.indexOf('$takeover = $true') < ps1.indexOf("'verify-artifact.mjs') --launcher") && ps1.includes("if ($takeover -and $interactive -and (Test-Path (Join-Path $dir 'verify-artifact.mjs')))"))
      check('the boot line forwards the terminal untouched (no redirection on the runtime line)', posix.includes('"$node_bin" "$dir/mercury.mjs" "$@"\n') && cmd.includes('"%NODEBIN%" "%DIR%mercury.mjs" %*\r\n') && ps1.includes("& $nodeBin (Join-Path $dir 'mercury.mjs') @args\n"))
    }
  }
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-install-path: ${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`)
if (statSync(scratch).isDirectory() && failures === 0) {
  spawnSync('rm', ['-rf', scratch])
}
process.exit(failures === 0 ? 0 : 1)
