import type { CommandSpec } from '../registry.js'
import { unbuilt } from '../../../pi/holes.js'

const timeout: CommandSpec = unbuilt('src/utils/bash/specs/timeout.ts:3')

export default timeout
