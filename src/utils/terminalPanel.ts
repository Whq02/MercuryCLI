
import { spawn, spawnSync } from 'node:child_process'
import instances from '../ink/instances.js'
import { getSessionId } from '../bootstrap/state.js'
import { getCwd } from './cwd.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { subprocessEnv } from './subprocessEnv.js'

const SESSION_NAME = 'panel'
const DEFAULT_SHELL = '/bin/bash'

export function getTerminalPanelSocket(): string {
  return `claude-panel-${String(getSessionId()).slice(0, 8)}`
}

class TerminalPanel {
  private tmuxAvailable: boolean | null = null
  private cleanupRegistered = false

  private isTmuxAvailable(): boolean {
    if (this.tmuxAvailable !== null) return this.tmuxAvailable
    const probe = spawnSync('tmux', ['-V'], { windowsHide: true, stdio: 'ignore', timeout: 5_000, env: { ...subprocessEnv() } })
    this.tmuxAvailable = !probe.error && probe.status === 0
    if (!this.tmuxAvailable) {
      logForDebugging('terminalPanel: tmux unavailable, using direct shell fallback')
    }
    return this.tmuxAvailable
  }

  private sessionExists(socket: string): boolean {
    const result = spawnSync('tmux', ['-L', socket, 'has-session', '-t', SESSION_NAME], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5_000,
      env: { ...subprocessEnv() },
    })
    return !result.error && result.status === 0
  }

  private createSession(socket: string): boolean {
    const shell = process.env.SHELL || DEFAULT_SHELL
    const created = spawnSync(
      'tmux',
      ['-L', socket, 'new-session', '-d', '-s', SESSION_NAME, '-c', getCwd(), `${shell} -l`],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], timeout: 5_000, env: subprocessEnv() },
    )
    if (created.error || created.status !== 0) {
      logForDebugging(
        `terminalPanel: tmux new-session failed: ${created.stderr?.toString().trim() ?? String(created.error ?? '')}`,
      )
      return false
    }
    spawnSync(
      'tmux',
      [
        '-L', socket,
        'bind-key', '-n', 'M-j', 'detach-client', ';',
        'set-option', '-g', 'status-style', 'bg=default', ';',
        'set-option', '-g', 'status-left', '', ';',
        'set-option', '-g', 'status-right', 'M-j returns to Mercury', ';',
        'set-option', '-g', 'status-right-style', 'dim',
      ],
      { windowsHide: true, stdio: 'ignore', timeout: 5_000, env: { ...subprocessEnv() } },
    )
    if (!this.cleanupRegistered) {
      this.cleanupRegistered = true
      registerCleanup(async () => {
        try {
          const kill = spawn('tmux', ['-L', socket, 'kill-server'], {
            windowsHide: true,
            detached: true,
            stdio: 'ignore',
            env: { ...subprocessEnv() },
          })
          kill.on('error', () => {})
          kill.unref()
        } catch {
        }
      })
    }
    return true
  }

  toggle(): void {
    const ink = instances.get(process.stdout)
    if (!ink) {
      logForDebugging('terminalPanel: no UI instance bound to stdout')
      return
    }
    ink.enterAlternateScreen()
    try {
      const socket = getTerminalPanelSocket()
      if (this.isTmuxAvailable() && (this.sessionExists(socket) || this.createSession(socket))) {
        spawnSync('tmux', ['-L', socket, 'attach-session', '-t', SESSION_NAME], {
          windowsHide: false,
          stdio: 'inherit',
          env: { ...subprocessEnv() },
        })
      } else {
        const shell = process.env.SHELL || DEFAULT_SHELL
        spawnSync(shell, ['-l'], {
          windowsHide: false,
          stdio: 'inherit',
          cwd: getCwd(),
          env: subprocessEnv(),
        })
      }
    } finally {
      ink.exitAlternateScreen()
    }
  }
}

let panel: TerminalPanel | null = null

export function getTerminalPanel(): TerminalPanel {
  if (!panel) panel = new TerminalPanel()
  return panel
}
