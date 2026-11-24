import type { LegacyTurnYield } from '../loop/project-legacy.js'
import type { TurnParams } from '../loop/turn-machine.js'
import type { Terminal } from './transitions.js'

export type StartTurn = (params: TurnParams) => AsyncGenerator<LegacyTurnYield, Terminal>
