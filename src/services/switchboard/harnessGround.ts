import { passedOver } from '../../utils/passedOver.js'

let trueBootGround: string | null = null

export async function applyHarnessGround(dir: string | null): Promise<string> {
  const state = await import('../../bootstrap/state.js')
  if (trueBootGround === null) trueBootGround = state.getOriginalCwd()
  const target = dir !== null && dir.length > 0 ? dir : trueBootGround
  try {
    process.chdir(target)
  } catch (error) {
    passedOver(error)
  }
  state.setOriginalCwd(target)
  state.setProjectRoot(target)
  state.setCwdState(target)
  try {
    const gitFs = await import('../../utils/git/gitFilesystem.js')
    gitFs.regroundGitWatch()
  } catch (error) {
    passedOver(error)
  }
  try {
    const projectConfig = await import('../../utils/config/projectConfig.js')
    projectConfig.getProjectPathForConfig.cache?.clear?.()
  } catch (error) {
    passedOver(error)
  }
  try {
    const settingsCache = await import('../../utils/settings/settingsCache.js')
    settingsCache.resetSettingsCache()
  } catch (error) {
    passedOver(error)
  }
  try {
    const detector = await import('../../utils/settings/changeDetector.js')
    await detector.settingsChangeDetector.reground()
  } catch (error) {
    passedOver(error)
  }
  try {
    const instructions = await import('../instructions/engine.js')
    instructions.clearInstructionFileCaches()
  } catch (error) {
    passedOver(error)
  }
  try {
    const context = await import('../../context.js')
    context.getGitStatus.cache?.clear?.()
    context.getSystemContext.cache?.clear?.()
    context.getUserContext.cache?.clear?.()
  } catch (error) {
    passedOver(error)
  }
  try {
    const git = await import('../../utils/git.js')
    git.getIsGit.cache?.clear?.()
  } catch (error) {
    passedOver(error)
  }
  try {
    const commands = await import('../../commands.js')
    commands.clearCommandsCache()
  } catch (error) {
    passedOver(error)
  }
  try {
    const agents = await import('../../tools/AgentTool/loadAgentsDir.js')
    agents.clearAgentDefinitionsCache()
  } catch (error) {
    passedOver(error)
  }
  try {
    const examples = await import('../../utils/exampleCommands.js')
    examples.getExampleCommandFromCache.cache?.clear?.()
    examples.refreshExampleCommands.cache?.clear?.()
  } catch (error) {
    passedOver(error)
  }
  try {
    const onboarding = await import('../../projectOnboardingState.js')
    onboarding.shouldShowProjectOnboarding.cache?.clear?.()
    onboarding.projectOnboardingHint.cache?.clear?.()
  } catch (error) {
    passedOver(error)
  }
  try {
    const extensions = await import('../../extensions/boot.js')
    extensions.setExtensionsPending(true)
  } catch (error) {
    passedOver(error)
  }
  try {
    const slot = await import('../engine-connector/focusedConnector.js')
    slot.emitFocusedSessionConnectorChanged()
  } catch (error) {
    passedOver(error)
  }
  return target
}
