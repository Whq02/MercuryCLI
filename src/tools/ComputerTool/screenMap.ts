import type { DesktopCapture, DesktopDisplay, DesktopPoint } from '../../services/desktop/driver.js'
import type { ScreenMap } from '../../services/desktop/desktopSession.js'

export type { ScreenMap }

export type PixelOutside = { outside: true; imageWidth: number; imageHeight: number }

export function isPixelOutside(value: DesktopPoint | PixelOutside): value is PixelOutside {
  return 'outside' in value && value.outside === true
}

export function pointOfPixel(map: ScreenMap, x: number, y: number): DesktopPoint | PixelOutside {
  const inside =
    Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < map.imageWidth && y < map.imageHeight
  if (!inside) return { outside: true, imageWidth: map.imageWidth, imageHeight: map.imageHeight }
  return {
    x: Math.round(map.originX + (x * map.pointWidth) / map.imageWidth),
    y: Math.round(map.originY + (y * map.pointHeight) / map.imageHeight),
  }
}

export function pixelOfPoint(map: ScreenMap, point: DesktopPoint): { x: number; y: number } {
  return {
    x: Math.round(((point.x - map.originX) * map.imageWidth) / map.pointWidth),
    y: Math.round(((point.y - map.originY) * map.imageHeight) / map.pointHeight),
  }
}

export function pixelOnScreen(map: ScreenMap, pixel: { x: number; y: number }): boolean {
  return pixel.x >= 0 && pixel.y >= 0 && pixel.x < map.imageWidth && pixel.y < map.imageHeight
}

export function screenMapOfCapture(
  toolUseId: string,
  capture: Pick<DesktopCapture, 'display' | 'displayId' | 'originX' | 'originY' | 'capturedAt'>,
  display: Pick<DesktopDisplay, 'width' | 'height'>,
  image: { width: number; height: number },
): ScreenMap {
  return {
    toolUseId,
    display: capture.display,
    displayId: capture.displayId,
    originX: capture.originX,
    originY: capture.originY,
    pointWidth: display.width,
    pointHeight: display.height,
    imageWidth: image.width,
    imageHeight: image.height,
    capturedAt: capture.capturedAt,
  }
}

export function screenMapSizeWords(map: Pick<ScreenMap, 'imageWidth' | 'imageHeight' | 'pointWidth' | 'pointHeight'>): string {
  return `${map.imageWidth}×${map.imageHeight} px of ${map.pointWidth}×${map.pointHeight} pt`
}
