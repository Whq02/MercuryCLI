
import { execFileSync } from 'node:child_process'
import { locateBridgeVsix, MERCURY_IDE_EXTENSION_ID } from '../utils/editorExtensionPackage.js'
import { subprocessEnv } from '../utils/subprocessEnv.js'

const EDITOR_CLIS = ['code', 'code-insiders', 'cursor', 'codium', 'windsurf'] as const

const DARWIN_BUNDLE_CLIS: Record<(typeof EDITOR_CLIS)[number], string> = {
  code: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  'code-insiders': '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders',
  cursor: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
  codium: '/Applications/VSCodium.app/Contents/Resources/app/bin/codium',
  windsurf: '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf',
}

const WIN32_CANDIDATES = ['code.cmd', 'code', 'code.exe', 'code-insiders.cmd', 'cursor.cmd', 'codium.cmd', 'windsurf.cmd']

function findEditorCli(): string | null {
  const isWindows = process.platform === 'win32'
  const candidates: string[] = []
  if (isWindows) {
    candidates.push(...WIN32_CANDIDATES)
  } else {
    for (const cli of EDITOR_CLIS) {
      candidates.push(cli, `/usr/local/bin/${cli}`, `/opt/homebrew/bin/${cli}`)
      if (process.platform === 'darwin') candidates.push(DARWIN_BUNDLE_CLIS[cli])
    }
  }
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], {
        windowsHide: true,
        stdio: 'pipe',
        timeout: 10_000,
        env: subprocessEnv(),
        ...(isWindows ? { shell: true } : {}),
      })
      return candidate
    } catch {
    }
  }
  return null
}

const CLI_ROSTER = EDITOR_CLIS.join(' · ')

export async function editorBridgeMain(action: string): Promise<number> {
  const out = (s: string): void => void process.stdout.write(s + '\n')
  const err = (s: string): void => void process.stderr.write(s + '\n')

  if (!['install', 'status', 'uninstall'].includes(action)) {
    err(`editor: unknown action '${action}' — install | status | uninstall`)
    return 2
  }

  const cli = findEditorCli()
  const vsix = locateBridgeVsix()

  if (action === 'status') {
    out(`vsix: ${vsix ?? 'NOT FOUND (source checkout: bash scripts/vscode/build-vsix.sh)'}`)
    if (!cli) {
      out(`editor CLI: not found — no VS Code-family CLI on PATH (${CLI_ROSTER})`)
      out('manual install: VS Code → Extensions → “…” menu → Install from VSIX → pick the file above')
      return 0
    }
    try {
      const list = execFileSync(cli, ['--list-extensions', '--show-versions'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 20_000,
        env: subprocessEnv(),
        ...(process.platform === 'win32' ? { shell: true } : {}),
      })
      const line = list.split('\n').find(l => l.toLowerCase().startsWith(MERCURY_IDE_EXTENSION_ID))
      out(`editor CLI: ${cli}`)
      out(line ? `installed: ${line.trim()}` : 'installed: no')
    } catch (e) {
      err(`editor: ${cli} failed: ${(e as Error).message}`)
      return 1
    }
    return 0
  }

  if (action === 'install') {
    if (!vsix) {
      err('editor: mercury-vscode.vsix not found — in a source checkout run: bash scripts/vscode/build-vsix.sh')
      return 1
    }
    if (!cli) {
      err(`editor: nothing installed — no VS Code-family CLI is available (${CLI_ROSTER}). Manual install:`)
      err('  1. Open VS Code → Extensions panel')
      err('  2. “…” menu → Install from VSIX…')
      err(`  3. Pick: ${vsix}`)
      return 1
    }
    try {
      execFileSync(cli, ['--install-extension', vsix, '--force'], {
        windowsHide: true,
        stdio: 'inherit',
        timeout: 120_000,
        env: subprocessEnv(),
        ...(process.platform === 'win32' ? { shell: true } : {}),
      })
      out(`installed ${MERCURY_IDE_EXTENSION_ID} from ${vsix} via ${cli} — reload the editor window to activate it`)
      return 0
    } catch (e) {
      err(`editor: install failed: ${(e as Error).message}`)
      return 1
    }
  }

  if (!cli) {
    err(`editor: nothing uninstalled — no VS Code-family CLI is available (${CLI_ROSTER}). Manual uninstall: VS Code → Extensions → Mercury → Uninstall.`)
    return 1
  }
  try {
    execFileSync(cli, ['--uninstall-extension', MERCURY_IDE_EXTENSION_ID], {
      windowsHide: true,
      stdio: 'inherit',
      timeout: 60_000,
      env: subprocessEnv(),
      ...(process.platform === 'win32' ? { shell: true } : {}),
    })
    out(`uninstalled ${MERCURY_IDE_EXTENSION_ID} via ${cli}`)
    return 0
  } catch (e) {
    err(`editor: uninstall failed (was it installed?): ${(e as Error).message}`)
    return 1
  }
}
