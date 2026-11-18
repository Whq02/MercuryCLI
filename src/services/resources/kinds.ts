import type { ResourceAdapter } from './contracts.js'
import { gitAdapter } from './adapters/git.js'
import { journeyAdapter } from './adapters/journey.js'
import { serviceAdapter } from './adapters/service.js'
import { structureAdapter } from './adapters/structure.js'
import { testAdapter } from './adapters/test.js'
import { ideAdapter } from './adapters/ide.js'
import { missionAdapter } from './adapters/mission.js'
import { projectAdapter } from './adapters/project.js'
import { repoAdapter } from './adapters/repo.js'
import { transcriptAdapter } from './adapters/transcript.js'
import { workbenchAdapter } from './adapters/workbench.js'

export function resourceKinds(): ResourceAdapter[] {
  return [
    gitAdapter,
    journeyAdapter,
    serviceAdapter,
    structureAdapter,
    testAdapter,
    ideAdapter,
    missionAdapter,
    projectAdapter,
    repoAdapter,
    transcriptAdapter,
    workbenchAdapter,
  ]
}
