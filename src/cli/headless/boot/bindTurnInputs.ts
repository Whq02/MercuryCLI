import type { QueuedCommand } from '../../../types/textInputTypes.js'
import { dequeue } from '../../../utils/messageQueueManager.js'
import { recordTranscript } from '../../../utils/sessionStorage/writer.js'
import { logForDebugging } from '../../../utils/debug.js'
import type { ContentBlockParam } from '../../../types/wire.js'
import { parseSlashCommand } from '../../../utils/slashCommandParsing.js'
import { findCommand, isCommandEnabled } from '../../../commands.js'
import { existsSync } from 'node:fs'
import type { RowDraft } from '../../../rows/project.js'
import * as printTurn from '../printTurn.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'
import { notBuilt } from '../../../pi/holes.js'

function run(ports: RunnerPorts): BootMade<'isMainThreadCommand' | 'takeMainThread' | 'recordNoticeRows' | 'recordHostNoticeRows' | 'missionLineOf' | 'localCommandInput' | 'executeTurn'> {
  return notBuilt('src/cli/headless/boot/bindTurnInputs.ts:13')
}

export const bindTurnInputs: BootStep<'isMainThreadCommand' | 'takeMainThread' | 'recordNoticeRows' | 'recordHostNoticeRows' | 'missionLineOf' | 'localCommandInput' | 'executeTurn'> = { name: 'bindTurnInputs', makes: ['isMainThreadCommand', 'takeMainThread', 'recordNoticeRows', 'recordHostNoticeRows', 'missionLineOf', 'localCommandInput', 'executeTurn'], run }
