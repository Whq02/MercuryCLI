import { spawnSync } from 'node:child_process'
import { errorMessage } from '../../../platform/errors/errors.js'
import { devinCliInstallHintWords } from '../../../platform/host-os/words.js'
import { hostSpawnWorld, spawnPlanOf, type SpawnWorld } from '../../../platform/processes/spawnPlan.js'
import { devinCliChildEnv } from '../../../platform/processes/subprocessEnv.js'
import { lendTerminal, waitForReturnKey } from './lentTerminal.js'

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

export function devinCliDetailLines(missing: readonly string[] | null = null): string[] {
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
    ...(missing ?? ['Press Enter to run devin auth login,', 'status, or logout.']),
    '',
    'Attach from chat: /crew attach devin.',
  ]
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
          receipt: `Devin CLI (devin) is not installed or not on PATH. ${devinCliInstallHintWords(world.platform)}`,
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

export function devinCliMissingOutcome(world: SpawnWorld = hostSpawnWorld()): DevinCliRunOutcome | null {
  const resolved = resolveDevinPlan('status', world)
  return !resolved.ok && resolved.outcome.kind === 'missing' ? resolved.outcome : null
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

  const lent = await lendTerminal(
    stdout => {
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
    },
    { ...(options.stdin !== undefined ? { stdin: options.stdin } : {}), ...(options.stdout !== undefined ? { stdout: options.stdout } : {}), child: 'Devin CLI' },
  )
  if (lent === null) {
    return {
      kind: 'refused',
      ok: false,
      receipt: `Devin CLI (${action}) needs an interactive terminal. Run \`devin auth ${action}\` in your terminal instead.`,
    }
  }
  return lent.value
}
