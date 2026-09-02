/**
 * XML/HTML escaping for element text and attribute values. Use whenever
 * untrusted text (process output, user input, external data) is
 * interpolated into markup.
 */

/** Ampersand must be escaped FIRST, or the other replacements' entities get double-escaped. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** For interpolation inside a quoted attribute value. */
export function escapeXmlAttr(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Inverse of {@link escapeXml}: restore the original bytes for DISPLAY once
 *  the text has been pulled back out of its transport tag. Ampersand must be
 *  unescaped LAST, mirroring escapeXml's first-ampersand rule, or `&amp;lt;`
 *  would wrongly become `<`. */
export function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}
