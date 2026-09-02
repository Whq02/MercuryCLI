// Spinner frame vocabulary + RGB helpers. parseRGB accepts the
// functional rgb(r,g,b) form (whitespace tolerant) and 6-digit hex only,
// memoized per string INCLUDING null results; named terminal colours yield
// null so callers fall back to non-interpolated rendering.

export type RGB = { r: number; g: number; b: number }

const FRAME_VOCABULARY = ['✶', '✸', '✹', '✺', '✹', '✷']

/** The spinner frame vocabulary (one sweep; consumers mirror for the swing). */
export function getDefaultCharacters(): string[] {
  return [...FRAME_VOCABULARY]
}

/** Component-wise interpolation, rounded. */
export function interpolateColor(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  }
}

export function toRGBColor(c: RGB): string {
  return `rgb(${c.r},${c.g},${c.b})`
}

/** Fixed saturation 0.7 / lightness 0.6; hue normalised into [0, 360)
 *  including negatives. */
export function hueToRgb(hue: number): RGB {
  const h = ((hue % 360) + 360) % 360
  const s = 0.7
  const l = 0.6
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  }
}

const parseCache = new Map<string, RGB | null>()

export function parseRGB(colorString: string): RGB | null {
  const cached = parseCache.get(colorString)
  if (cached !== undefined) return cached
  let result: RGB | null = null
  const fn = colorString.match(
    /^\s*rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)\s*$/,
  )
  if (fn) {
    result = { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]) }
  } else {
    const hex = colorString.match(/^\s*#([0-9a-fA-F]{6})\s*$/)
    if (hex) {
      const value = parseInt(hex[1]!, 16)
      result = {
        r: (value >> 16) & 0xff,
        g: (value >> 8) & 0xff,
        b: value & 0xff,
      }
    }
  }
  parseCache.set(colorString, result)
  return result
}
