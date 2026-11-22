import { notBuilt } from '../pi/holes.js'

export function cliError(msg?: string): never {
  return notBuilt('src/cli/exit.ts:2')
}

export function cliJsonError(msg?: string): never {
  return notBuilt('src/cli/exit.ts:9')
}

export function cliOk(msg?: string): never {
  return notBuilt('src/cli/exit.ts:16')
}
