import type { LegacyQueryYield } from '../run-core/project-legacy.js'
import type { QueryParams } from '../run-core/turn-machine.js'
import type { Terminal } from './transitions.js'

export type StartTurn = (params: QueryParams) => AsyncGenerator<LegacyQueryYield, Terminal>
