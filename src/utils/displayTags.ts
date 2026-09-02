const DISPLAY_TAG_PATTERN = /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g

const IDE_CONTEXT_TAG_PATTERN = /<(ide_opened_file|ide_selection)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g

export function stripDisplayTags(text: string): string {
  const stripped = text.replace(DISPLAY_TAG_PATTERN, '').trim()
  return stripped === '' ? text : stripped
}

export function stripDisplayTagsAllowEmpty(text: string): string {
  return text.replace(DISPLAY_TAG_PATTERN, '').trim()
}

export function stripIdeContextTags(text: string): string {
  return text.replace(IDE_CONTEXT_TAG_PATTERN, '').trim()
}
