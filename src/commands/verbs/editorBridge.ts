
import { execFileSync } from 'node:child_process'
import { locateBridgeVsix, MERCURY_IDE_EXTENSION_ID } from './editorExtensionPackage.js'
import { subprocessEnv } from '../../platform/processes/subprocessEnv.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { shimShellOption } from '../../platform/host-os/spawn.js'
import { editorCliCandidates } from '../../platform/host-os/vendors.js'

const EDITOR_CLIS = ['code', 'code-insiders', 'cursor', 'codium', 'windsurf'] as const

function findEditorCli(): string | null {
  const { candidates, execShell } = editorCliCandidates()
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], {
        windowsHide: true,
        stdio: 'pipe',
        timeout: 10_000,
        env: subprocessEnv(),
        ...(execShell ? { shell: true } : {}),
      })
      return candidate
    } catch (error) {
      passedOver(error)
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
      out('manual install: VS Code → Extensions → "..." menu → Install from VSIX → pick the VSIX')
      return 0
    }
    try {
      const list = execFileSync(cli, ['--list-extensions', '--show-versions'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 20_000,
        env: subprocessEnv(),
        ...shimShellOption(),
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
        ...shimShellOption(),
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
      ...shimShellOption(),
    })
    out(`uninstalled ${MERCURY_IDE_EXTENSION_ID} via ${cli}`)
    return 0
  } catch (e) {
    err(`editor: uninstall failed (was it installed?): ${(e as Error).message}`)
    return 1
  }
}
