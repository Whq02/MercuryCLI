import type { Command } from './command.js'
import { isCommandEnabled as commandEnablement } from './command.js'
import { chatOnlyBoot } from '../../screen/routes/surfaceRoute.js'

export function commandOffInPlainWorld(command: Command): boolean {
  return command.needsConcourse === true && chatOnlyBoot()
}

export function isCommandEnabled(command: Command): boolean {
  return commandEnablement(command) && !commandOffInPlainWorld(command)
}
