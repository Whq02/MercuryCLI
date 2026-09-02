
const drafts = new Map<string, string>()

export const MAIN_DRAFT_KEY = 'main'

export function stashViewDraft(key: string, text: string): void {
  if (text) {
    drafts.set(key, text)
  } else {
    drafts.delete(key)
  }
}

export function takeViewDraft(key: string): string {
  return drafts.get(key) ?? ''
}

export function clearViewDrafts(): void {
  drafts.clear()
}
