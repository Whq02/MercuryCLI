import type { CheckSpec } from '../healthReport.js'
import { configHomeCheck, transcriptStoreCheck, configWritesCheck, configFieldsCheck, isolationCheck } from './crew/home.js'
import { scratchLeasesCheck, sessionScratchCheck, lifecycleCollectionCheck } from './crew/scratch.js'
import { daemonSignInsCheck, daemonCheck, mercuryProcessesCheck } from './crew/daemon.js'
import { bootBeaconCheck, launchSpineCheck, invocationRecordCheck, invocationTraceCheck, activityCheck } from './crew/boot.js'
import { historyCheck, cacheClockCheck, pidLockReleaseCheck } from './crew/appends.js'
import { permissionPostureCheck, imageDecodeCheck, agentDefinitionsCheck, seatsCheck, swarmCheck, spawnSwitchesCheck } from './crew/crewmates.js'

export function crewChecks(): CheckSpec[] {
  return [
    configHomeCheck(),
    transcriptStoreCheck(),
    configWritesCheck(),
    configFieldsCheck(),
    scratchLeasesCheck(),
    sessionScratchCheck(),
    isolationCheck(),
    daemonSignInsCheck(),
    daemonCheck(),
    mercuryProcessesCheck(),
    historyCheck(),
    bootBeaconCheck(),
    launchSpineCheck(),
    invocationRecordCheck(),
    invocationTraceCheck(),
    cacheClockCheck(),
    activityCheck(),
    pidLockReleaseCheck(),
    permissionPostureCheck(),
    lifecycleCollectionCheck(),
    imageDecodeCheck(),
    agentDefinitionsCheck(),
    seatsCheck(),
    swarmCheck(),
    spawnSwitchesCheck(),
  ]
}
