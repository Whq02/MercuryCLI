type RGB = { r: number; g: number; b: number }

const FRAME_VOCABULARY = ['✶', '✸', '✹', '✺', '✹', '✷']

export function getDefaultCharacters(): string[] {
  return [...FRAME_VOCABULARY]
}

export function interpolateColor(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(a.r + t * (b.r - a.r)),
    g: Math.round(a.g + t * (b.g - a.g)),
    b: Math.round(a.b + t * (b.b - a.b)),
  }
}

export function toRGBColor(c: RGB): string {
  return `rgb(${c.r},${c.g},${c.b})`
}

const parseCache = new Map<string, RGB | null>()

export function parseRGB(colorString: string): RGB | null {
  const cached = parseCache.get(colorString)
  if (cached !== undefined) return cached

  const text = colorString.trim()
  const decimal = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(text)
  let color: RGB | null = null
  if (decimal) {
    color = { r: Number(decimal[1]), g: Number(decimal[2]), b: Number(decimal[3]) }
  } else if (/^#[a-f\d]{6}$/i.test(text)) {
    const value = parseInt(text.slice(1), 16)
    color = { r: value >> 16, g: (value >> 8) & 255, b: value & 255 }
  }
  parseCache.set(colorString, color)
  return color
}
