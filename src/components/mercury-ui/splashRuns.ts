// ============================================================================
//  splashRuns — the Ink-side run adapter for the shared splash compose core
//  (ruling 1, CB-06: one compose owner, two byte-emitters).
//
//  The core (assets/splash/splash-core.mjs) composes the canonical Boot
//  lockup as SGR-styled lines; the standalone driver writes those bytes to
//  its pty verbatim, while the in-process Boot face parses them HERE into
//  typed style runs and re-emits through Ink <Text> props — so NO_COLOR/256
//  degradation rides Ink's own colorize law in-process (never a second
//  capability resolver), and the composition stays byte-derived from the ONE
//  owner.
//
//  VOCABULARY LAW: the core's truecolor emitters produce exactly
//    ESC[0m (reset) · ESC[1m (bold) · ESC[1;4m (bold+underline) ·
//    ESC[2m (dim) · ESC[38;2;r;g;bm (fg) · ESC[48;2;r;g;bm (bg)
//  — parseSplashRuns understands precisely that set and REFUSES (throws) on
//  any other SGR parameter, so a core that grows a new styling channel reds
//  the splash core-parity prover instead of silently dropping paint.
//  The 48;2 background is the rasterHard mixed half-block pair — art-
//  internal ink, never a ground fill (CB-11: the face paints no ground).
// ============================================================================

export interface SplashRun {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  underline?: boolean
}

const SGR_TOKEN = /\x1b\[([0-9;]*)m/g

const hex2 = (n: number): string => n.toString(16).padStart(2, '0')

/** Parse one composed line into styled runs (SGR state machine over the
 *  core's closed emitter vocabulary). Throws on an SGR parameter outside the
 *  vocabulary — the parity prover turns that into a visible red. */
export function parseSplashRuns(line: string): SplashRun[] {
  const runs: SplashRun[] = []
  let fg: string | undefined
  let bg: string | undefined
  let bold = false
  let dim = false
  let underline = false
  let last = 0
  const push = (text: string): void => {
    if (text.length === 0) return
    const prev = runs[runs.length - 1]
    if (
      prev !== undefined &&
      prev.fg === fg &&
      prev.bg === bg &&
      prev.bold === (bold || undefined) &&
      prev.dim === (dim || undefined) &&
      prev.underline === (underline || undefined)
    ) {
      prev.text += text
      return
    }
    runs.push({
      text,
      ...(fg !== undefined ? { fg } : {}),
      ...(bg !== undefined ? { bg } : {}),
      ...(bold ? { bold } : {}),
      ...(dim ? { dim } : {}),
      ...(underline ? { underline } : {}),
    })
  }
  SGR_TOKEN.lastIndex = 0
  for (let m = SGR_TOKEN.exec(line); m !== null; m = SGR_TOKEN.exec(line)) {
    push(line.slice(last, m.index))
    last = m.index + m[0].length
    const params = (m[1] ?? '').length === 0 ? [0] : (m[1] ?? '').split(';').map(Number)
    for (let i = 0; i < params.length; i++) {
      const p = params[i]
      if (p === 0) {
        fg = undefined
        bg = undefined
        bold = false
        dim = false
        underline = false
      } else if (p === 1) bold = true
      else if (p === 2) dim = true
      else if (p === 4) underline = true
      else if ((p === 38 || p === 48) && params[i + 1] === 2) {
        const [r, g, b] = [params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0]
        const hex = `#${hex2(r)}${hex2(g)}${hex2(b)}`
        if (p === 38) fg = hex
        else bg = hex
        i += 4
      } else {
        throw new Error(`splashRuns: SGR parameter ${p} is outside the core's emitter vocabulary (${m[0].slice(1)})`)
      }
    }
  }
  push(line.slice(last))
  return runs
}
