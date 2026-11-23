import { screenOf } from '../../../integrations/desktop/desktopSession.js'
import { pixelOfPoint, pixelOnScreen } from '../screenMap.js'
import { faultText } from '../call/act.js'
import type { RoadNeeds } from './needs.js'

export async function cursorRoad({ run, owner, driver }: RoadNeeds): Promise<void> {
  const cursor = await driver.cursor()
  if (!cursor.ok) {
    run.result = faultText('cursor', cursor.error)
    run.outcome = 'failed'
    return
  }
  const map = screenOf(owner)
  const at = cursor.value
  const where = `(${at.x}, ${at.y}) pt${at.display !== null ? ` on display ${at.display}` : ''}`
  if (map !== null && (at.display === null || at.display === map.display)) {
    const pixel = pixelOfPoint(map, at)
    if (pixelOnScreen(map, pixel)) {
      run.result = `cursor (${pixel.x}, ${pixel.y}) px of the last screenshot · ${where}`
      run.outcome = 'succeeded'
      return
    }
  }
  run.result = map !== null ? `cursor ${where} — outside the last screenshot` : `cursor ${where} — no screenshot yet`
  run.outcome = 'succeeded'
  return
}

export async function displaysRoad({ run, driver }: RoadNeeds): Promise<void> {
  const displays = await driver.displays()
  if (!displays.ok) {
    run.result = faultText('displays', displays.error)
    run.outcome = 'failed'
    return
  }
  const rows = displays.value.displays.map(
    d => `${d.index} — ${d.width}×${d.height} pt at (${d.originX}, ${d.originY}), scale ${d.scale}${d.primary ? ', primary' : ''}`,
  )
  run.result = rows.length > 0 ? `displays: ${rows.join(' · ')}` : 'displays: none attached'
  run.outcome = 'succeeded'
  return
}

export async function frontmostRoad({ run, driver }: RoadNeeds): Promise<void> {
  const front = await driver.frontmostApplication()
  if (!front.ok) {
    run.result = faultText('frontmost', front.error)
    run.outcome = 'failed'
    return
  }
  const app = front.value
  run.result = `frontmost: ${app.name} (${app.identity})${app.title ? ` — ${app.title}` : ''}`
  run.outcome = 'succeeded'
  return
}
