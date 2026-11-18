import * as inputDoor from '../inputDoor.js'
import type { InputRow } from '../../../rows/vocabulary.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'acceptInput' | 'acceptInputRow' | 'claimGatedInput'> {
  const acceptInput = (input: inputDoor.AcceptedInput): Promise<inputDoor.InputVerdict> => inputDoor.acceptInput(input, ports)

  const acceptInputRow = (row: InputRow): Promise<inputDoor.InputVerdict> => inputDoor.acceptInputRow(row, ports)

  const claimGatedInput = (source: AsyncGenerator<InputRow, void, unknown>): AsyncGenerator<InputRow, void, unknown> => inputDoor.claimGatedInput(source, ports)
  return { acceptInput, acceptInputRow, claimGatedInput }
}

export const bindInputDoor: BootStep<'acceptInput' | 'acceptInputRow' | 'claimGatedInput'> = { name: 'bindInputDoor', makes: ['acceptInput', 'acceptInputRow', 'claimGatedInput'], run }
