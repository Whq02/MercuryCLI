import { getIsInteractive } from '../bootstrap/state.js'
import { getCommands } from '../commands.js'
import { MERCURY_VERSION } from '../constants/product.js'
import { getSystemContext, getUserContext } from '../context.js'
import { initBundledSkills } from '../skills/bundled/index.js'
import { getInstructionFiles } from '../services/instructions/engine.js'
import { flagEnv, setFlagEnv } from '../substrate/flagRegistry.js'
import { recordLaunchMilestone } from '../substrate/launchMilestones.js'
import { binaryName } from '../utils/config.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { startCapturingEarlyInput } from '../utils/earlyInput.js'
import { profileCheckpoint } from '../utils/startupProfiler.js'
import { checkHasTrustDialogAccepted } from '../utils/config.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { setup } from '../setup.js'
import { applyMergedConfigEnv, typedString, type RootOptions } from './cli.js'
import { refuseFlagClashes, readBriefs, readRunFormats } from './bootFlags.js'
import { resolveAgents, resolveModels, resolvePermissions, resolveThinkingConfig } from './sessionChoices.js'
import { readRunPrompt } from './runPrompt.js'
import { resolveMcpConfigs } from './mcpConfigs.js'
import { interactiveLaunch } from './interactiveLaunch.js'
import { runLaunch } from './runLaunch.js'

export async function defaultAction(inputPromptArg: string | undefined, opts: RootOptions): Promise<void> {
  if ((opts as { version?: boolean }).version) {
    console.log(`Mercury ${MACRO.VERSION}`)
    process.exit(0)
  }
  try {
    recordLaunchMilestone('runtime-entry', { boot: getIsInteractive() ? 'interactive' : 'headless' })
  } catch {
  }
  const cliName = binaryName()
  const isNonInteractiveSession = !getIsInteractive()
  const runMode = Boolean(opts.runMode)
  const runnerDoor = opts.runner === true

  const { worktreeOpt, tmuxEnabled, sessionIdOpt } = await refuseFlagClashes(inputPromptArg, opts, { cliName, isNonInteractiveSession, runMode, runnerDoor })
  const { customSystemPrompt, appendSystemPrompt } = await readBriefs(opts)

  const { inputFormat, outputFormat, includePartialMessages } = await readRunFormats(opts, runMode, runnerDoor)

  if (opts.lean) {
    setFlagEnv('MERCURY_BARE', '1')
  }
  let inputPrompt = runMode && inputPromptArg === '-' ? undefined : inputPromptArg
  if (typedString(opts.draft)) {
    startCapturingEarlyInput()
    process.stdin.unshift?.(Buffer.from(String(opts.draft)))
  }

  const { allowDangerousSkip, permissionMode, toolPermissionContext } = await resolvePermissions(opts)

  let worktreeName = typeof worktreeOpt === 'string' ? worktreeOpt : undefined
  let worktreePRNumber: number | undefined
  if (worktreeName) {
    const prMatch = /^#(\d+)$/.exec(worktreeName) ?? /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(worktreeName)
    if (prMatch) {
      worktreePRNumber = Number(prMatch[1])
      worktreeName = undefined
    }
  }
  const { isWorktreeModeEnabled } = await import('../utils/worktreeModeEnabled.js')
  const worktreeEnabled = Boolean(worktreeOpt) && isWorktreeModeEnabled()

  const thinkingConfig = await resolveThinkingConfig(opts)

  const { activeAgents, allAgents, mainThreadAgentDefinition } = await resolveAgents(opts)

  const { userSpecifiedModel, fallbackModel, resolvedInitialModel } = await resolveModels(opts, runMode, mainThreadAgentDefinition)

  const sessionTitle = typedString(opts.title)?.trim() || undefined

  const { prompt, syntaxInput } = await readRunPrompt({ opts, inputPrompt, runMode, runnerDoor, inputFormat, mainThreadAgentDefinition, cliName })

  const { mcpConfigPromise, regularDynamicMcpConfig } = resolveMcpConfigs(opts)

  if (flagEnv('MERCURY_ENTRYPOINT') !== 'local-agent') {
    initBundledSkills()
  }
  const { getProjectRoot } = await import('../bootstrap/state.js')
  const cwd = process.cwd()
  if (!worktreeEnabled && !isNonInteractiveSession && checkHasTrustDialogAccepted()) {
    void getInstructionFiles().catch(() => {})
  }
  profileCheckpoint('action_before_setup')
  const setupPromise = setup(
    cwd,
    permissionMode,
    allowDangerousSkip,
    worktreeEnabled,
    worktreeName,
    tmuxEnabled,
    sessionIdOpt ?? null,
    worktreePRNumber,
    undefined,
    toolPermissionContext,
  )
  let commandsPromise: Promise<import('../commands.js').Command[]>
  if (worktreeEnabled) {
    await setupPromise
    commandsPromise = getCommands(getProjectRoot())
  } else {
    setupPromise.catch(() => {})
    commandsPromise = getCommands(cwd)
    commandsPromise.catch(() => {})
    await setupPromise
  }
  profileCheckpoint('action_after_setup')
  const commands = await commandsPromise
  profileCheckpoint('action_commands_loaded')

  if (isNonInteractiveSession) {
    applyMergedConfigEnv()
    void getSystemContext().catch(() => {})
    void getUserContext().catch(() => {})
  }
  logForDiagnosticsNoPII('info', 'mercury_started', {
    version: MERCURY_VERSION,
    bundled: typeof (globalThis as { MACRO?: unknown }).MACRO !== 'undefined',
  })
  registerCleanup(async () => {
    logForDiagnosticsNoPII('info', 'mercury_exited')
  })

  if (opts.concourseOff === true || opts.concourseOn === true) {
    const { setConcourseEnabled } = await import('../services/concourse/concourseEnabled.js')
    const lastSwitch = [...process.argv].reverse().find(a => a === '--concourse-off' || a === '--concourse-on')
    setConcourseEnabled(lastSwitch === '--concourse-on')
  }
  if (opts.coordinatorOff === true || opts.coordinatorOn === true) {
    process.stderr.write('The Concourse coordinator has been removed, so --coordinator-on and --coordinator-off change nothing: n on the board starts a session.\n')
  }

  if (!isNonInteractiveSession) {
    await interactiveLaunch({
      opts,
      commands,
      prompt: typeof prompt === 'string' ? prompt : undefined,
      permissionMode,
      toolPermissionContext,
      allowDangerousSkip,
      dynamicMcpConfig:
        Object.keys(regularDynamicMcpConfig).length > 0 ? regularDynamicMcpConfig : undefined,
      thinkingConfig,
      resolvedInitialModel,
      userSpecifiedModel,
      mainThreadAgentDefinition,
      activeAgents,
      allAgents,
      sessionTitle,
    })
    return
  }

  await runLaunch({
    opts,
    commands,
    prompt,
    syntaxInput,
    permissionMode,
    toolPermissionContext,
    allowDangerousSkip,
    mcpConfigPromise,
    thinkingConfig,
    userSpecifiedModel,
    fallbackModel,
    mainThreadAgentDefinition,
    activeAgents,
    allAgents,
    customSystemPrompt,
    appendSystemPrompt,
    inputFormat,
    outputFormat,
    includePartialMessages,
    door: runnerDoor ? 'wire' : 'rows',
  })
}
