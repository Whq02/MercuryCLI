import { logForDebugging } from '../../platform/logs/debugLog.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'

let trueBootGround: string | null = null

export async function applyHarnessGround(dir: string | null): Promise<string> {
  const state = await import('../../boot/process-state/processState.js')
  if (trueBootGround === null) trueBootGround = state.getOriginalCwd()
  const target = dir !== null && dir.length > 0 ? dir : trueBootGround
  try {
    process.chdir(target)
  } catch (error) {
    logForDebugging(`the harness ground stays at ${process.cwd()}: ${target} could not be entered (${errorMessage(error)})`, { level: 'error' })
    return process.cwd()
  }
  state.setOriginalCwd(target)
  state.setProjectRoot(target)
  state.setCwdState(target)
  try {
    const gitFs = await import('../../platform/git/gitFilesystem.js')
    gitFs.regroundGitWatch()
  } catch (error) {
    passedOver(error)
  }
  try {
    const projectConfig = await import('../../platform/config/projectConfig.js')
    projectConfig.getProjectPathForConfig.cache?.clear?.()
  } catch (error) {
    passedOver(error)
  }
  try {
    const settingsCache = await import('../../platform/settings/settingsCache.js')
    settingsCache.resetSettingsCache()
  } catch (error) {
    passedOver(error)
  }
  try {
    const detector = await import('../../platform/settings/changeDetector.js')
    await detector.settingsChangeDetector.reground()
  } catch (error) {
    passedOver(error)
  }
  try {
    const instructions = await import('../../sessions/instructions/instructionFiles.js')
    instructions.clearInstructionFileCaches()
  } catch (error) {
    passedOver(error)
  }
  try {
    const context = await import('../../engine/requestContext.js')
    context.getGitStatus.cache?.clear?.()
    context.getSystemContext.cache?.clear?.()
    context.getUserContext.cache?.clear?.()
  } catch (error) {
    passedOver(error)
  }
  try {
    const git = await import('../../platform/git/git.js')
    git.getIsGit.cache?.clear?.()
  } catch (error) {
    passedOver(error)
  }
  try {
    const commands = await import('../../commands/catalogue/commands.js')
    commands.clearCommandsCache()
  } catch (error) {
    passedOver(error)
  }
  try {
    const agents = await import('../../tools/crewmate/loadAgentsDir.js')
    agents.clearAgentDefinitionsCache()
  } catch (error) {
    passedOver(error)
  }
  try {
    const examples = await import('../../screen/composer/exampleCommands.js')
    examples.getExampleCommandFromCache.cache?.clear?.()
    examples.refreshExampleCommands.cache?.clear?.()
  } catch (error) {
    passedOver(error)
  }
  try {
    const onboarding = await import('../../boot/projectOnboarding.js')
    onboarding.shouldShowProjectOnboarding.cache?.clear?.()
    onboarding.projectOnboardingHint.cache?.clear?.()
  } catch (error) {
    passedOver(error)
  }
  try {
    const extensions = await import('../../integrations/extensions/boot.js')
    extensions.setExtensionsPending(true)
  } catch (error) {
    passedOver(error)
  }
  try {
    const slot = await import('../../engine/connector/focusedConnector.js')
    slot.emitFocusedSessionConnectorChanged()
  } catch (error) {
    passedOver(error)
  }
  return target
}
