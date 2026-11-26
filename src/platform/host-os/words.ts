import { release, type as osType, version as osVersion } from 'node:os'
import { escapeForPowershellSingleQuotes } from '../shell/powershellLiteral.js'

const POSIX_BACKSLASHED = /[\\"]/g
const POSIX_SPLICED = /[$`!]/g

export function platformDisplayName(platform: string = process.platform): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform
}

export function platformKernelLine(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${osVersion()} ${release()}` : `${osType()} ${release()}`
}

export function systemBashLabel(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'an installed bash' : "the system's bash"
}

export function clearEnvVarCommandWords(varName: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? `clear ${varName} (PowerShell: Remove-Item Env:\\${varName} · cmd: set ${varName}=)`
    : `unset ${varName}`
}

export function portListenerLookupCommand(port: number, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `netstat -ano | findstr :${port}` : `lsof -ti:${port} -sTCP:LISTEN`
}

export function editorNotConfiguredWords(filePath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? `written to ${filePath} — set EDITOR (or VISUAL) to open it`
    : `written to ${filePath} — set $EDITOR to open it`
}

export function homeRepoRemovalCommands(
  insideSegments: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { inspect: string; remove: string } {
  if (platform === 'win32') {
    const segments = ['$env:USERPROFILE', ...insideSegments.map(s => `'${s}'`)]
    const folder = insideSegments.length === 0 ? '$env:USERPROFILE' : `([IO.Path]::Combine(${segments.join(', ')}))`
    return {
      inspect: `git -C ${folder} log --oneline`,
      remove: `Remove-Item -Recurse -Force ([IO.Path]::Combine(${[...segments, "'.git'"].join(', ')}))`,
    }
  }
  const folder = insideSegments.length === 0 ? '"$HOME"' : `"$HOME/${insideSegments.join('/')}"`
  return { inspect: `git -C ${folder} log --oneline`, remove: `rm -rf ${folder.slice(0, -1)}/.git"` }
}

export function quoteResumeTitleForShell(title: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? `'${escapeForPowershellSingleQuotes(title)}'`
    : `"${title.replace(POSIX_BACKSLASHED, '\\$&').replace(POSIX_SPLICED, "\"'$&'\"")}"`
}

export function ollamaProbeCommandWords(platform: string, home: string, brewWords: string, windowsExe: string): string {
  if (platform === 'darwin') return `which ollama · ls /Applications/Ollama.app ${home}/Applications/Ollama.app${brewWords}`
  if (platform === 'linux') return `which ollama · systemctl status ollama · ls /usr/local/bin/ollama /usr/bin/ollama${brewWords}`
  if (platform === 'win32') return `where ollama · dir "${windowsExe}"`
  return 'which ollama'
}

export function mercuryInstallUpdateCommand(invokedPath: string, platform: string = process.platform): string {
  if (platform === 'win32' && /[/\\]WinGet[/\\]Packages[/\\]MercuryCLI\.MercuryCLI_[^/\\]+[/\\]/i.test(invokedPath)) {
    return 'winget upgrade MercuryCLI.MercuryCLI'
  }
  return platform === 'win32'
    ? 'irm https://mercury-cli.ai/install.ps1 | iex'
    : 'curl -fsSL https://mercury-cli.ai/install.sh | sh'
}

export function supportedTerminalHintSuffix(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? ' (the stable Windows Terminal or your editor’s integrated terminal; PowerShell 7 preferred)' : ''
}

export function gdbInstallHintWords(platform: string = process.platform): string {
  return platform === 'win32'
    ? 'install gdb 14+ from MSYS2 (pacman -S mingw-w64-ucrt-x86_64-gdb) — the first release with the native -i=dap interpreter'
    : 'install gdb 14+ (the first release with the native -i=dap interpreter)'
}

export function desktopGrantWordsForPlatform(platform: string = process.platform): string {
  if (platform === 'darwin') return 'allow your terminal application under System Settings → Privacy & Security → Screen Recording and → Accessibility, then restart the terminal application'
  if (platform === 'win32') return 'run Mercury from an interactive desktop session (not a service, not a locked desktop); input into an elevated window needs an elevated terminal'
  return 'an X11 session with DISPLAY set; Wayland sessions are refused'
}

export function brushPackRemedyWords(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'Build the pack: bun run scripts/vendor/build-brush.ts, then rebuild — a release archive carries it.'
    : 'Fetch the pack: bun run scripts/vendor/fetch-brush.ts, then rebuild.'
}

export function modelBankCandidateWords(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? '~\\mercury-model-bank or ~\\models'
    : '~/mercury-model-bank, ~/models, /Volumes/*/mercury-model-bank or /mnt/*/mercury-model-bank'
}

export function selectPlatformRemedy(
  remedy: string,
  remedyWin32: string | undefined,
  platform: string = process.platform,
): string {
  return platform === 'win32' ? remedyWin32 ?? remedy : remedy
}

export function accessDeniedErrorHint(platform: NodeJS.Platform = process.platform): readonly [RegExp, string] {
  return platform === 'win32'
    ? [
        /\bEACCES\b|\bEPERM\b|\bEBUSY\b/,
        'file in use: on Windows another program often holds a brief lock (antivirus, search indexer, or open handle). Mercury retried; if it persists, close the holder or exclude the folder from real-time scanning',
      ]
    : [/\bEACCES\b|\bEPERM\b/, 'permission denied — check file modes/ownership']
}

export function ffmpegInstallCommandWords(platform: string = process.platform): string {
  if (platform === 'darwin') return 'brew install ffmpeg'
  if (platform === 'win32') return 'winget install ffmpeg'
  return 'apt install ffmpeg'
}

export function devinCliInstallHintWords(platform: string = process.platform): string {
  if (platform === 'win32') return 'Install Devin CLI in PowerShell: irm https://static.devin.ai/cli/setup.ps1 | iex (https://docs.devin.ai/cli)'
  if (platform === 'darwin') return 'Install Devin CLI: curl -fsSL https://cli.devin.ai/install.sh | bash (or brew install --cask devin-cli · https://docs.devin.ai/cli)'
  return 'Install Devin CLI: curl -fsSL https://cli.devin.ai/install.sh | bash (https://docs.devin.ai/cli)'
}

export function credentialStoreWaitNote(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'checking the credential store and managed settings…'
    : 'checking the system keychain and managed settings…'
}
