type ComposerInsert = (text: string) => void

let composerInsert: ComposerInsert | null = null

export function setComposerInsert(insert: ComposerInsert | null): void {
  composerInsert = insert
}

export function insertAtComposerCaret(text: string): boolean {
  if (composerInsert === null) return false
  composerInsert(text)
  return true
}
