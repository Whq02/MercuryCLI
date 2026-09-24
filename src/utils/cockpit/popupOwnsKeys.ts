import { isFilesMenuOpen, subscribeFilesMenu } from './filesMenu.js'
import { isSettingsPopupOpen, subscribeSettingsPopup } from './settingsPopup.js'

export function popupOwnsKeys(): boolean {
  return isSettingsPopupOpen() || isFilesMenuOpen()
}

export function subscribePopupOwnsKeys(listener: () => void): () => void {
  const settings = subscribeSettingsPopup(listener)
  const files = subscribeFilesMenu(listener)
  return () => {
    settings()
    files()
  }
}
