import { memoize } from 'lodash-es'

export function getLocalISODate(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const getSessionStartDate = memoize(getLocalISODate)

export function getLocalMonthYear(): string {
  const date = new Date()
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}
