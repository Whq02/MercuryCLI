let howAModelSettingResolves: ((setting: string) => string) | undefined

export function tellHowAModelSettingResolves(resolve: (setting: string) => string): void {
  howAModelSettingResolves = resolve
}

export function modelSettingResolved(setting: string): string {
  return howAModelSettingResolves === undefined ? setting : howAModelSettingResolves(setting)
}
