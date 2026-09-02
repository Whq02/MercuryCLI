import type { Command } from '../types/command.js'
import { isCommandEnabled as commandEnablement } from '../types/command.js'
import { chatOnlyBoot } from '../context/surfaceRoute.js'

export function commandOffInPlainWorld(command: Command): boolean {
  return command.needsConcourse === true && chatOnlyBoot()
}

export function commandRetired(command: Command): string | undefined {
  return command.retired
}

export function isCommandEnabled(command: Command): boolean {
  return commandEnablement(command) && !commandOffInPlainWorld(command) && commandRetired(command) === undefined
}
