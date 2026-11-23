let claimed = false
let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
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


export function subscribeModelPickerPopup(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
