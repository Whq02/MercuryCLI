// ============================================================================
//  keyPasteGuards — the ONE spelling of the key-paste draft guards
//  Every key/token paste surface — the /logins card's
//  legs and the Boot face's logins layer — refuses the same two classes
//  before any driver runs: an Anthropic API key pasted into a foreign
//  family's prompt, and a value with whitespace (not a key at all). The
//  sentences lived once per component; they live HERE now, parameterized
//  by what the step stores, byte-identical where they already stood.
//  Guards are draft-time honesty; the drivers own probe/store/receipt.
// ============================================================================

export function keyPasteGuardNote(
  raw: string,
  opts: {
    /** What this step stores, spliced verbatim: "… — this step stores
     *  ${stores}." (a family may append its redirect sentence here). */
    stores: string
    /** The whitespace sentence's noun (default 'an API key'; the Hugging
     *  Face token leg says 'a token'). */
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
