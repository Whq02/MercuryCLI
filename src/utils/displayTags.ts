/**
 * Strip XML-like wrapper blocks from text destined for UI titles.
 *
 * The pattern is deliberately generic rather than an allow-list of known
 * wrapper names (which would fall behind as new injected-context kinds
 * appear). The lowercase-initial restriction lets user prose mentioning
 * component or document markup pass through (those start with an uppercase
 * letter or an exclamation mark), and the back-referenced closing tag keeps
 * adjacent blocks separate and prevents unpaired angle brackets in prose
 * from matching.
 */
const DISPLAY_TAG_PATTERN = /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g

// The two tag names the editor integration emits.
const IDE_CONTEXT_TAG_PATTERN = /<(ide_opened_file|ide_selection)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g

/**
 * Strip and trim; when the result is empty return the ORIGINAL unchanged —
 * a title made entirely of wrapper markup is still more informative than a
 * blank one.
 */
export function stripDisplayTags(text: string): string {
  const stripped = text.replace(DISPLAY_TAG_PATTERN, '').trim()
  return stripped === '' ? text : stripped
}

/** Strip and trim, allowing an empty result. */
export function stripDisplayTagsAllowEmpty(text: string): string {
  return text.replace(DISPLAY_TAG_PATTERN, '').trim()
}

/**
 * Strip only the IDE-injected context tags and trim — used when repopulating
 * the composer from history, so user-typed lowercase markup survives while
 * IDE noise is dropped.
 */
export function stripIdeContextTags(text: string): string {
  return text.replace(IDE_CONTEXT_TAG_PATTERN, '').trim()
}
