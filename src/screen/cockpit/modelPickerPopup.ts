import { createSignal } from '../../platform/async/signal.js'

let claimed = false
let version = 0
const changed = createSignal()

function notify(): void {
  version += 1
  changed.emit()
}

export function claimModelPickerPopup(): void {
  if (claimed) return
  claimed = true
  notify()
}

export function releaseModelPickerPopup(): void {
  if (!claimed) return
  claimed = false
  notify()
}

export function modelPickerPopupClaimed(): boolean {
  return claimed
}


export const subscribeModelPickerPopup = changed.subscribe
