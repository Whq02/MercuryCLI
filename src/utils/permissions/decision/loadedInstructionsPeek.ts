export type LoadedInstructionEntry = {
  path: string
  parent?: string
}

type LoadedInstructionsPeek = () => Promise<readonly LoadedInstructionEntry[]> | undefined

let registered: LoadedInstructionsPeek | undefined

export function registerLoadedInstructionsPeek(peek: LoadedInstructionsPeek): void {
  registered = peek
}

export function peekLoadedInstructions(): Promise<readonly LoadedInstructionEntry[]> | undefined {
  if (registered === undefined) {
    throw new Error('loaded instructions peek is not registered: call registerBootDoors() at startup')
  }
  return registered()
}
