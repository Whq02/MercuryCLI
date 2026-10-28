import type { DesktopApplication, DesktopTree } from '../../services/desktop/driver.js'
import { targetMatches, targetWords } from './fastRoad.js'

export interface WaitCondition {
  role?: string
  name?: string
  text?: string
  title?: string
  url?: string
  gone?: boolean
}

export function waitConditionRefusal(until: WaitCondition): string | null {
  const fields = [until.role, until.name, until.text, until.title, until.url].filter(value => value !== undefined)
  if (!fields.length || fields.some(value => typeof value !== 'string' || !value.trim())) return 'until needs nonempty text, role/name, title or url'
  if (until.gone !== undefined && typeof until.gone !== 'boolean') return 'until.gone must be true or false'
  const element = until.role !== undefined || until.name !== undefined || until.text !== undefined
  if (Number(element) + Number(until.title !== undefined) + Number(until.url !== undefined) !== 1) return 'until takes one element, title or url condition'
  if (until.gone && !element) return 'until.gone needs an element target'
  return null
}

export function waitConditionWords(until: WaitCondition): string {
  if (until.title !== undefined) return `title ${JSON.stringify(until.title)}`
  if (until.url !== undefined) return `url ${JSON.stringify(until.url)}`
  return `${until.gone ? 'gone' : 'found'} ${targetWords(until)}`
}

export function waitConditionPassed(until: WaitCondition, app: DesktopApplication, tree: DesktopTree): boolean {
  const includes = (value: string, expected: string) => value.replace(/\s+/g, ' ').toLowerCase().includes(expected.replace(/\s+/g, ' ').toLowerCase())
  if (until.title !== undefined) return includes(app.title ?? '', until.title)
  if (until.url !== undefined) return tree.elements.some(element => /^(AX)?(TextField|ComboBox|SearchField)$/i.test(element.role) && /address|location|url|search/i.test(element.title ?? '') && /^https?:\/\//i.test(element.value ?? '') && includes(element.value ?? '', until.url!))
  const found = targetMatches(tree, until).length > 0
  return until.gone ? !found && !tree.truncated && tree.webContent !== 'pending' && tree.webContent !== 'absent' : found
}
