const taggedBlock = /<([a-z][A-Za-z0-9_-]*)(?:\s[^>]*)?(?<!\/)>[\s\S]*?<\/\1>\n?/g
const ideBlock = /<(ide_opened_file|ide_selection)(?:\s[^>]*)?(?<!\/)>[\s\S]*?<\/\1>\n?/g

export function stripDisplayTags(text: string): string {
  return stripDisplayTagsAllowEmpty(text) || text
}

export function stripDisplayTagsAllowEmpty(text: string): string {
  return text.replace(taggedBlock, '').trim()
}

export function stripIdeContextTags(text: string): string {
  return text.replace(ideBlock, '').trim()
}
