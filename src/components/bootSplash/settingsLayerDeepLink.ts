let settingsLayerDeepLink = false;
export function armBootSettingsLayerDeepLink(): void {
  settingsLayerDeepLink = true;
}
export function consumeBootSettingsLayerDeepLink(): boolean {
  const armed = settingsLayerDeepLink;
  settingsLayerDeepLink = false;
  return armed;
}
