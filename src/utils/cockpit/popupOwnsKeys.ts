import { isCrewViewOpen, subscribeCrewView } from './crewView.js'
import { isFilesMenuOpen, subscribeFilesMenu } from './filesMenu.js'
import { isSettingsPopupOpen, subscribeSettingsPopup } from './settingsPopup.js'

export function popupOwnsKeys(): boolean {
  return isSettingsPopupOpen() || isFilesMenuOpen() || isCrewViewOpen()
}

export function subscribePopupOwnsKeys(listener: () => void): () => void {
  const settings = subscribeSettingsPopup(listener)
  const files = subscribeFilesMenu(listener)
  const crew = subscribeCrewView(listener)
  return () => {
    settings()
    files()
    crew()
  }
}
