/**
 * The phase the streaming spinner is reflecting for the current turn.
 *
 * Set by the stream handler (`utils/messages.ts` → `onSetStreamMode`) as the
 * turn progresses, held as REPL state (`useState<SpinnerMode>('responding')`),
 * and consumed by the spinner renderers to pick glyphs/shimmer behavior:
 *   - `'requesting'`  — request in flight, awaiting the first token (↑ glyph,
 *                       fast 50ms shimmer that sweeps in the upload direction).
 *   - `'responding'`  — model is streaming assistant text back (↓ glyph).
 *   - `'thinking'`    — model is in an extended-thinking block (↓ glyph; drives
 *                       the "thinking…" / duration status in `Spinner.tsx`).
 *   - `'tool-use'`    — a tool call is executing (↓ glyph; `GlimmerMessage`
 *                       branches on this).
 *   - `'tool-input'`  — streaming a tool call's input arguments (↓ glyph).
 *
 * The set is closed: `SpinnerModeGlyph`'s `switch (mode)` in
 * `SpinnerAnimationRow.tsx` exhaustively handles these five with no default.
 */
export type SpinnerMode =
  | 'requesting'
  | 'responding'
  | 'thinking'
  | 'tool-use'
  | 'tool-input'

/**
 * An RGB color as a plain object of three 0–255 integer channels.
 *
 * This is the spinner's INTERNAL working color representation, distinct from
 * `ink/styles`' `RGBColor` (which is the `` `rgb(r,g,b)` `` template-literal
 * STRING form fed to `<Text color=…>`). `utils.ts` interpolates/derives colors
 * on this object form (`interpolateColor`, `hueToRgb`, `parseRGB`) and only
 * stringifies at the edge via `toRGBColor`. Fields are accessed positionally as
 * `.r`/`.g`/`.b` and constructed from `Math.round(...)`/`parseInt(...)`, so each
 * channel is a `number`.
 */
export type RGBColor = {
  r: number
  g: number
  b: number
}
