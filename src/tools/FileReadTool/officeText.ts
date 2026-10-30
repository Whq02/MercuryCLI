type Node = { name: string; attrs: Record<string, string>; children: (Node | string)[] }

function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (all, code: string) => {
    if (code.startsWith('#')) {
      const n = code[1] === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all
    }
    return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[code] ?? all
  })
}
function parse(xml: string): Node {
  const root: Node = { name: '', attrs: {}, children: [] }
  const stack = [root]
  for (const token of xml.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(?:(?:"[^"]*"|'[^']*'|[^'">])*)>|[^<]+/g)) {
    const value = token[0]
    const parent = stack.at(-1)!
    if (value.startsWith('<![CDATA[')) { parent.children.push(value.slice(9, -3)); continue }
    if (value.startsWith('<?') || value.startsWith('<!')) continue
    if (value.startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
    if (!value.startsWith('<')) { parent.children.push(decode(value)); continue }
    const match = /^<([^\s/>]+)/.exec(value)
    if (!match) continue
    const node: Node = { name: match[1]!.split(':').at(-1)!, attrs: {}, children: [] }
    for (const attr of value.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[attr[1]!.split(':').at(-1)!] = decode(attr[2] ?? attr[3] ?? '')
    parent.children.push(node)
    if (!value.endsWith('/>')) stack.push(node)
  }
  return root
}
const nodes = (node: Node): Node[] => node.children.filter((child): child is Node => typeof child !== 'string')
function all(node: Node, name: string): Node[] {
  const result: Node[] = []
  const pending = [node]
  while (pending.length) {
    const current = pending.pop()!
    if (current.name === name) result.push(current)
    pending.push(...nodes(current).reverse())
  }
  return result
}
const first = (node: Node, name: string) => all(node, name)[0]
const text = (node: Node): string => node.children.map(c => typeof c === 'string' ? c : text(c)).join('')
function runs(node: Node): string {
  if (node.name === 't' || node.name === 'delText') return text(node)
  if (node.name === 'ins' || node.name === 'del') return `[${node.name === 'ins' ? 'inserted' : 'deleted'}: ${nodes(node).map(runs).join('')}]`
  if (node.name === 'tab') return '\t'
  if (node.name === 'br' || node.name === 'cr') return '\n'
  if (node.name === 'footnoteReference' || node.name === 'endnoteReference') return `[^${node.attrs.id}]`
  if (node.name === 'commentReference') return `[comment ${node.attrs.id}]`
  return nodes(node).map(runs).join('')
}
const clean = (s: string) => s.replace(/\n{3,}/g, '\n\n').trim()
const cell = (s: string) => s.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()

export function officeWord(xml: string, styles = ''): string {
  const styleMap = new Map(all(parse(styles), 'style').map(s => [s.attrs.styleId, s]))
  function paragraph(p: Node): string {
    const id = first(p, 'pStyle')?.attrs.val ?? ''
    const style = styleMap.get(id)
    const outline = first(p, 'outlineLvl')?.attrs.val ?? (style && first(style, 'outlineLvl')?.attrs.val)
    const heading = /heading\s*([1-6])/i.exec(id) ?? /heading\s*([1-6])/i.exec(style ? first(style, 'name')?.attrs.val ?? '' : '')
    const level = heading ? Number(heading[1]) : outline !== undefined && Number(outline) < 6 ? Number(outline) + 1 : 0
    const list = first(p, 'numPr')
    const indent = list ? '  '.repeat(Math.min(8, Number(first(list, 'ilvl')?.attrs.val) || 0)) : ''
    return `${level ? '#'.repeat(level) + ' ' : list ? `${indent}- ` : ''}${runs(p).trim()}`
  }
  function wordCell(node: Node): string {
    const span = Number(first(node, 'gridSpan')?.attrs.val) || 1
    const merge = first(node, 'vMerge')
    const dimensions = [span > 1 ? `colspan ${span}` : '', merge ? (merge.attrs.val === 'restart' ? 'row merge start' : 'row merge continuation') : ''].filter(Boolean)
    return `${cell(walk(node))}${dimensions.length ? ` [${dimensions.join('; ')}]` : ''}`
  }
  function walk(node: Node): string {
    if (node.name === 'tbl') return nodes(node).filter(n => n.name === 'tr').map(row => `| ${nodes(row).filter(n => n.name === 'tc').map(wordCell).join(' | ')} |`).join('\n')
    if (node.name === 'p') return paragraph(node)
    if (['footnote', 'endnote', 'comment'].includes(node.name)) {
      if (Number(node.attrs.id) < 0 || node.attrs.type === 'separator' || node.attrs.type === 'continuationSeparator') return ''
      const body = nodes(node).map(walk).filter(Boolean).join('\n')
      return node.name === 'comment' ? `[comment ${node.attrs.id}${node.attrs.author ? `, ${node.attrs.author}` : ''}] ${body}` : `[^${node.attrs.id}]: ${body}`
    }
    return nodes(node).map(walk).filter(Boolean).join('\n')
  }
  return clean(walk(parse(xml)))
}

export function officeSlides(xml: string): string {
  function walk(node: Node): string {
    if (node.name === 'sp') {
      const kind = first(node, 'ph')?.attrs.type
      const body = nodes(node).map(walk).filter(Boolean).join('\n')
      return ['title', 'ctrTitle'].includes(kind ?? '') ? `### ${body}` : body
    }
    if (node.name === 'tbl') return nodes(node).filter(n => n.name === 'tr').map(row => `| ${nodes(row).filter(n => n.name === 'tc').map(c => cell(walk(c))).join(' | ')} |`).join('\n')
    if (node.name === 'p') {
      const props = first(node, 'pPr')
      const bullet = props && (first(props, 'buChar') || first(props, 'buAutoNum'))
      return `${bullet ? `${'  '.repeat(Math.min(8, Number(props?.attrs.lvl) || 0))}- ` : ''}${runs(node)}`
    }
    return nodes(node).map(walk).filter(Boolean).join('\n')
  }
  return clean(walk(parse(xml)))
}

export function officeOdf(xml: string): string {
  function walk(node: Node): string {
    if (node.name === 'h') return `${'#'.repeat(Math.max(1, Math.min(6, Number(node.attrs['outline-level']) || 1)))} ${inline(node)}`
    if (node.name === 'p') return inline(node)
    if (node.name === 'list-item') return `- ${nodes(node).map(walk).filter(Boolean).join('\n  ')}`
    if (node.name === 'note') return `[^${text(first(node, 'note-citation') ?? node)}]: ${walk(first(node, 'note-body') ?? { name: '', attrs: {}, children: [] })}`
    if (node.name === 'annotation') return `[comment${first(node, 'creator') ? `, ${text(first(node, 'creator')!)}` : ''}] ${nodes(node).filter(n => n.name === 'p').map(walk).join(' ')}`
    if (node.name === 'table') return `## ${node.attrs.name ?? 'Table'}\n${nodes(node).map(walk).filter(Boolean).join('\n')}`
    if (node.name === 'table-row') {
      const cells: string[] = []
      for (const c of nodes(node).filter(n => n.name === 'table-cell' || n.name === 'covered-table-cell')) {
        const value = clean(nodes(c).map(walk).join(' ')) || c.attrs['string-value'] || c.attrs.value || c.attrs['date-value'] || c.attrs['boolean-value'] || ''
        const rendered = `${cell(value)}${c.attrs.formula ? ` [=${c.attrs.formula.replace(/^\w+:=/, '')}]` : ''}`
        const count = Number(c.attrs['number-columns-repeated']) || 1
        if (count > 16384) throw new Error('The spreadsheet row exceeds 16384 columns.')
        for (let i = 0; i < count; i++) cells.push(rendered)
      }
      const row = cells.join('\t')
      const count = Number(node.attrs['number-rows-repeated']) || 1
      if (count > 1) return row.trim() ? `${row}\n[row repeated ${count} times]` : ''
      return row
    }
    if (node.name === 'page') return `## Slide ${node.attrs.name ?? ''}\n${nodes(node).map(walk).filter(Boolean).join('\n')}`
    return nodes(node).map(walk).filter(Boolean).join('\n')
  }
  function inline(node: Node): string {
    return node.children.map(c => {
      if (typeof c === 'string') return c
      if (c.name === 's') return ' '.repeat(Math.min(1000, Number(c.attrs.c) || 1))
      if (c.name === 'tab') return '\t'
      if (c.name === 'line-break') return '\n'
      if (c.name === 'note' || c.name === 'annotation') return walk(c)
      return inline(c)
    }).join('')
  }
  return clean(walk(parse(xml)))
}

export function officeSpreadsheet(xml: string, shared: string[]): string {
  const root = parse(xml)
  const rows = all(root, 'row').map(row => {
    const cells: string[] = []
    for (const c of nodes(row).filter(n => n.name === 'c')) {
      const reference = /^([A-Z]+)\d+$/.exec(c.attrs.r ?? '')?.[1]
      const index = reference ? [...reference].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1 : cells.length
      if (index > 16383) throw new Error('The spreadsheet row exceeds 16384 columns.')
      while (cells.length < index) cells.push('')
      const raw = text(first(c, 'v') ?? { name: '', attrs: {}, children: [] })
      const value = c.attrs.t === 's' ? shared[Number(raw)] ?? raw : c.attrs.t === 'inlineStr' ? all(c, 't').map(text).join('') : raw
      const formula = first(c, 'f')
      cells[index] = `${cell(value)}${formula ? ` [=${text(formula)}]` : ''}`
    }
    return cells.join('\t')
  }).join('\n')
  const merges = all(root, 'mergeCell').map(node => node.attrs.ref).filter(Boolean)
  return rows + (merges.length ? `\n[Merged cells: ${merges.join(', ')}]` : '')
}

export function officeRelationships(xml: string): Map<string, string> {
  return new Map(all(parse(xml), 'Relationship').map(n => [n.attrs.Id ?? '', n.attrs.Target ?? '']))
}
export function officeSheetNames(xml: string): { name: string; id: string }[] {
  return all(parse(xml), 'sheet').map(s => ({ name: s.attrs.name ?? '', id: s.attrs.id ?? '' }))
}
export function officeComments(xml: string): string {
  return all(parse(xml), 'cm').map(c => `[comment ${c.attrs.idx ?? ''}${c.attrs.authorId ? `, author ${c.attrs.authorId}` : ''}] ${text(first(c, 'text') ?? c)}`).join('\n')
}
export function officeSlideIds(xml: string): string[] {
  return all(parse(xml), 'sldId').map(s => s.attrs.id ?? '')
}
