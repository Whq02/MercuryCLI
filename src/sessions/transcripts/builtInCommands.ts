let builtInCommandNames: (() => Set<string>) | undefined

export function tellSessionStorageTheBuiltInCommands(names: () => Set<string>): void {
  builtInCommandNames = names
}

export function isBuiltInCommandName(name: string): boolean {
  return builtInCommandNames === undefined || builtInCommandNames().has(name)
}
