export function journalSettingOn(settings: { memory?: { journal?: boolean } } | null | undefined): boolean {
  return settings?.memory?.journal === true
}
