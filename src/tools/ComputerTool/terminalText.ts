import type { DesktopApplication, DesktopDriver, DesktopFocusedText, DesktopTree } from '../../services/desktop/driver.js'
import { sameWindow } from './fastRoad.js'

const TERMINALS = new Set(['com.apple.Terminal', 'com.googlecode.iterm2', 'com.mitchellh.ghostty', 'org.alacritty', 'net.kovidgoyal.kitty', 'com.github.wez.wezterm', 'dev.warp.Warp-Stable', 'dev.warp.Warp-Preview'])

export function isTerminalApplication(app: DesktopApplication): boolean {
  return process.platform === 'darwin' && TERMINALS.has(app.identity)
}

export function terminalTextWords(app: DesktopApplication, value: DesktopFocusedText): string {
  const range = value.visibleRange
  const visible = range && Number.isInteger(range.location) && Number.isInteger(range.length) && range.location >= 0 && range.length >= 0 && range.location + range.length <= value.text.length
  const selected = visible ? value.text.slice(range.location, range.location + range.length) : value.text
  const text = selected.split('\n').map(line => line.trimEnd()).join('\n').replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd()
  const cut = text.length > 15_000
  return `terminal text: ${app.name} (${app.identity}) — ${visible ? 'visible range' : 'whole AX value; visible range unavailable'}; no image\nfocus: ${value.role}${value.title ? ` ${JSON.stringify(value.title)}` : ''}\n${text.slice(0, 15_000)}${cut ? '\n[cut at 15000 chars]' : ''}`
}

export async function readTerminalText(driver: DesktopDriver, app: DesktopApplication, signal: AbortSignal, tree?: DesktopTree): Promise<string> {
  let value: DesktopFocusedText | null = null
  if (driver.focusedText) {
    const answer = await driver.focusedText(app, signal)
    if (!answer.ok) throw new Error(answer.error.note)
    value = answer.value
  } else {
    const answer = tree ? { ok: true as const, value: tree } : await driver.accessibilityTree(app, { depth: 32, count: 2000, scope: 'window' }, signal)
    if (!answer.ok) throw new Error(answer.error.note)
    const areas = answer.value.elements.filter(e => e.role.startsWith('AXTextArea') && e.value !== null)
    const area = areas.find(e => e.focused) ?? (areas.length === 1 ? areas[0] : undefined)
    if (area) value = { text: area.value!, role: area.role, title: area.title }
  }
  const after = await driver.frontmostApplication()
  if (signal.aborted) throw new Error('interrupted')
  if (!after.ok || !sameWindow(app, after.value)) throw new Error('the front window changed while reading terminal text — re-issue')
  return value ? terminalTextWords(app, value) : `terminal text unavailable: ${app.name} exposes no focused AXTextArea value — use screenshot with pixels:true`
}
