import type { ElementHandle } from 'puppeteer-core'
import { type LiveSession, bounded } from './page.js'
import { passedOverAs } from '../../../platform/errors/passedOver.js'

const HUMAN_MOVE_BUDGET_MS = 80
const HUMAN_CLICK_DWELL_MIN_MS = 18
const HUMAN_CLICK_DWELL_MAX_MS = 38
const HUMAN_CLICK_HOLD_MIN_MS = 14
const HUMAN_CLICK_HOLD_MAX_MS = 32
const HUMAN_TYPE_BUDGET_MS = 400

function humanCursorPath(
  start: { x: number; y: number },
  end: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const origin =
    Math.hypot(end.x - start.x, end.y - start.y) < 2
      ? { x: Math.max(2, end.x - 18), y: Math.max(2, end.y - 12) }
      : start
  const dx = end.x - origin.x
  const dy = end.y - origin.y
  const dist = Math.max(1, Math.hypot(dx, dy))
  const steps = Math.min(20, Math.max(8, Math.round(Math.log2(dist / 12 + 1) * 4)))
  const nx = -dy / dist
  const ny = dx / dist
  const side = (Math.round(origin.x + end.y) & 1) === 0 ? 1 : -1
  const spread = Math.min(72, Math.max(6, dist * (0.12 + Math.random() * 0.08))) * side
  const p1 = {
    x: origin.x + dx * 0.3 + nx * spread * 0.85,
    y: origin.y + dy * 0.3 + ny * spread * 0.85,
  }
  const p2 = {
    x: origin.x + dx * 0.72 + nx * spread * 1.05,
    y: origin.y + dy * 0.72 + ny * spread * 1.05,
  }
  const points: Array<{ x: number; y: number }> = []
  for (let i = 1; i <= steps; i++) {
    if (i === steps) {
      points.push({ x: end.x, y: end.y })
      continue
    }
    const t = i / steps
    const u = t * t * (3 - 2 * t)
    const mt = 1 - u
    const x = mt * mt * mt * origin.x + 3 * mt * mt * u * p1.x + 3 * mt * u * u * p2.x + u * u * u * end.x
    const y = mt * mt * mt * origin.y + 3 * mt * mt * u * p1.y + 3 * mt * u * u * p2.y + u * u * u * end.y
    points.push({ x: Math.max(0, x), y: Math.max(0, y) })
  }
  return points
}

export async function humanMoveTo(s: LiveSession, to: { x: number; y: number }): Promise<void> {
  const from = s.cursor ?? { x: 160, y: 120 }
  const points = humanCursorPath(from, to)
  const stepWaitMs = Math.max(2, Math.floor(HUMAN_MOVE_BUDGET_MS / points.length))
  for (const pt of points) {
    await s.page.mouse.move(pt.x, pt.y)
    s.cursor = { x: pt.x, y: pt.y }
    await bounded(Math.max(1, stepWaitMs + Math.floor((Math.random() - 0.5) * 2)))
  }
}

export async function pickTargetPoint(
  s: LiveSession,
  handle: ElementHandle<Element>,
): Promise<{ x: number; y: number }> {
  const base = await handle.clickablePoint()
  const box = await handle.boundingBox().catch(passedOverAs(null))
  if (!box || box.width < 10 || box.height < 10) return base
  const jx = base.x + (Math.random() - 0.5) * Math.min(8, box.width * 0.2)
  const jy = base.y + (Math.random() - 0.5) * Math.min(6, box.height * 0.2)
  if (handle.frame.parentFrame() !== null) return base
  const safe = await s.page
    .evaluate(
      (el, x, y) => {
        let hit = document.elementFromPoint(x, y)
        while (hit?.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(x, y)
          if (!inner || inner === hit) break
          hit = inner
        }
        return Boolean(hit && (hit === el || el.contains(hit)))
      },
      handle,
      jx,
      jy,
    )
    .catch(passedOverAs(false))
  return safe ? { x: jx, y: jy } : base
}

export async function humanClickPoint(s: LiveSession, x: number, y: number): Promise<void> {
  await humanMoveTo(s, { x, y })
  const dwellMs =
    HUMAN_CLICK_DWELL_MIN_MS +
    Math.floor(Math.random() * (HUMAN_CLICK_DWELL_MAX_MS - HUMAN_CLICK_DWELL_MIN_MS + 1))
  await bounded(dwellMs)
  await s.page.mouse.down()
  const holdMs =
    HUMAN_CLICK_HOLD_MIN_MS +
    Math.floor(Math.random() * (HUMAN_CLICK_HOLD_MAX_MS - HUMAN_CLICK_HOLD_MIN_MS + 1))
  await bounded(holdMs)
  await s.page.mouse.up()
}

export async function humanTypeText(s: LiveSession, text: string): Promise<void> {
  const chars = Array.from(text)
  if (chars.length === 0) return
  const maxMeanMs = Math.max(2, Math.min(20, Math.floor(HUMAN_TYPE_BUDGET_MS / Math.max(chars.length, 1))))
  const minKeyMs = Math.max(1, Math.floor(maxMeanMs * 0.45))
  const spanMs = Math.max(2, maxMeanMs - minKeyMs)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    await s.page.keyboard.type(ch)
    if (i + 1 < chars.length) {
      const boundaryBoost = /[\s.,;!?-]/.test(ch) ? Math.min(8, Math.ceil(spanMs * 0.5)) : 0
      const wave = (i * 7 + ch.charCodeAt(0)) % (spanMs + 1)
      const jitter = Math.floor(Math.random() * Math.max(2, Math.ceil(spanMs * 0.5)))
      const delayMs = Math.min(
        maxMeanMs + boundaryBoost,
        minKeyMs + Math.floor((wave + jitter) / 2) + boundaryBoost,
      )
      await bounded(delayMs)
    }
  }
}
