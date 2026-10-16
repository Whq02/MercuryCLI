
export function getLocalISODate(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getLocalMonthYear(): string {
  const date = new Date()
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}
