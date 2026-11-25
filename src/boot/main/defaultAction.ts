import { getIsInteractive, setEngineModelOverride } from '../process-state/processState.js'
import { getCommands } from '../../commands/catalogue/commands.js'
import { getSystemContext, getUserContext } from '../../engine/requestContext.js'
import { initBundledSkills } from '../../integrations/skills/bundled/index.js'
import { getInstructionFiles } from '../../sessions/instructions/instructionFiles.js'
import { addBootNote } from '../../platform/substrate/bootNotes.js'
import { flagEnv, setFlagEnv } from '../../platform/substrate/flagRegistry.js'
import { recordLaunchMilestone } from '../../platform/substrate/launchMilestones.js'
import { getAgentDefinitionsWithOverrides } from '../../tools/crewmate/loadAgentsDir.js'
import { binaryName } from '../../platform/settings/config.js'
import { startCapturingEarlyInput } from '../earlyInput.js'
import { getDefaultEngineModelSetting, getEngineModel } from '../../models/catalogue/engineModel.js'
import { profileCheckpoint } from '../startupProfiler.js'
import { checkHasTrustDialogAccepted } from '../../platform/settings/config.js'
import { sessionSetup } from '../sessionSetup.js'
import { applyMergedConfigEnv, failCli, typedString, writeErr, type RootOptions } from './cli.js'
import { readBriefFile, readRunFormats, refuseMissingTmux, refuseModeAndBriefClashes, refuseResumeClashes, refuseSchemaFlag, refuseSessionIdClash, refuseTerminalMismatch } from './bootFlags.js'
import { agentsWithCliDefs, mainThreadAgentOf, resolvePermissions, thinkingConfigOf } from './sessionChoices.js'
import { noStdinChunks, readStdinChunks, readStdinWithPeek, refuseEmptyRunPrompt, refuseSwallowedPrompt } from './runPrompt.js'
import { resolveMcpConfigs } from './mcpConfigs.js'
import { interactiveLaunch } from './interactiveLaunch.js'
import { runLaunch } from './runLaunch.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export async function defaultAction(inputPromptArg: string | undefined, opts: RootOptions): Promise<void> {
  if ((opts as { version?: boolean }).version) {
    console.log(`Mercury ${MACRO.VERSION}`)
    process.exit(0)
  }
  try {
    recordLaunchMilestone('runtime-entry', { boot: getIsInteractive() ? 'interactive' : 'headless' })
  } catch (error) {
    passedOver(error)
  }
  const cliName = binaryName()
  const isNonInteractiveSession = !getIsInteractive()
  const runMode = Boolean(opts.runMode)
  const runnerDoor = opts.runner === true

  refuseTerminalMismatch(inputPromptArg, { cliName, isNonInteractiveSession, runMode, runnerDoor })

  const worktreeOpt = opts.worktree as string | boolean | undefined
  const tmuxEnabled = Boolean(opts.multiplex)
  if (tmuxEnabled && !worktreeOpt) failCli('--multiplex requires --worktree')
  if (tmuxEnabled && process.platform === 'win32') failCli('--multiplex is not supported on Windows')
  if (tmuxEnabled) await refuseMissingTmux()

  refuseResumeClashes(opts, runMode)
  const sessionIdOpt = typedString(opts.sessionId)
  if (sessionIdOpt) await refuseSessionIdClash(opts, sessionIdOpt)
  refuseModeAndBriefClashes(opts, runMode, runnerDoor)
  let customSystemPrompt = typedString(opts.brief)
  let appendSystemPrompt = typedString(opts.briefAdd)
  for (const [fileOpt, assign] of [
    [typedString(opts.briefFile), (text: string) => (customSystemPrompt = text)],
    [typedString(opts.briefAddFile), (text: string) => (appendSystemPrompt = text)],
  ] as const) {
    if (fileOpt) await readBriefFile(fileOpt, assign)
  }

  const { inputFormat, outputFormat, includePartialMessages } = readRunFormats(opts, runMode, runnerDoor)
  const schemaFlag = runMode ? typedString(opts.schema) : undefined
  if (schemaFlag !== undefined) await refuseSchemaFlag(schemaFlag)

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
  const { isWorktreeModeEnabled } = await import('./worktreeModeEnabled.js')
  const worktreeEnabled = Boolean(worktreeOpt) && isWorktreeModeEnabled()

  const thinkingOpt = typedString(opts.reasoningMode)
  const { noteSessionThinkingConfig, shouldEnableThinkingByDefault } = await import('../../models/effort/thinking.js')
  const thinkingConfig = thinkingConfigOf(thinkingOpt, shouldEnableThinkingByDefault)
  noteSessionThinkingConfig(thinkingConfig)

  const agentInfo = await getAgentDefinitionsWithOverrides()
  const { activeAgents, allAgents } = agentsWithCliDefs(opts, agentInfo)
  const { lspAgentNote } = await import('../../integrations/lsp-family/toolFamily.js')
  const mainThreadAgentDefinition = mainThreadAgentOf(opts, activeAgents, lspAgentNote)

  let userSpecifiedModel = typedString(opts.model)
  if (userSpecifiedModel !== undefined && userSpecifiedModel !== 'default') {
    const { matchReachableModelName, modelNameHeadlessRefusal } = await import('../../models/catalogue/modelNameRoad.js')
    const matched = matchReachableModelName(userSpecifiedModel, 'pass')
    if (matched?.kind === 'match') {
      addBootNote('info', `--model ${matched.said}`)
      userSpecifiedModel = matched.id
    } else if (matched?.kind === 'exact') {
      userSpecifiedModel = matched.id
    } else if (matched !== null && (matched.kind === 'ambiguous' || matched.kind === 'none')) {
      if (runMode) failCli(modelNameHeadlessRefusal(matched, '--model'), 1)
      addBootNote('warn', `${modelNameHeadlessRefusal(matched, '--model')} The session starts on its default model; /model picks another.`)
      userSpecifiedModel = undefined
    }
  }
  if (userSpecifiedModel === 'default') userSpecifiedModel = getDefaultEngineModelSetting() ?? undefined
  let fallbackModel = typedString(opts.backupModel)
  if (fallbackModel === 'default') fallbackModel = getDefaultEngineModelSetting() ?? undefined
  if (!userSpecifiedModel && mainThreadAgentDefinition?.model && mainThreadAgentDefinition.model !== 'inherit') {
    userSpecifiedModel = mainThreadAgentDefinition.model
  }
  if (userSpecifiedModel) setEngineModelOverride(userSpecifiedModel)
  if (runMode) {
    const { readComputedDefaultCatalogue } = await import('../../models/catalogue/computedDefault.js')
    await readComputedDefaultCatalogue()
  }
  const resolvedInitialModel = getEngineModel()

  const sessionTitle = typedString(opts.title)?.trim() || undefined

  let prompt: string | AsyncIterable<string> | undefined = inputPrompt
  let syntaxInput: string | undefined
  if (runnerDoor) {
    prompt = noStdinChunks()
  } else if (!process.stdin.isTTY) {
    if (inputFormat === 'rows') {
      prompt = readStdinChunks()
    } else {
      const collected = await readStdinWithPeek(runMode ? (inputPrompt === undefined ? -1 : 1_000) : 3000)
      if (collected === null && runMode && inputPrompt === undefined) failCli('mercury run could not read its prompt from stdin', 1)
      if (collected === null && inputPrompt === undefined) {
        writeErr(
          'No stdin data arrived within 3s; proceeding without piped input. Redirect from the null device to skip the wait, or keep the pipe open longer to include its data.',
        )
      }
      const pieces = [inputPrompt, collected ?? undefined].filter(
        (piece): piece is string => typeof piece === 'string' && piece.length > 0,
      )
      if (runMode && collected) syntaxInput = inputPrompt ?? ''
      prompt = runMode && inputPrompt && collected
        ? `${inputPrompt}\n\n<stdin>\n${collected}${collected.endsWith('\n') ? '' : '\n'}</stdin>`
        : pieces.length > 0 ? pieces.join('\n') : undefined
    }
  }

  refuseSwallowedPrompt({ opts, prompt, runMode, inputFormat, mainThreadAgentDefinition, cliName })

  if (mainThreadAgentDefinition?.initialPrompt) {
    if (typeof prompt === 'string') {
      prompt = `${mainThreadAgentDefinition.initialPrompt}\n${prompt}`
      if (syntaxInput !== undefined) syntaxInput = `${mainThreadAgentDefinition.initialPrompt}\n${syntaxInput}`
    } else if (prompt === undefined) {
      prompt = mainThreadAgentDefinition.initialPrompt
    }
  }

  refuseEmptyRunPrompt(opts, prompt, runMode, inputFormat)

  const { mcpConfigPromise, regularDynamicMcpConfig } = resolveMcpConfigs(opts)

  if (flagEnv('MERCURY_ENTRYPOINT') !== 'local-agent') {
    initBundledSkills()
  }
  const { getProjectRoot } = await import('../process-state/processState.js')
  const cwd = process.cwd()
  if (!worktreeEnabled && !isNonInteractiveSession && checkHasTrustDialogAccepted()) {
    void getInstructionFiles().catch(passedOver)
  }
  profileCheckpoint('action_before_setup')
  const setupPromise = sessionSetup(
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
  let commandsPromise: Promise<import('../../commands/catalogue/commands.js').Command[]>
  if (worktreeEnabled) {
    await setupPromise
    commandsPromise = getCommands(getProjectRoot())
  } else {
    setupPromise.catch(passedOver)
    commandsPromise = getCommands(cwd)
    commandsPromise.catch(passedOver)
    await setupPromise
  }
  profileCheckpoint('action_after_setup')
  const commands = await commandsPromise
  profileCheckpoint('action_commands_loaded')

  if (isNonInteractiveSession) {
    applyMergedConfigEnv()
    void getSystemContext().catch(passedOver)
    void getUserContext().catch(passedOver)
  }

  if (opts.concourseOff === true || opts.concourseOn === true) {
    const { setConcourseEnabled } = await import('../../screen/concourse-model/concourseEnabled.js')
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
