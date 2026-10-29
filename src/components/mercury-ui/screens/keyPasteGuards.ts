
export function keyPasteGuardNote(
  raw: string,
  opts: {
    stores: string
    looksLike?: string
  },
): string | null {
  const value = raw.trim()
  if (!value) return null
  if (/^sk-ant-/i.test(value)) {
    return `That is an Anthropic API key (sk-ant-…) — this step stores ${opts.stores}.`
  }
  if (/\s/.test(value)) {
    return `That does not look like ${opts.looksLike ?? 'an API key'} (it contains whitespace).`
  }
  return null
}
