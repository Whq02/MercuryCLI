#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeScratch } from '../lib/removeScratch.ts'

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return root !== '' && rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

if (process.argv[2] === '--in-session') {
  const { resolveLayoutRoots } = await import('../../src/platform/update-channel/installLayout.js')
  const { ensureBinDirOnPath, realPathEntryIo, removeBinDirFromPath } = await import('../../src/platform/update-channel/installPath.js')
  const { describePathOutcome, describePathRemoval } = await import('../../src/commands/verbs/installVerb.js')
  const roots = resolveLayoutRoots()
  const own = process.env.MERCURY_PROOF_LAYOUT_SCRATCH ?? ''
  if (!inside(own, homedir()) || !inside(own, roots.binDir)) {
    console.log(`SAFETY: this session's home or command folder lies outside the proof's scratch: ${homedir()} · ${roots.binDir}`)
    process.exit(2)
  }
  if (process.argv[3] === 'uninstall') {
    const outcome = removeBinDirFromPath(roots, realPathEntryIo())
    console.log(JSON.stringify({ outcome, line: describePathRemoval(outcome, false) ?? '' }))
  } else {
    const outcome = ensureBinDirOnPath(roots, realPathEntryIo())
    console.log(JSON.stringify({ outcome, line: describePathOutcome(outcome, false) }))
  }
  process.exit(0)
}

if (process.platform === 'win32') {
  console.log('  [SKIP] a new terminal on Windows reads the user PATH, not a startup file — prove-install-path.ts §2 holds that law')
  process.exit(0)
}

const SELF = fileURLToPath(import.meta.url)
const BASE_PATH = '/usr/bin:/bin'
const STARTUP_FILES = ['.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshenv', '.zprofile', '.zshrc', '.zlogin', '.config/fish/config.fish', '.config/fish/conf.d/mercury.fish']
const STOCK_PROFILE = [
  'if [ -n "$BASH_VERSION" ]; then',
  '    if [ -f "$HOME/.bashrc" ]; then',
  '        . "$HOME/.bashrc"',
  '    fi',
  'fi',
  'if [ -d "$HOME/bin" ] ; then',
  '    PATH="$HOME/bin:$PATH"',
  'fi',
  'if [ -d "$HOME/.local/bin" ] ; then',
  '    PATH="$HOME/.local/bin:$PATH"',
  'fi',
  '',
].join('\n')
const STOCK_BASHRC = ['case $- in', '    *i*) ;;', '      *) return;;', 'esac', 'HISTCONTROL=ignoreboth', ''].join('\n')
const OWN_LINE = 'export PATH="$HOME/.local/bin:$PATH"\n'

type ShellName = 'bash' | 'zsh' | 'fish'
interface Terminal {
  what: string
  flags: string[]
}
interface Scene {
  name: string
  shell: ShellName
  has: Record<string, string>
  login: string | null
  writes: string[]
  terminals: Terminal[]
}

const WINDOW: Record<ShellName, Terminal> = {
  bash: { what: 'a terminal window of the session (a non-login interactive bash)', flags: ['-i'] },
  zsh: { what: 'a terminal window of the session (a non-login interactive zsh)', flags: ['-i'] },
  fish: { what: 'a terminal window of the session (an interactive fish)', flags: ['-i'] },
}
const LOGIN: Record<ShellName, Terminal> = {
  bash: { what: 'a login terminal (Terminal and iTerm on macOS, ssh)', flags: ['-l', '-i'] },
  zsh: { what: 'a login terminal (Terminal and iTerm on macOS, ssh)', flags: ['-l', '-i'] },
  fish: { what: 'a login terminal (Terminal and iTerm on macOS, ssh)', flags: ['-l'] },
}
const both = (shell: ShellName): Terminal[] => [WINDOW[shell], LOGIN[shell]]

const SCENES: Scene[] = [
  { name: 'bash · the stock Ubuntu and Debian files: ~/.profile adds the folder at login if it exists, ~/.bashrc does not name it', shell: 'bash', has: { '.profile': STOCK_PROFILE, '.bashrc': STOCK_BASHRC }, login: '.profile', writes: ['.bashrc'], terminals: both('bash') },
  { name: 'bash · the stock ~/.profile and no ~/.bashrc', shell: 'bash', has: { '.profile': STOCK_PROFILE }, login: '.profile', writes: ['.bashrc'], terminals: both('bash') },
  { name: 'bash · ~/.bashrc names the folder, the login file ~/.bash_profile does not and does not read ~/.bashrc', shell: 'bash', has: { '.bashrc': STOCK_BASHRC + OWN_LINE, '.bash_profile': 'export EDITOR=vi\n' }, login: '.bash_profile', writes: ['.bash_profile'], terminals: both('bash') },
  { name: 'bash · ~/.bashrc names the folder and there is no login file', shell: 'bash', has: { '.bashrc': STOCK_BASHRC + OWN_LINE }, login: null, writes: ['.profile'], terminals: both('bash') },
  { name: 'bash · neither file', shell: 'bash', has: {}, login: null, writes: ['.bashrc', '.profile'], terminals: both('bash') },
  { name: 'bash · both files name the folder', shell: 'bash', has: { '.profile': STOCK_PROFILE, '.bashrc': STOCK_BASHRC + OWN_LINE }, login: '.profile', writes: [], terminals: both('bash') },
  { name: 'zsh · no startup file (a new Mac)', shell: 'zsh', has: {}, login: null, writes: ['.zshrc'], terminals: both('zsh') },
  { name: 'zsh · a ~/.zshrc of the user and the stock ~/.profile, which zsh does not read', shell: 'zsh', has: { '.profile': STOCK_PROFILE, '.zshrc': 'export EDITOR=vi\n' }, login: null, writes: ['.zshrc'], terminals: both('zsh') },
  { name: 'fish · no startup file', shell: 'fish', has: {}, login: null, writes: ['.config/fish/conf.d/mercury.fish'], terminals: both('fish') },
]

let failures = 0
const FIX_WHERE_HINT = 'to fix, change which startup files get the PATH line (decidePosix) or what uninstall takes back (removePosixPathLines) in src/platform/update-channel/installPath.ts'
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond ? '' : ` — ${detail ? `${detail} — ` : ''}${FIX_WHERE_HINT}`}`)
  if (!cond) failures++
}
const shellAt = (name: string): string | null => BASE_PATH.split(':').map(dir => join(dir, name)).find(candidate => existsSync(candidate)) ?? null

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'new-terminal-')))
try {
  SCENES.forEach((scene, index) => {
    console.log(`\n── ${scene.name} ──`)
    const shell = shellAt(scene.shell)
    if (shell === null) {
      console.log(`  [SKIP] ${scene.shell} is not installed here`)
      return
    }
    const home = join(scratch, `home-${index}`)
    const bin = join(home, '.local', 'bin')
    const command = join(bin, 'mercury')
    const sessionEnv = (path: string): Record<string, string> => ({
      HOME: home,
      PATH: path,
      SHELL: shell,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      MERCURY_VERSIONS_DIR: join(home, '.mercury', 'versions'),
      MERCURY_PROOF_LAYOUT_SCRATCH: scratch,
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
    })
    const startupFiles = (): Record<string, string | null> =>
      Object.fromEntries(STARTUP_FILES.map(name => [name, existsSync(join(home, name)) ? readFileSync(join(home, name), 'utf8') : null]))
    const loggedIn = (): string =>
      scene.login === null
        ? BASE_PATH
        : spawnSync(shell, ['-c', `. "$HOME/${scene.login}"; printf %s "$PATH"`], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], env: sessionEnv(BASE_PATH) }).stdout
    const found = (terminal: Terminal, path: string): string =>
      (spawnSync(shell, [...terminal.flags, '-c', 'command -v mercury'], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], env: sessionEnv(path) }).stdout ?? '').trim().split('\n').pop() ?? ''
    const inSession = (verb: 'install' | 'uninstall', path: string): { outcome: { state: string; targets?: string[] }; line: string } => {
      const r = spawnSync(process.execPath, [SELF, '--in-session', verb], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], env: sessionEnv(path) })
      try {
        return JSON.parse((r.stdout ?? '').trim().split('\n').pop() ?? '') as { outcome: { state: string; targets?: string[] }; line: string }
      } catch {
        return { outcome: { state: `no answer (exit ${r.status}): ${(r.stdout ?? '') + (r.stderr ?? '')}`.slice(0, 300) }, line: '' }
      }
    }

    mkdirSync(home, { recursive: true })
    for (const [name, text] of Object.entries(scene.has)) {
      mkdirSync(dirname(join(home, name)), { recursive: true })
      writeFileSync(join(home, name), text)
    }
    const before = startupFiles()
    const session = loggedIn()
    check('the session PATH, as a login before the install computed it, does not hold the folder', session === BASE_PATH, session)
    mkdirSync(bin, { recursive: true })
    writeFileSync(command, '#!/bin/sh\necho stand-in\n')
    chmodSync(command, 0o755)
    const wrote = scene.writes.map(name => join(home, name))
    if (wrote.length > 0) {
      const missed = scene.terminals.filter(terminal => found(terminal, session) !== command)
      check('before the PATH line is written, some new terminal of this session does not find mercury', missed.length > 0)
    }

    const installed = inSession('install', session)
    check(
      wrote.length > 0 ? `install writes the PATH line to ${scene.writes.map(name => `~/${name}`).join(' and ')}, and to no other file` : 'install writes nothing: every file a new terminal reads names the folder',
      installed.outcome.state === (wrote.length > 0 ? 'written' : 'present') && (wrote.length === 0 || (installed.outcome.targets ?? []).join() === wrote.join()),
      `${installed.outcome.state} ${(installed.outcome.targets ?? []).join()}`,
    )
    const after = startupFiles()
    const untouched = STARTUP_FILES.filter(name => !scene.writes.includes(name))
    check('every other startup file is byte-identical', untouched.every(name => after[name] === before[name]), untouched.filter(name => after[name] !== before[name]).join())
    check('the installer says to open a new terminal', installed.line.includes('open a new terminal'), installed.line)
    for (const terminal of scene.terminals) {
      const at = found(terminal, session)
      check(`${terminal.what} finds mercury, with no logout`, at === command, at === '' ? 'command -v mercury printed nothing' : at)
    }

    const again = inSession('install', session)
    const afterAgain = startupFiles()
    check('a second install in the same session changes nothing', again.outcome.state === 'present' && STARTUP_FILES.every(name => afterAgain[name] === after[name]), again.outcome.state)

    const removed = inSession('uninstall', session)
    const afterRemoval = startupFiles()
    check(
      wrote.length > 0 ? 'the uninstall takes the line out of the files install wrote' : 'the uninstall has no line to take back',
      removed.outcome.state === (wrote.length > 0 ? 'removed' : 'absent') && (wrote.length === 0 || (removed.outcome.targets ?? []).join() === wrote.join()),
      `${removed.outcome.state} ${(removed.outcome.targets ?? []).join()}`,
    )
    const had = STARTUP_FILES.filter(name => before[name] !== null)
    check('after the uninstall every startup file the user had reads as before the install', had.every(name => afterRemoval[name] === before[name]), had.filter(name => afterRemoval[name] !== before[name]).join())
    const left = STARTUP_FILES.filter(name => before[name] === null && afterRemoval[name] !== null)
    check('… and a startup file the installer made is gone with its line', left.length === 0, left.join())
  })
} finally {
  removeScratch(scratch)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-install-path-new-terminal: ${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
