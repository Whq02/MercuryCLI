// The image painter's always-works floor: convert a PNG into half-block (▀)
// truecolor ANSI — each terminal cell stacks TWO image pixels (upper half =
// foreground colour, lower half = background colour) via U+2580. This is just
// coloured text, so a <RawAnsi> mount renders it as transcript cells on EVERY
// terminal (Mac/Windows), scrolls natively, and needs no graphics protocol —
// the guaranteed fallback below the real-pixel tiers (iTerm2 IIP / sixel).
//
// sharp is loaded LAZILY, never statically: its module-scope loader THROWS
// when no prebuilt native binding resolves (e.g. the self-contained
// dist/mercury.mjs copied outside any node_modules tree — the join-kit shape),
// and a static import would take the whole bundle down at boot. Deferred, a
// missing binding degrades only sprite rendering, at call time, with sharp's
// own remedy text in the error.
type Sharp = typeof import('sharp').default
let sharpLoad: Promise<Sharp> | null = null
const loadSharp = (): Promise<Sharp> => {
  sharpLoad ??= import('sharp').then(
    m => ((m as { default?: Sharp }).default ?? m) as Sharp,
  )
  return sharpLoad
}

const ESC = String.fromCharCode(27)
// Transparent pixels always map to the terminal background. White-MATTE
// pixels are decided by the border flood-fill below (buildOutsideMask), not a
// flat per-channel threshold — see the white-spots note there.
const isTransparent = (a: number): boolean => a < 40
// Loose near-white for the FLOOD test only: bright AND near-neutral. Warm
// whites (250,242,230) qualify; light fur (210,180,160) does not.
const isNearWhite = (r: number, g: number, b: number): boolean => {
  const mn = Math.min(r, g, b)
  const mx = Math.max(r, g, b)
  return mn >= 222 && mx - mn <= 32
}

/**
 * Border flood-fill matte: a pixel is
 * BACKGROUND only when it is transparent-or-near-white AND CONNECTED TO THE
 * IMAGE BORDER through such pixels — i.e. the white generation matte and its
 * anti-aliased fringe. The old flat `r,g,b > 238` test failed BOTH ways:
 * warm-white AA blends (250,242,235) slipped through as painted near-white
 * specks along the silhouette, while genuinely white sprite INTERIOR (a cat's
 * white chest) was punched to terminal background. Interior whites now render;
 * only the outside matte drops. 4-connected BFS over ≤200×400 px — trivial.
 */
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

// `lines`: one terminal row each (exactly `cols` half-block columns wide, ANSI
// escapes inline) — the shape <RawAnsi> wants. `.join('\n')` for a raw string.
export type SpriteAnsi = { lines: string[]; cols: number; rows: number }

/**
 * Render a PNG (path or buffer) to half-block ANSI fitted to `cols` terminal
 * columns. Returns one ANSI line per terminal row plus the cell dimensions
 * (rows = image rows / 2), ready to hand to <RawAnsi lines width>.
 */
export async function spriteToAnsi(
  src: string | Buffer,
  cols = 44,
  dewhite = false,
): Promise<SpriteAnsi> {
  const sharp = await loadSharp()
  const meta = await sharp(src).metadata()
  const aspect = (meta.height ?? 1) / (meta.width ?? 1)
  const pxW = Math.max(1, Math.min(cols, 200))
  // Clamp rows the same way pxW is clamped: a degenerate-aspect PNG (e.g. a
  // 60×6000 image → aspect 100) would otherwise derive thousands of ANSI lines
  // that get both rendered as one RawAnsi leaf AND persisted verbatim to the
  // session JSONL. A real sprite fitted to `cols` never approaches MAX_ROWS.
  const MAX_ROWS = 200
  const rows = Math.max(1, Math.min(Math.round((pxW * aspect) / 2), MAX_ROWS))
  const pxH = rows * 2
  // Kernel per direction: DOWN-scaling a source wider than the target (a detailed
  // 90px sprite → 28 mascot cells, or a 512px image → 44 cells) uses
  // CUBIC so the shape + colour survive instead of dropping ~2/3 of the pixels
  // (nearest turned detailed art to noise). NOT lanczos3 — its negative lobes
  // OVERSHOOT bright edges brighter than the source, spitting pale/near-white specks
  // the warm-ink palette shouldn't have. UP-scaling / ~1:1 keeps `nearest` (crisp).
  const kernel = (meta.width ?? pxW) > pxW ? 'cubic' : 'nearest'
  const { data, info } = await sharp(src)
    .resize(pxW, pxH, { fit: 'fill', kernel })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const ch = info.channels
  // Matte decision: transparent OR border-connected near-white. Computed HERE —
  // before dewhite's luminance cap mutates the very whites the flood keys on.
  const outside = buildOutsideMask(data, info.width, info.height, ch)
  // De-white (mascot bakes, opt-in): at cell size a very bright pixel — a specular
  // flame highlight or a white eye — reads as WHITE and fights the warm-ink look.
  // Cap luminance so the brightest cells stay bright-but-WARM (hue preserved); vivid
  // mid-brights (flame orange, jelly cyan) below the cap are untouched. A plain
  // image (dewhite=false) is unchanged.
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
        // white-spots root cause (part A): this case would otherwise emit ▀
        // with NO foreground set — the glyph's upper half painted in the
        // TERMINAL'S DEFAULT (light) foreground, a bright speck at every cell
        // where the sprite's top silhouette lands mid-cell (the operator's cat:
        // specks hugging ear tips / head top / back ridge). Emit the LOWER
        // half-block instead: fg = the bottom pixel, upper half = terminal bg.
        row += `${ESC}[49m${ESC}[38;2;${br};${bg2};${bb}m▄`
        continue
      }
      // fg = upper pixel; bg = lower pixel; reset (49) to the terminal bg for empties.
      const fg = `${ESC}[38;2;${tr};${tg};${tb}m`
      const bg = botBg ? `${ESC}[49m` : `${ESC}[48;2;${br};${bg2};${bb}m`
      row += `${fg}${bg}▀`
    }
    lines.push(row + `${ESC}[0m`)
  }
  return { lines, cols: pxW, rows }
}
