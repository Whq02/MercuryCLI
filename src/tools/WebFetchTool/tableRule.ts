import type TurndownService from 'turndown'

const SECTIONS = new Set(['THEAD', 'TBODY', 'TFOOT'])

function childrenOf(node: Element): Element[] {
  return Array.from(node.children ?? [])
}

function rowsOf(table: Element): Element[][] {
  const rows: Element[] = []
  for (const child of childrenOf(table)) {
    if (child.nodeName === 'TR') rows.push(child)
    else if (SECTIONS.has(child.nodeName)) for (const row of childrenOf(child)) if (row.nodeName === 'TR') rows.push(row)
  }
  return rows.map(row => childrenOf(row).filter(cell => cell.nodeName === 'TD' || cell.nodeName === 'TH')).filter(cells => cells.length > 0)
}

function spans(cell: Element): boolean {
  return ['colspan', 'rowspan'].some(name => {
    const value = cell.getAttribute(name)?.trim()
    return value !== undefined && value !== '' && value !== '1'
  })
}

export function addTableRule(service: TurndownService): void {
  const cellText = (cell: Element): string => service.turndown(cell as HTMLElement).replace(/\s+/g, ' ').trim()
  service.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const table = node as HTMLElement
      const rows = rowsOf(table)
      if (rows.length === 0) return ''
      const caption = childrenOf(table).find(child => child.nodeName === 'CAPTION')
      const lead = caption ? `${cellText(caption)}\n\n` : ''
      const width = rows[0]!.length
      const headerRows = rows.filter(row => row.every(cell => cell.nodeName === 'TH'))
      const simple = headerRows.length === 1 && headerRows[0] === rows[0]
        && rows.every(row => row.length === width && !row.some(spans))
        && !table.querySelector('table')
      const lines = simple
        ? [
            `| ${rows[0]!.map(cell => cellText(cell).replace(/\|/g, '\\|')).join(' | ')} |`,
            `| ${rows[0]!.map(() => '---').join(' | ')} |`,
            ...rows.slice(1).map(row => `| ${row.map(cell => cellText(cell).replace(/\|/g, '\\|')).join(' | ')} |`),
          ]
        : rows.map(row => row.map(cellText).join(' · '))
      return `\n\n${lead}${lines.join('\n')}\n\n`
    },
  })
}
