import type { Command } from '../../commands.js'
import { focusedSessionModelFacts } from '../../services/engine-connector/focusedConnector.js'
import { EFFORT_LEVELS, modelSupportsEffort, parseEffortValue, resolveStampedEffortTruth } from '../../utils/effort.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { unbuilt } from '../../pi/holes.js'

const hole: Command = unbuilt('src/commands/effort/index.ts:6')

export default hole
