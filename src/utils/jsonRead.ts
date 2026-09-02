/**
 * The leaf BOM stripper. A widespread Windows shell writes a UTF-8 byte-order
 * mark on every file it saves and users legitimately edit configuration with
 * it; a JSON parser dies on that first character. This lives in its own leaf
 * module because the settings, JSON, logging and log-type modules form an
 * import cycle, so cycle-bound callers combine it with a raw parse.
 */
export function stripBOM(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}
