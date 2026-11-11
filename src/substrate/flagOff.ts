export function flagReadsOff(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false
  const folded = raw.replace(/^["']+|["']+$/g, '').trim().toLowerCase()
  return folded === '0' || folded === 'false' || folded === 'no' || folded === 'off'
}
