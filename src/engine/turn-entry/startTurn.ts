import type { LegacyQueryYield } from '../loop/project-legacy.js'
import type { QueryParams } from '../loop/turn-machine.js'
import type { Terminal } from './transitions.js'

export type StartTurn = (params: QueryParams) => AsyncGenerator<LegacyQueryYield, Terminal>
