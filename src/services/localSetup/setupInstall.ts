import { join } from 'node:path'
import { resolveSetupIo, seconds, shellArgv, type ResolvedSetupIo } from './setupIo.js'
import { SETUP_EXEC_TIMEOUT_MS, SETUP_INSTALL_POLL_MS, type ExecResult, type InstallPlan, type InstallVia, type OllamaInstallFound, type SetupIo, type SetupPlatform } from './setupTypes.js'

export type InstallDoc = { platform: SetupPlatform; via: InstallVia; url: string; excerpt: string; command: string }

export const OLLAMA_DMG_URL = 'https://ollama.com/download/Ollama.dmg'
export const OLLAMA_INSTALL_SH_URL = 'https://ollama.com/install.sh'
export const OLLAMA_SETUP_EXE_URL = 'https://ollama.com/download/OllamaSetup.exe'

export const INSTALL_DOCS: readonly InstallDoc[] = [
  {
    platform: 'darwin',
    via: 'brew',
    url: 'https://formulae.brew.sh/formula/ollama',
    excerpt: 'Install command: brew install ollama · Create, run, and share large language models (LLMs) · Start now and at login: brew services start ollama · Run directly: $HOMEBREW_PREFIX/opt/ollama/bin/ollama serve',
    command: 'brew install ollama',
  },
  {
    platform: 'darwin',
    via: 'dmg',
    url: 'https://ollama.com/download/mac · https://docs.ollama.com/macos',
    excerpt: '"Download for macOS" links to /download/Ollama.dmg · "Requires macOS 14 Sonoma or later" · docs.ollama.com/macos: "The preferred method of installation is to mount the ollama.dmg and drag-and-drop the Ollama application to the system-wide Applications folder."',
    command: 'curl -fsSL -o ~/Downloads/Ollama.dmg https://ollama.com/download/Ollama.dmg && open ~/Downloads/Ollama.dmg',
  },
  {
    platform: 'linux',
    via: 'script',
    url: 'https://ollama.com/download/linux · https://docs.ollama.com/linux',
    excerpt: 'docs.ollama.com/linux, Install: "To install Ollama, run the following command: curl -fsSL https://ollama.com/install.sh | sh" · Manual install: "curl -fsSL https://ollama.com/download/ollama-linux-amd64.tar.zst | sudo tar x -C /usr" · Adding Ollama as a startup service (recommended): "sudo systemctl daemon-reload", "sudo systemctl enable ollama" · Start Ollama: "sudo systemctl start ollama"',
    command: 'curl -fsSL https://ollama.com/install.sh | sh',
  },
  {
    platform: 'win32',
    via: 'exe',
    url: 'https://ollama.com/download/windows · https://docs.ollama.com/windows',
    excerpt: '"Download for Windows" links to /download/OllamaSetup.exe · "Requires Windows 10 or later" · docs.ollama.com/windows: "The easiest way to install Ollama on Windows is to use the OllamaSetup.exe installer." · "It installs in your account without requiring Administrator rights." · "explorer %LOCALAPPDATA%\\Programs\\Ollama contains the binaries (The installer adds this to your user PATH)" · "After installing Ollama for Windows, Ollama will run in the background"',
    command: 'curl.exe -fsSL -o "%TEMP%\\OllamaSetup.exe" https://ollama.com/download/OllamaSetup.exe && start "" "%TEMP%\\OllamaSetup.exe"',
  },
]

export function windowsAppExe(env: NodeJS.ProcessEnv): string {
  const local = env.LOCALAPPDATA ?? env.localappdata ?? ''
  return `${local || '%LOCALAPPDATA%'}\\Programs\\Ollama\\ollama app.exe`
}

function appPaths(io: ResolvedSetupIo): string[] {
  return ['/Applications/Ollama.app', join(io.home, 'Applications', 'Ollama.app')]
}

async function brewListing(io: ResolvedSetupIo): Promise<string | undefined> {
  const brew = await io.which('brew')
  if (!brew) return undefined
  const listed = await io.exec(brew, ['list', '--formula', 'ollama'], { timeoutMs: 20_000 })
  if (listed.rc !== 0) return undefined
  const bin = listed.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => /[\\/]bin[\\/]ollama$/.test(line))
  return bin ?? `${brew.replace(/[\\/]bin[\\/]brew$/, '')}/opt/ollama/bin/ollama`
}

function classifyPathHit(io: ResolvedSetupIo, where: string): OllamaInstallFound['found'] {
  const real = io.realpath(where) ?? where
  if (io.platform === 'darwin' && /\/Ollama\.app\//.test(real)) return 'app'
  if (/\/Cellar\/ollama\//.test(real) || /^\/opt\/homebrew\//.test(real) || /^\/usr\/local\/Cellar\//.test(real) || /^\/home\/linuxbrew\//.test(real)) return 'brew'
  return 'path'
}

export async function findOllamaInstall(seam: SetupIo = {}): Promise<OllamaInstallFound> {
  const io = resolveSetupIo(seam)
  const looked: string[] = []
  const done = (found: OllamaInstallFound['found'], where: string, words: string): OllamaInstallFound => ({ found, where, looked, words })
  looked.push('ollama on PATH')
  const onPath = await io.which('ollama')
  if (onPath) {
    const form = classifyPathHit(io, onPath)
    const real = io.realpath(onPath)
    const app = form === 'app' && real ? real.replace(/\/Contents\/Resources\/ollama.*$/, '') : undefined
    return done(form, app ?? onPath, `found ollama on PATH at ${onPath}${form === 'app' ? ` (the app ${app})` : form === 'brew' ? ' (Homebrew)' : ''}`)
  }
  if (io.platform === 'darwin') {
    for (const app of appPaths(io)) {
      looked.push(app)
      if (io.exists(app)) return done('app', app, `found the app at ${app}`)
    }
    looked.push('brew list --formula ollama')
    const brewBin = await brewListing(io)
    if (brewBin) return done('brew', brewBin, `found the Homebrew formula (brew list --formula ollama): ${brewBin}`)
  }
  if (io.platform === 'linux') {
    looked.push('systemctl status ollama')
    const systemctl = await io.which('systemctl')
    if (systemctl) {
      const status = await io.exec(systemctl, ['status', 'ollama'], { timeoutMs: 10_000 })
      if (status.rc === 0 || status.rc === 3) return done('systemd', 'ollama.service', `found the systemd unit ollama.service (${status.rc === 0 ? 'active' : 'inactive'})`)
    }
    for (const bin of ['/usr/local/bin/ollama', '/usr/bin/ollama']) {
      looked.push(bin)
      if (io.exists(bin)) return done('path', bin, `found ${bin}`)
    }
    looked.push('brew list --formula ollama')
    const brewBin = await brewListing(io)
    if (brewBin) return done('brew', brewBin, `found the Homebrew formula (brew list --formula ollama): ${brewBin}`)
  }
  if (io.platform === 'win32') {
    const exe = windowsAppExe(io.env)
    looked.push(exe)
    if (io.exists(exe)) return done('windows', exe, `found ${exe}`)
  }
  return done('none', '', `ollama not found (looked: ${looked.join(', ')})`)
}

export async function planInstall(platform: SetupPlatform, seam: SetupIo = {}): Promise<InstallPlan> {
  const io = resolveSetupIo(seam)
  const doc = (via: InstallVia): InstallDoc => INSTALL_DOCS.find(d => d.platform === platform && d.via === via)!
  if (platform === 'darwin') {
    const brew = await io.which('brew')
    if (brew) {
      const d = doc('brew')
      return {
        platform,
        via: 'brew',
        command: d.command,
        says: [`Homebrew is at ${brew}: the formula installs the ollama binary, no drag to Applications`, `the docs: ${d.excerpt}`],
        needsSudo: false,
        waitsFor: 'ollama on PATH',
        source: { url: d.url, excerpt: d.excerpt },
      }
    }
    const d = doc('dmg')
    return {
      platform,
      via: 'dmg',
      command: d.command,
      says: ['downloads the app image to ~/Downloads and opens it; drag Ollama to Applications when the window shows', `the docs: ${d.excerpt}`],
      needsSudo: false,
      waitsFor: '/Applications/Ollama.app',
      source: { url: d.url, excerpt: d.excerpt },
    }
  }
  if (platform === 'linux') {
    const d = doc('script')
    return {
      platform,
      via: 'script',
      command: d.command,
      says: ['the script asks for sudo: it installs to /usr/local and creates the ollama systemd service', `the docs: ${d.excerpt}`],
      needsSudo: true,
      waitsFor: 'ollama on PATH',
      source: { url: d.url, excerpt: d.excerpt },
    }
  }
  const d = doc('exe')
  return {
    platform,
    via: 'exe',
    command: d.command,
    says: ['downloads the installer and starts it; finish the installer window, the dialog waits for ollama app.exe to appear', `the docs: ${d.excerpt}`],
    needsSudo: false,
    waitsFor: windowsAppExe(io.env),
    source: { url: d.url, excerpt: d.excerpt },
  }
}

export async function runInstall(plan: InstallPlan, seam: SetupIo = {}): Promise<ExecResult> {
  const io = resolveSetupIo(seam)
  const argv = shellArgv(io.platform, plan.command)
  return io.exec(argv[0]!, argv.slice(1), { timeoutMs: SETUP_EXEC_TIMEOUT_MS })
}

export async function waitForInstall(plan: InstallPlan, seam: SetupIo = {}, onWait?: (line: string) => void): Promise<OllamaInstallFound> {
  const io = resolveSetupIo(seam)
  const started = io.now()
  let last: OllamaInstallFound = await findOllamaInstall(seam)
  while (last.found === 'none' && io.now() - started < io.installWaitMs && io.signal?.aborted !== true) {
    onWait?.(`waiting for ${plan.waitsFor} · ${seconds(io.now() - started)}`)
    await io.sleep(SETUP_INSTALL_POLL_MS)
    last = await findOllamaInstall(seam)
  }
  return last
}
