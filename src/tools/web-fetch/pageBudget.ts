export const MAX_FETCH_PAGE_CHARS = 38_000

export function pageSlice(markdown: string, from = 0, maxBytes = Infinity): { text: string; notice: string; end: number } {
  if (!Number.isSafeInteger(from) || from < 0 || from > markdown.length) {
    throw new Error(`from must be a whole character offset from 0 through ${markdown.length}.`)
  }
  if (from > 0 && /[\uDC00-\uDFFF]/.test(markdown.charAt(from)) && /[\uD800-\uDBFF]/.test(markdown.charAt(from - 1))) {
    throw new Error(`from splits a character; use from: ${from - 1}.`)
  }
  let end = Math.min(markdown.length, from + MAX_FETCH_PAGE_CHARS)
  if (end < markdown.length) {
    const paragraph = markdown.lastIndexOf('\n\n', end - 2)
    if (paragraph > from + MAX_FETCH_PAGE_CHARS / 2) end = paragraph + 2
    if (/[\uD800-\uDBFF]/.test(markdown.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(markdown.charAt(end))) end--
  }
  if (Buffer.byteLength(markdown.slice(from, end)) > maxBytes) {
    let low = from, high = end
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (Buffer.byteLength(markdown.slice(from, mid)) <= maxBytes) low = mid
      else high = mid - 1
    }
    end = low
    if (/[\uD800-\uDBFF]/.test(markdown.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(markdown.charAt(end))) end--
  }
  const text = markdown.slice(from, end)
  const estimate = Math.ceil(text.length / 4)
  const continuation = end < markdown.length
    ? `the page continues; ${end} of ${markdown.length} characters reached — call again with from: ${end}`
    : 'end of page'
  return { text, end, notice: `[Page text: characters ${from}–${end}; ${text.length} of ${markdown.length} characters shown; about ${estimate} tokens estimated from characters/4 (code runs higher); ${continuation}.]` }
}
