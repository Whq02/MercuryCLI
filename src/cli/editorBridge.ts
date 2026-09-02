// ============================================================================
//  cli/editorBridge — `mercury editor install|status|uninstall`.
//
//  Thin management of the VS Code bridge .vsix: prefer the installed `code`
//  CLI; without it, print EXACT manual steps (never guess, never modify
//  editor settings). The .vsix ships beside the bundle in the collaborator
//  package and is built to dist/ in source checkouts.
// ============================================================================

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { subprocessEnv } from '../utils/subprocessEnv.js'

const EXTENSION_ID = 'mercury.mercury-vscode'

function findCodeCli(): string | null {
  // On Windows the npm-style CLI is `code.cmd` — a bare `code` probe threw
  // ENOENT and the bridge reported VS Code absent while `code --version`
  // worked in every shell (FC-046). A .cmd cannot spawn without a shell
  // (the runtime refuses batch files shell-less), so the win32 probes ride
  // shell:true; the argument list is the fixed literal --version.
  const isWindows = process.platform === 'win32'
  const candidates = isWindows
    ? ['code.cmd', 'code', 'code.exe']
    : [
        'code',
        '/usr/local/bin/code',
        '/opt/homebrew/bin/code',
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      ]
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
      /* keep looking */
    }
  }
  return null
}

function findVsix(): string | null {
  // Beside the running bundle (the collaborator package layout), then the
  // source checkout's dist/.
  const bundleDir = process.argv[1] ? dirname(process.argv[1]) : null
  const candidates = [
    ...(bundleDir ? [join(bundleDir, 'mercury-vscode.vsix')] : []),
    join(process.cwd(), 'dist', 'mercury-vscode.vsix'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

export async function editorBridgeMain(action: string): Promise<number> {
  const out = (s: string): void => void process.stdout.write(s + '\n')
  const err = (s: string): void => void process.stderr.write(s + '\n')

  if (!['install', 'status', 'uninstall'].includes(action)) {
    err(`editor: unknown action '${action}' — install | status | uninstall`)
    return 2
  }

  const code = findCodeCli()
  const vsix = findVsix()

  if (action === 'status') {
    out(`vsix: ${vsix ?? 'NOT FOUND (source checkout: bash scripts/vscode/build-vsix.sh)'}`)
    if (!code) {
      out('code CLI: not found — VS Code is not installed or `code` is not on PATH')
      out('manual install: VS Code → Extensions → “…” menu → Install from VSIX → pick the file above')
      return 0
    }
    try {
      const list = execFileSync(code, ['--list-extensions', '--show-versions'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 20_000,
        env: subprocessEnv(),
        ...(process.platform === 'win32' ? { shell: true } : {}),
      })
      const line = list.split('\n').find(l => l.startsWith(EXTENSION_ID))
      out(`code CLI: ${code}`)
      out(line ? `installed: ${line}` : 'installed: no')
    } catch (e) {
      err(`editor: code CLI failed: ${(e as Error).message}`)
      return 1
    }
    return 0
  }

  if (action === 'install') {
    if (!vsix) {
      err('editor: mercury-vscode.vsix not found — in a source checkout run: bash scripts/vscode/build-vsix.sh')
      return 1
    }
    if (!code) {
      // An action verb that performed no action exits 1 with the guidance
      // on stderr — `editor install && next` must not proceed as though the
      // install happened (FC-013).
      err('editor: nothing installed — the `code` CLI is not available. Manual install:')
      err('  1. Open VS Code → Extensions panel')
      err('  2. “…” menu → Install from VSIX…')
      err(`  3. Pick: ${vsix}`)
      return 1
    }
    try {
      execFileSync(code, ['--install-extension', vsix, '--force'], {
        windowsHide: true,
        stdio: 'inherit',
        timeout: 120_000,
        env: subprocessEnv(),
        // The vsix path is quoted for the win32 shell ride (spaces).
        ...(process.platform === 'win32' ? { shell: true } : {}),
      })
      out(`installed ${EXTENSION_ID} from ${vsix}`)
      return 0
    } catch (e) {
      err(`editor: install failed: ${(e as Error).message}`)
      return 1
    }
  }

  // uninstall
  if (!code) {
    // Same honest-exit law as install above (FC-013).
    err('editor: nothing uninstalled — the `code` CLI is not available. Manual uninstall: VS Code → Extensions → Mercury → Uninstall.')
    return 1
  }
  try {
    execFileSync(code, ['--uninstall-extension', EXTENSION_ID], {
      windowsHide: true,
      stdio: 'inherit',
      timeout: 60_000,
      env: subprocessEnv(),
      ...(process.platform === 'win32' ? { shell: true } : {}),
    })
    out(`uninstalled ${EXTENSION_ID}`)
    return 0
  } catch (e) {
    err(`editor: uninstall failed (was it installed?): ${(e as Error).message}`)
    return 1
  }
}
