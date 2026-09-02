type Sharp = typeof import('sharp').default
let sharpLoad: Promise<Sharp> | null = null
const loadSharp = (): Promise<Sharp> => {
  sharpLoad ??= import('sharp').then(
    m => ((m as { default?: Sharp }).default ?? m) as Sharp,
  )
  return sharpLoad
}

const ESC = String.fromCharCode(27)
const isTransparent = (a: number): boolean => a < 40
const isNearWhite = (r: number, g: number, b: number): boolean => {
  const mn = Math.min(r, g, b)
  const mx = Math.max(r, g, b)
  return mn >= 222 && mx - mn <= 32
}

function buildOutsideMask(
  data: Buffer,
  width: number,
  height: number,
  ch: number,
): Uint8Array {
  const outside = new Uint8Array(width * height)
  const matteish = (x: number, y: number): boolean => {
    const i = (y * width + x) * ch
    return (
      isTransparent(data[i + 3]!) || isNearWhite(data[i]!, data[i + 1]!, data[i + 2]!)
    )
  }
  const queue: number[] = []
  const push = (x: number, y: number): void => {
    const idx = y * width + x
    if (outside[idx] === 0 && matteish(x, y)) {
      outside[idx] = 1
      queue.push(idx)
    }
  }
  for (let x = 0; x < width; x++) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    push(0, y)
    push(width - 1, y)
  }
  while (queue.length > 0) {
    const idx = queue.pop()!
    const x = idx % width
    const y = (idx - x) / width
    if (x > 0) push(x - 1, y)
    if (x < width - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < height - 1) push(x, y + 1)
  }
  return outside
}

export type SpriteAnsi = { lines: string[]; cols: number; rows: number }

export async function spriteToAnsi(
  src: string | Buffer,
  cols = 44,
  dewhite = false,
): Promise<SpriteAnsi> {
  const sharp = await loadSharp()
  const meta = await sharp(src).metadata()
  const aspect = (meta.height ?? 1) / (meta.width ?? 1)
  const pxW = Math.max(1, Math.min(cols, 200))
  const MAX_ROWS = 200
  const rows = Math.max(1, Math.min(Math.round((pxW * aspect) / 2), MAX_ROWS))
  const pxH = rows * 2
  const kernel = (meta.width ?? pxW) > pxW ? 'cubic' : 'nearest'
  const { data, info } = await sharp(src)
    .resize(pxW, pxH, { fit: 'fill', kernel })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const ch = info.channels
  const outside = buildOutsideMask(data, info.width, info.height, ch)
  if (dewhite) {
    const CAP = 188
    for (let i = 0; i < data.length; i += ch) {
      if (data[i + 3] < 40) continue
      const L = 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2]
      if (L > 200) {
        const s = CAP / L
        data[i] = Math.round(data[i] * s)
        data[i + 1] = Math.round(data[i + 1] * s)
        data[i + 2] = Math.round(data[i + 2] * s)
      }
    }
  }
  const at = (x: number, y: number): readonly [number, number, number, number] => {
    const i = (y * info.width + x) * ch
    return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!]
  }
  const isBg = (x: number, y: number, a: number): boolean =>
    isTransparent(a) || outside[y * info.width + x] === 1

  const lines: string[] = []
  for (let y = 0; y < rows; y++) {
    let row = ''
    for (let x = 0; x < pxW; x++) {
      const [tr, tg, tb, ta] = at(x, y * 2)
      const [br, bg2, bb, ba] = at(x, y * 2 + 1)
      const topBg = isBg(x, y * 2, ta)
      const botBg = isBg(x, y * 2 + 1, ba)
      if (topBg && botBg) { row += `${ESC}[0m ` ; continue }
      if (topBg) {
        row += `${ESC}[49m${ESC}[38;2;${br};${bg2};${bb}m▄`
        continue
      }
      const fg = `${ESC}[38;2;${tr};${tg};${tb}m`
      const bg = botBg ? `${ESC}[49m` : `${ESC}[48;2;${br};${bg2};${bb}m`
      row += `${fg}${bg}▀`
    }
    lines.push(row + `${ESC}[0m`)
  }
  return { lines, cols: pxW, rows }
}
