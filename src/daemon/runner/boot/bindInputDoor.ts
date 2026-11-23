import * as inputDoor from '../inputDoor.js'
import type { InputRow } from '../../../engine/rows/vocabulary.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'acceptInput' | 'acceptInputRow'> {
  const acceptInput = (input: inputDoor.AcceptedInput): Promise<inputDoor.InputVerdict> => {
    if (input.kind === 'prompt') ports.tellStandingMode()
    return inputDoor.acceptInput(input, ports)
  }

  const acceptInputRow = (row: InputRow): Promise<inputDoor.InputVerdict> => inputDoor.acceptInputRow(row, ports)
  return { acceptInput, acceptInputRow }
}

export const bindInputDoor: BootStep<'acceptInput' | 'acceptInputRow'> = { name: 'bindInputDoor', makes: ['acceptInput', 'acceptInputRow'], run }
