import type { Command } from '../../commands.js'
import { focusedSessionModelFacts } from '../../services/engine-connector/focusedConnector.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { renderModelName } from '../../services/model/model.js'
import { unbuilt } from '../../pi/holes.js'

const hole: Command = unbuilt('src/commands/model/index.ts:6')

export default hole
