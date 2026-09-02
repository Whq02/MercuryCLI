// A courier day-sheet. Entries: { kind: 'delivery' | 'fee' | 'refund',
// pence: positive integer }. Deliveries earn; fees and refunds cost.
export function sheetTotal(entries) {
  let total = 0
  for (const entry of entries) {
    if (entry.kind === 'delivery') total += entry.pence
    else if (entry.kind === 'fee') total -= entry.pence
    else if (entry.kind === 'refund') total += entry.pence
    else throw new Error('unknown entry kind: ' + entry.kind)
  }
  return total
}

export function formatPence(pence) {
  const sign = pence < 0 ? '-' : ''
  const abs = Math.abs(pence)
  return sign + '£' + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0')
}
