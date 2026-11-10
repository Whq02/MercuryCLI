import type { DesktopApplication, DesktopTree } from '../../services/desktop/driver.js'
import { addressWords, bearsPage, shownAddress, targetMatches, targetWords } from './fastRoad.js'
import { interactiveRole } from './screenMap.js'

interface WaitCondition {
  role?: string
  name?: string
  text?: string
  title?: string
  url?: string
  dialog?: boolean
  focus?: string
  gone?: boolean
}

const DIALOG_ROLE = /\b(?:AXApplicationDialog|AXSystemDialog|AXSheet|AXDialog)\b/
const FRAME_ROW = /^AX(?:Application|Window|GrowArea)\b|\(AX(?:Close|Minimize|Zoom|FullScreen|Toolbar)Button\)$/
const FRAME_SUBTREE = /^(?:AXMenuBar|AXScrollBar|TitleBar)\b/
const TEXT_ROLE = /^AX(?:StaticText|WebArea|Heading|Table|Outline|List|Browser)\b/

export function waitConditionRefusal(until: WaitCondition): string | null {
  const fields = [until.role, until.name, until.text, until.title, until.url, until.focus].filter(value => value !== undefined)
  if (fields.some(value => typeof value !== 'string' || !value.trim())) return 'until needs nonempty text, role/name, title, url or focus'
  if (until.dialog !== undefined && typeof until.dialog !== 'boolean') return 'until.dialog must be true or false'
  if (until.gone !== undefined && typeof until.gone !== 'boolean') return 'until.gone must be true or false'
  const element = until.role !== undefined || until.name !== undefined || until.text !== undefined
  const kinds = Number(element) + Number(until.title !== undefined) + Number(until.url !== undefined) + Number(until.dialog === true) + Number(until.focus !== undefined)
  if (kinds === 0) return 'until needs nonempty text, role/name, title, url, dialog: true or focus'
  if (kinds !== 1) return 'until takes one element, title, url, dialog or focus condition'
  if (until.gone && !element && until.dialog !== true) return 'until.gone needs an element target or dialog: true'
  return null
}

export function waitConditionWords(until: WaitCondition): string {
  if (until.title !== undefined) return `title ${JSON.stringify(until.title)}`
  if (until.url !== undefined) return `url ${JSON.stringify(until.url)}`
  if (until.dialog === true) return until.gone ? 'dialog gone' : 'dialog open'
  if (until.focus !== undefined) return `focus ${until.focus}`
  return `${until.gone ? 'gone' : 'found'} ${targetWords(until)}`
}

function exposesContent(app: DesktopApplication, tree: DesktopTree): boolean {
  const titles = new Set([app.title, ...tree.elements.filter(element => /^AXWindow\b/.test(element.role)).map(element => element.title)].filter(title => title !== null && title !== undefined))
  let frameDepth: number | null = null
  for (const element of tree.elements) {
    if (frameDepth !== null && element.depth > frameDepth) continue
    frameDepth = FRAME_SUBTREE.test(element.role) ? element.depth : null
    if (frameDepth !== null || FRAME_ROW.test(element.role)) continue
    const words = [element.title, element.value].filter((text): text is string => text !== null && text.trim() !== '')
    if (words.some(text => !titles.has(text))) return true
    if (words.length === 0 && (interactiveRole(element.role) || TEXT_ROLE.test(element.role))) return true
  }
  return false
}

function settledAbsence(app: DesktopApplication, tree: DesktopTree): boolean {
  if (tree.truncated || tree.webContent === 'pending') return false
  return tree.webContent !== 'absent' || bearsPage(app, tree) === false
}

export function waitConditionPassed(until: WaitCondition, app: DesktopApplication, tree: DesktopTree): boolean {
  const includes = (value: string, expected: string) => value.replace(/\s+/g, ' ').toLowerCase().includes(expected.replace(/\s+/g, ' ').toLowerCase())
  if (until.title !== undefined) return includes(app.title ?? '', until.title)
  if (until.url !== undefined) {
    return tree.elements.some(element => {
      if (!/^(AX)?(TextField|ComboBox|SearchField)$/i.test(element.role) || !/address|location|url|search/i.test(element.title ?? '') || element.focused === true) return false
      const url = shownAddress(element.value)
      const bare = (text: string) => text.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
      return url !== null && [element.value ?? '', url.href, addressWords(url)].some(form => includes(bare(form), bare(until.url!)))
    })
  }
  if (until.dialog === true) {
    const open = tree.elements.some(element => DIALOG_ROLE.test(element.role)) || (tree.focused != null && DIALOG_ROLE.test(tree.focused.role))
    return until.gone ? !open && settledAbsence(app, tree) : open
  }
  if (until.focus !== undefined) {
    const focused = tree.focused ?? tree.elements.find(element => element.focused === true && !element.role.includes('Window'))
    return focused != null && focused.role.replace(/\s+/g, ' ').trim().toLowerCase() === until.focus.replace(/\s+/g, ' ').trim().toLowerCase()
  }
  const found = targetMatches(tree, until).length > 0
  if (!until.gone) return found
  const namedByText = until.name !== undefined || until.text !== undefined
  return !found && settledAbsence(app, tree) && (!namedByText || exposesContent(app, tree))
}
