import { marked, type Token, type Tokens } from 'marked'
import type { Block, DocumentInput } from './schema.js'

export const escapeXml = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
export const textOf = (value: unknown): string => value == null ? '' : String(value)
export function parseCsv(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false, closed = false
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]!
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') { quoted = false; closed = true }
      else field += c
    } else if (c === ',' || c === '\r' || c === '\n') {
      row.push(field); field = ''; closed = false
      if (c !== ',') { rows.push(row); row = []; if (c === '\r' && csv[i + 1] === '\n') i++ }
    } else if (c === '"' && field === '' && !closed) quoted = true
    else { if (closed || c === '"') throw new Error('Malformed CSV quotation'); field += c }
  }
  if (quoted) throw new Error('Unclosed CSV quotation')
  if (field !== '' || row.length || closed || csv.endsWith(',')) { row.push(field); rows.push(row) }
  return rows
}
export function writeCsv(rows: unknown[][]): string {
  return rows.map(row => row.map(value => { const s = textOf(value); return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s }).join(',')).join('\r\n') + '\r\n'
}
export function markdownBlocks(markdown: string): Block[] {
  const notes: Block[] = []
  const body = markdown.replace(/^\[\^([^\]]+)\]:[ \t]*(.*)$/gm, (_m, id: string, text: string) => { notes.push({ kind: 'footnote', id, text }); return '' })
  const blocks: Block[] = []
  const walk = (tokens: Token[]): void => {
    for (const token of tokens) {
      if (token.type === 'heading') blocks.push({ kind: 'heading', level: token.depth, text: token.text })
      else if (token.type === 'table') { const table = token as Tokens.Table; blocks.push({ kind: 'table', rows: [table.header.map(c => c.text), ...table.rows.map(r => r.map(c => c.text))] }) }
      else if (token.type === 'list') { const list = token as Tokens.List; blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map(i => i.text) }) }
      else if (token.type === 'blockquote') walk(token.tokens ?? [])
      else if (token.type === 'hr') blocks.push({ kind: 'pageBreak' })
      else if (token.type === 'html' && /^<!--\s*pagebreak\s*-->\s*$/.test(token.raw)) blocks.push({ kind: 'pageBreak' })
      else if (token.type === 'paragraph') {
        const images = (token.tokens ?? []).filter((t): t is Tokens.Image => t.type === 'image')
        const rest = (token.tokens ?? []).filter(t => t.type !== 'image').map(t => t.raw).join('').trim()
        if (rest) blocks.push({ kind: 'paragraph', text: rest })
        for (const image of images) blocks.push({ kind: 'image', path: image.href, alt: image.text })
      } else if ('text' in token && typeof token.text === 'string') blocks.push({ kind: 'paragraph', text: token.text })
      else if (token.type === 'html') blocks.push({ kind: 'paragraph', text: token.raw })
    }
  }
  walk(marked.lexer(body))
  return [...blocks, ...notes]
}
export function contentBlocks(input: DocumentInput): Block[] {
  const blocks = [...markdownBlocks(input.markdown ?? ''), ...(input.blocks ?? [])]
  if (input.titlePage) blocks.unshift({ kind: 'heading', level: 1, text: input.titlePage.title }, ...[input.titlePage.subtitle, input.titlePage.author].filter((s): s is string => Boolean(s)).map(text => ({ kind: 'paragraph' as const, text })), { kind: 'pageBreak' })
  return blocks
}
export function contentSheets(input: DocumentInput, blocks: Block[]) {
  const sheets = [...(input.sheets ?? [])]
  if (input.csv !== undefined) sheets.push({ name: input.sheet ?? 'Sheet1', rows: parseCsv(input.csv) })
  if (input.json) {
    const keys = [...new Set(input.json.flatMap(row => Object.keys(row)))]
    sheets.push({ name: input.sheet ?? 'Sheet1', rows: [keys, ...input.json.map(row => keys.map(k => row[k] ?? null))] })
  }
  for (const b of blocks) if (b.kind === 'table') sheets.push({ name: b.name ?? `Table${sheets.length + 1}`, rows: b.rows })
  if (!sheets.length) sheets.push({ name: input.sheet ?? 'Sheet1', rows: blocks.flatMap(b => b.kind === 'heading' || b.kind === 'paragraph' ? [[b.text]] : b.kind === 'list' ? b.items.map(s => [s]) : []) })
  return sheets
}
export function blocksMarkdown(blocks: Block[]): string {
  return blocks.map(b => {
    if (b.kind === 'heading') return `${'#'.repeat(b.level ?? 1)} ${b.text}`
    if (b.kind === 'paragraph') return b.text
    if (b.kind === 'list') return b.items.map((text, i) => `${b.ordered ? `${i + 1}.` : '-'} ${text}`).join('\n')
    if (b.kind === 'image') return `![${b.alt ?? ''}](${b.path})`
    if (b.kind === 'pageBreak') return '<!-- pagebreak -->'
    if (b.kind === 'footnote') return `[^${b.id}]: ${b.text}`
    return b.rows.map((row, i) => `| ${row.map(v => textOf(v).replaceAll('|', '\\|').replaceAll('\n', '<br>')).join(' | ')} |${i === 0 ? `\n| ${row.map(() => '---').join(' | ')} |` : ''}`).join('\n')
  }).join('\n\n') + '\n'
}
export function inlineHtml(text: string): string {
  const render = (tokens: Token[]): string => tokens.map(t => {
    if (t.type === 'strong' || t.type === 'em' || t.type === 'del') { const tag = t.type === 'strong' ? 'strong' : t.type === 'em' ? 'em' : 'del'; return `<${tag}>${render(t.tokens ?? [])}</${tag}>` }
    if (t.type === 'codespan') return `<code>${escapeXml(t.text)}</code>`
    if (t.type === 'link') return /^(https?:|mailto:)/i.test(t.href) ? `<a href="${escapeXml(t.href)}">${render(t.tokens ?? [])}</a>` : render(t.tokens ?? [])
    if (t.type === 'br') return '<br>'
    return escapeXml('text' in t ? String(t.text) : t.raw)
  }).join('')
  return render(marked.Lexer.lexInline(text)).replace(/\[\^([^\]]+)\]/g, '<sup>[$1]</sup>')
}
export function plainInline(text: string): string {
  return inlineHtml(text).replace(/<[^>]*>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&')
}
