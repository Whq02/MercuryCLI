
type RGB = { r: number; g: number; b: number }

const FRAME_VOCABULARY = ['✶', '✸', '✹', '✺', '✹', '✷']

export function getDefaultCharacters(): string[] {
  return [...FRAME_VOCABULARY]
}

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
