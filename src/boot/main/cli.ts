import { writeSync } from 'node:fs'
import { MERCURY_VERSION } from '../../platform/product/product.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { releaseLauncherAltHoldNow } from '../../screen/renderer/launcherAltHold.js'
import { binaryName } from '../../platform/settings/config.js'
import { getInitialSettings } from '../../platform/settings/settings.js'
import chalk from 'chalk'
import { formatPrintsOutcomeRow, refusedOutcome } from '../../daemon/runner/refusalEnvelope.js'
import { inspectSessionArgs as inspectRunArgs } from '../sessionArgs.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'

export function applyMergedConfigEnv(): void {
  const env = getInitialSettings().environment?.values ?? {}
  for (const [key, value] of Object.entries(env)) {
    hostEnv()[key] = String(value)
  }
}

export function typedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function writeErr(text: string): void {
  releaseLauncherAltHoldNow()
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`)
}

export function exitWithVersionLine(): never {
  try {
    writeSync(1, `Mercury ${MERCURY_VERSION}\n`)
  } catch (error) {
    passedOver(error)
  }
  process.exit(0)
}

export function wantsOutcomeEnvelope(): boolean {
  const args = inspectRunArgs(process.argv.slice(2))
  return args.command === 'run' && formatPrintsOutcomeRow(args.format)
}

export const USAGE_ERROR_CODES = new Set([
  'commander.unknownOption',
  'commander.unknownCommand',
  'commander.missingArgument',
  'commander.optionMissingArgument',
  'commander.missingMandatoryOptionValue',
  'commander.invalidArgument',
  'commander.excessArguments',
  'commander.conflictingOption',
])
function promptMistakenForOptionHint(message: string | undefined, cliName = binaryName(), launcher = flagEnv('MERCURY_LAUNCHER')): string | null {
  const quoted = /unknown option '([^']*)'/.exec(message ?? '')?.[1]
  if (quoted === undefined || !/\s/.test(quoted.trim())) return null
  const hint = `that looks like a prompt that begins with "-", so the parser read it as an option — put it after the option boundary: ${cliName} run -- ${JSON.stringify(quoted)}`
  if (launcher !== 'ps1') return hint
  return `${hint} — from PowerShell's ${cliName} command the first "--" is PowerShell's own and never reaches Mercury, so write it twice: ${cliName} run -- -- ${JSON.stringify(quoted)} (or use ${cliName}.cmd)`
}

export function exitForCommanderError(error: { code?: string; exitCode?: number; message?: string }): void {
  if (error.code === 'commander.unknownOption') {
    const hint = promptMistakenForOptionHint(error.message)
    if (hint !== null) writeErr(hint)
  }
  if (error.code !== undefined && USAGE_ERROR_CODES.has(error.code)) process.exit(2)
}

export function failCli(message: string, code: 1 | 2 = 2): never {
  if (wantsOutcomeEnvelope()) {
    try {
      const envelope = refusedOutcome([message])
      writeSync(1, `${JSON.stringify(envelope)}\n`)
      process.exit(code)
    } catch (error) {
      passedOver(error)
    }
  }
  writeErr(chalk.red(message))
  process.exit(code)
}

export type RootOptions = Record<string, unknown>

export const RUN_OUTPUT_OPTIONS: ReadonlySet<string> = new Set(['--format', '--input', '--partial'])
export const INTERACTIVE_BOOT_OPTIONS: ReadonlySet<string> = new Set(['--chat', '--concourse-off', '--concourse-on', '--coordinator-off', '--coordinator-on', '--multiplex', '--pr'])
export const PRINT_ONLY_VERBS: ReadonlySet<string> = new Set(['version', 'help'])
