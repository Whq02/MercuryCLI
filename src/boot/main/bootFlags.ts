import { sessionIdExists } from '../../sessions/transcripts/sessionStorage.js'
import { UUID_REGEX } from '../../platform/primitives/uuid.js'
import { failCli, typedString, writeErr, type RootOptions } from './cli.js'

export function refuseTerminalMismatch(inputPromptArg: string | undefined, { cliName, isNonInteractiveSession, runMode, runnerDoor }: {
  cliName: string
  isNonInteractiveSession: boolean
  runMode: boolean
  runnerDoor: boolean
}): void {
  if (!runMode && !runnerDoor && !process.stdout.isTTY && process.stdin.isTTY) {
    writeErr(
      'stdout is not attached to a terminal, so this run is non-interactive. Pass run to silence this note, or attach a terminal to get the interactive session.',
    )
  }
  if (!runMode && !process.stdin.isTTY) {
    if (!isNonInteractiveSession) {
      failCli(`Mercury needs a terminal: stdin is not one, so a chat cannot take your keys; for scripts use ${cliName} run -- "<prompt>"`)
    }
    const bareWord = process.argv.slice(2)
    if (bareWord.length === 1 && bareWord[0] === inputPromptArg && /^[A-Za-z][A-Za-z0-9_-]*$/.test(inputPromptArg ?? '')) {
      failCli(`unknown command: ${inputPromptArg} — ${cliName} --help lists every command; to send it as a prompt: ${cliName} run -- "${inputPromptArg}"`)
    }
  }
}

export async function refuseMissingTmux(): Promise<void> {
  const { isTmuxAvailable, getTmuxInstallInstructions } = await import('../../platform/git/worktree/worktree.js')
  if (!(await isTmuxAvailable())) {
    failCli(`tmux is not installed. ${getTmuxInstallInstructions()}`, 1)
  }
}

export function refuseResumeClashes(opts: RootOptions, runMode: boolean): void {
  if (opts.continue && opts.resume) {
    failCli('--continue and --resume name two different sessions — give exactly one')
  }
  if (opts.fork && !runMode) {
    failCli('--fork requires mercury run: a managed resume continues the session as itself')
  }
  if (opts.advise === true && !runMode) {
    failCli('--advise requires mercury run: in a chat, /advise on turns the advisor on for that chat')
  }
}

export async function refuseSessionIdClash(opts: RootOptions, sessionIdOpt: string): Promise<void> {
  if ((opts.continue || opts.resume) && !opts.fork) {
    failCli('--session-id cannot be combined with --continue/--resume unless --fork is given')
  }
  if (!UUID_REGEX.test(sessionIdOpt)) failCli(`--session-id must be a valid UUID: ${sessionIdOpt}`)
  if (await sessionIdExists(sessionIdOpt)) failCli(`Session id already exists: ${sessionIdOpt}`, 1)
}

export function refuseModeAndBriefClashes(opts: RootOptions, runMode: boolean, runnerDoor: boolean): void {
  if (runMode && opts.mode === 'apollo' && !runnerDoor) {
    failCli('mercury run: apollo needs a host that answers its asks — serve the session to one over mercury runner (mercury runner --help), or run apollo in the cockpit')
  }
  if (opts.backupModel && opts.backupModel === opts.model) {
    failCli('--backup-model cannot equal --model')
  }
  if (opts.brief && opts.briefFile) failCli('Use either --brief or --brief-file, not both')
  if (opts.defaultBrief === true && (opts.brief !== undefined || opts.briefFile !== undefined)) failCli('Use either --brief or --default-brief, not both')
  if (opts.briefAdd && opts.briefAddFile) {
    failCli('Use either --brief-add or --brief-add-file, not both')
  }
}

export async function readBriefFile(fileOpt: string, assign: (text: string) => string): Promise<void> {
  const { resolve } = await import('node:path')
  const { readFileSync, existsSync } = await import('node:fs')
  const resolved = resolve(fileOpt)
  if (!existsSync(resolved)) failCli(`Prompt file not found: ${resolved}`)
  try {
    assign(readFileSync(resolved, 'utf8'))
  } catch (error) {
    failCli(`Failed to read the prompt file: ${error instanceof Error ? error.message : String(error)}`, 1)
  }
}

export function readRunFormats(opts: RootOptions, runMode: boolean, runnerDoor: boolean) {
  const inputFormat = runnerDoor || opts.input === 'rows' ? 'rows' : 'text'
  const outputFormat = runnerDoor || opts.format === 'rows' ? 'rows' : typedString(opts.format) ?? 'text'
  if (!runMode && (opts.input || opts.format || opts.partial)) failCli('Use mercury run for --input, --format and --partial')
  if (inputFormat === 'rows' && outputFormat !== 'rows') {
    failCli('--input rows requires run --format rows')
  }
  const includePartialMessages = Boolean(opts.partial)
  if (opts.partial && (!runMode || outputFormat !== 'rows')) {
    failCli('--partial requires run --format rows')
  }
  if (opts.ephemeral === true && !runMode) {
    failCli('--ephemeral requires mercury run: an interactive session is hosted by the daemon and resumed from its transcript, so it always writes one')
  }
  return { inputFormat, outputFormat, includePartialMessages }
}

export async function refuseSchemaFlag(schemaFlag: string): Promise<void> {
  const { schemaFlagRefusal } = await import('../../daemon/runner/structuredIO.js')
  const refusal = schemaFlagRefusal(schemaFlag)
  if (refusal !== null) failCli(refusal)
}
