import { markSessionPosture } from './markSessionPosture.js'
import { warnAtBoot } from './warnAtBoot.js'
import { wireProcess } from './wireProcess.js'
import { refuseBadOptions } from './refuseBadOptions.js'
import { resolveRequestedModel } from './resolveRequestedModel.js'
import { takeSessionWriter } from './takeSessionWriter.js'
import { refuseClaimlessRowsDoor } from './refuseClaimlessRowsDoor.js'
import { openWireDoor } from './openWireDoor.js'
import { tellMcpNotices } from './tellMcpNotices.js'
import { sourceRows } from './sourceRows.js'
import { watchMission } from './watchMission.js'
import { loadSession } from './loadSession.js'
import { wireSession } from './wireSession.js'
import { prependFirstPrompt } from './prependFirstPrompt.js'
import { restoreRecordedModel } from './restoreRecordedModel.js'
import { recordBootRefusal } from './recordBootRefusal.js'
import { bindRelaunch } from './bindRelaunch.js'
import { hydrateColdResume } from './hydrateColdResume.js'
import { restoreRecordedAgent } from './restoreRecordedAgent.js'
import { settleBriefs } from './settleBriefs.js'
import { endOnFailedLoad } from './endOnFailedLoad.js'
import { restoreFilesAlone } from './restoreFilesAlone.js'
import { refuseEmptyPrompt } from './refuseEmptyPrompt.js'
import { poolTools } from './poolTools.js'
import { seatSession } from './seatSession.js'
import { bindAdvisor } from './bindAdvisor.js'
import { laneMcpChanges } from './laneMcpChanges.js'
import { seedReadFileCache } from './seedReadFileCache.js'
import { watchRateLimits } from './watchRateLimits.js'
import { bindTurnTools } from './bindTurnTools.js'
import { bindSeatVerbs } from './bindSeatVerbs.js'
import { armWarm } from './armWarm.js'
import { watchMode } from './watchMode.js'
import { watchSkills } from './watchSkills.js'
import { armAgentFreshness } from './armAgentFreshness.js'
import { bindTurnInputs } from './bindTurnInputs.js'
import { bindIdleAndPark } from './bindIdleAndPark.js'
import { routeOutput } from './routeOutput.js'
import { bindNotificationFrames } from './bindNotificationFrames.js'
import { watchDrainedFrames } from './watchDrainedFrames.js'
import { startDriver } from './startDriver.js'
import { watchQueue } from './watchQueue.js'
import { watchCrew } from './watchCrew.js'
import { nudgeWhenIdle } from './nudgeWhenIdle.js'
import { ownSignals } from './ownSignals.js'
import { watchBuildBehind } from './watchBuildBehind.js'
import { registerBootCleanup } from './registerBootCleanup.js'
import { armLocalWake } from './armLocalWake.js'
import { catalogueModels } from './catalogueModels.js'
import { watchLiveMcp } from './watchLiveMcp.js'
import { bindInputDoor } from './bindInputDoor.js'
import { kickHeldNotices } from './kickHeldNotices.js'
import { openInput } from './openInput.js'
import { runToEnd } from './runToEnd.js'
import { BOOT_ENDS, type AnyBootStep, type BootStep, type GivenPorts, type RunnerPorts } from '../runnerPorts.js'

const STEPS = [
  markSessionPosture,
  warnAtBoot,
  wireProcess,
  refuseBadOptions,
  resolveRequestedModel,
  takeSessionWriter,
  refuseClaimlessRowsDoor,
  openWireDoor,
  tellMcpNotices,
  sourceRows,
  watchMission,
  loadSession,
  wireSession,
  prependFirstPrompt,
  restoreRecordedModel,
  recordBootRefusal,
  bindRelaunch,
  hydrateColdResume,
  restoreRecordedAgent,
  settleBriefs,
  endOnFailedLoad,
  restoreFilesAlone,
  refuseEmptyPrompt,
  poolTools,
  seatSession,
  bindAdvisor,
  laneMcpChanges,
  seedReadFileCache,
  watchRateLimits,
  bindTurnTools,
  bindSeatVerbs,
  armWarm,
  watchMode,
  watchSkills,
  armAgentFreshness,
  bindTurnInputs,
  bindIdleAndPark,
  routeOutput,
  bindNotificationFrames,
  watchDrainedFrames,
  startDriver,
  watchQueue,
  watchCrew,
  nudgeWhenIdle,
  ownSignals,
  watchBuildBehind,
  registerBootCleanup,
  armLocalWake,
  catalogueModels,
  watchLiveMcp,
  bindInputDoor,
  kickHeldNotices,
  openInput,
  runToEnd,
] as const

type Made<Step = (typeof STEPS)[number]> = Step extends BootStep<infer K> ? K : never
type Unmade = { [Member in Exclude<keyof RunnerPorts, Made | keyof GivenPorts> as `no step of the boot makes ${Member}`]: never }

const unmade: Unmade = {}

export const BOOT_STEPS: readonly AnyBootStep[] = unmade && STEPS

export async function runBootSteps(steps: readonly AnyBootStep[], ports: RunnerPorts, give: (step: AnyBootStep, made: Partial<RunnerPorts>) => void): Promise<void> {
  for (const step of steps) {
    const running = step.run(ports)
    const made = running instanceof Promise ? await running : running
    if (made === BOOT_ENDS) return
    give(step, made)
  }
}
