import { spawnSync } from 'node:child_process'
import { readSync } from 'node:fs'
import { startTimeout } from '../../../platform/async/timers.js'
import { errorMessage } from '../../../platform/errors/errors.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { markConsoleLent, markConsoleReturned } from '../../../platform/processes/process.js'
import { hostSpawnWorld, spawnPlanOf, type SpawnWorld } from '../../../platform/processes/spawnPlan.js'
import { devinCliChildEnv } from '../../../platform/processes/subprocessEnv.js'
import { reclaimTerminalAfterChild } from '../../../platform/shell/terminalHandback.js'
import { drainStdin } from '../../renderer/instance/stdin.js'
import instances from '../../renderer/instances.js'

export const DEVIN_CLI_ACTION_TITLE = 'Devin CLI (external agent)'
export const DEVIN_CLI_ACTION_SUMMARY = 'external agent · CLI-managed'
export const DEVIN_CLI_CHIP = 'CLI-managed'

export type DevinCliAction = 'login' | 'status' | 'logout'

export type DevinCliRunOutcome = {
  kind: 'completed' | 'missing' | 'failed' | 'cancelled' | 'refused' | 'error'
  ok: boolean
  receipt: string
}

export function devinCliActionOptions(): Array<{ label: string; value: DevinCliAction }> {
  return [
    { label: 'Sign in with Devin CLI (devin auth login)', value: 'login' },
    { label: 'Check Devin CLI status (devin auth status)', value: 'status' },
    { label: 'Sign out of Devin CLI (devin auth logout)', value: 'logout' },
  ]
}

export function devinCliLogoutConfirmOptions(): Array<{ label: string; value: 'cancel' | 'confirm' }> {
  return [
    { label: 'Cancel — keep Devin CLI credentials', value: 'cancel' },
    { label: 'Confirm sign out (devin auth logout)', value: 'confirm' },
  ]
}

export function devinCliDetailLines(): string[] {
  return [
    DEVIN_CLI_ACTION_TITLE,
    '',
    'External agent — not a model provider',
    'for /model.',
    '',
    'Credentials stay with Devin CLI;',
    'Mercury never reads credentials.toml',
    'or holds a token.',
    '',
    'Press Enter to run devin auth login,',
    'status, or logout.',
    '',
    'Attach from chat: /crew attach devin.',
  ]
}

export function devinCliInstallHint(platform: string = process.platform): string {
  if (platform === 'win32') {
    return 'Install Devin CLI in PowerShell: irm https://static.devin.ai/cli/setup.ps1 | iex (https://docs.devin.ai/cli)'
  }
  if (platform === 'darwin') {
    return 'Install Devin CLI: curl -fsSL https://cli.devin.ai/install.sh | bash (or brew install --cask devin-cli · https://docs.devin.ai/cli)'
  }
  return 'Install Devin CLI: curl -fsSL https://cli.devin.ai/install.sh | bash (https://docs.devin.ai/cli)'
}

function resolveDevinPlan(
  action: DevinCliAction,
  world: SpawnWorld,
): { ok: true; plan: { file: string; args: string[]; windowsVerbatimArguments: boolean } } | { ok: false; outcome: DevinCliRunOutcome } {
  const plan = spawnPlanOf(['devin', 'auth', action], world)
  if ('refused' in plan) {
    if (plan.missing !== undefined) {
      return {
        ok: false,
        outcome: {
          kind: 'missing',
          ok: false,
          receipt: `Devin CLI (devin) is not installed or not on PATH. ${devinCliInstallHint(world.platform)}`,
        },
      }
    }
    return {
      ok: false,
      outcome: {
        kind: 'refused',
        ok: false,
        receipt: plan.refused,
      },
    }
  }
  return { ok: true, plan }
}

function waitForReturnKey(stdout: NodeJS.WriteStream, label: string): void {
  try {
    stdout.write(`\n[${label}] Press Enter to return to Mercury… `)
  } catch (error) {
    passedOver(error)
  }
  const buf = Buffer.alloc(1)
  while (true) {
    try {
      const n = readSync(0, buf, 0, 1, null)
      if (n <= 0) break
      const byte = buf[0]
      if (byte === 10 || byte === 13 || byte === 3 || byte === 4 || byte === 27) break
    } catch (error) {
      passedOver(error)
      break
    }
  }
}

function outcomeOf(
  action: DevinCliAction,
  result: { error?: Error; status: number | null; signal: NodeJS.Signals | null },
): DevinCliRunOutcome {
  if (result.error !== undefined) {
    return { kind: 'error', ok: false, receipt: `Could not start devin auth ${action}: ${errorMessage(result.error)}` }
  }
  if (result.signal !== null || result.status === 130) {
    return {
      kind: 'cancelled',
      ok: false,
      receipt: `devin auth ${action} was cancelled${result.signal !== null ? ` (${result.signal})` : ''}.`,
    }
  }
  if (result.status !== 0) {
    return {
      kind: 'failed',
      ok: false,
      receipt: `devin auth ${action} exited with code ${result.status ?? 'unknown'}.`,
    }
  }
  if (action === 'login') {
    return {
      kind: 'completed',
      ok: true,
      receipt: 'devin auth login finished (exit 0). Credentials stay with Devin CLI — run Check status to verify, or /crew attach devin in chat.',
    }
  }
  return {
    kind: 'completed',
    ok: true,
    receipt: `devin auth ${action} finished (exit 0).`,
  }
}

export async function runDevinCliAction(
  action: DevinCliAction,
  options: {
    world?: SpawnWorld
    stdin?: NodeJS.ReadStream
    stdout?: NodeJS.WriteStream
  } = {},
): Promise<DevinCliRunOutcome> {
  const world = options.world ?? hostSpawnWorld()
  const resolved = resolveDevinPlan(action, world)
  if (!resolved.ok) return resolved.outcome

  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const instance = instances.get(stdout)
  if (!stdin.isTTY || !stdout.isTTY || instance === undefined) {
    return {
      kind: 'refused',
      ok: false,
      receipt: `Devin CLI (${action}) needs an interactive terminal. Run \`devin auth ${action}\` in your terminal instead.`,
    }
  }

  await instance.awaitTerminalQueries()
  drainStdin(stdin)
  markConsoleLent()
  instance.enterAlternateScreen()
  try {
    const result = spawnSync(resolved.plan.file, resolved.plan.args, {
      stdio: 'inherit',
      windowsHide: false,
      windowsVerbatimArguments: resolved.plan.windowsVerbatimArguments,
      env: devinCliChildEnv(world.platform),
    })
    const outcome = outcomeOf(action, result)
    if (action !== 'login' && outcome.kind !== 'error' && outcome.kind !== 'cancelled') {
      const codeLabel = result.status === 0 ? `devin auth ${action} exited 0` : `devin auth ${action} exited ${result.status ?? 'unknown'}`
      waitForReturnKey(stdout, codeLabel)
    }
    return outcome
  } finally {
    reclaimTerminalAfterChild('Devin CLI')
    instance.exitAlternateScreen()
    const release = startTimeout(() => {
      markConsoleReturned()
    }, 100)
    release.unref?.()
  }
}
