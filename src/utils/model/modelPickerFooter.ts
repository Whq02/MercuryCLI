// The /model picker footer keybind hint, width-disciplined. On a narrow panel the
// OPTIONAL segments shed right-to-left (c context → ←→ effort → the ↵ switch/gated
// action) so the essential "↑↓ select … esc close" nav+exit floor never wraps onto a
// continuation line (the ragged-wrap the retired rail layout suffered below ~64 cols).
// Pure (no ink/react) so it unit-tests without a renderer (prove-model-picker-layout).
// All segment glyphs (↑↓ ←→ ↵ · + ASCII) are single terminal cells, so String.length
// equals the display width here — no wide-char measurement needed.
export function modelPickerFooter(
  opts: { hasEffort: boolean; supports1m: boolean; gated: boolean; enableFlag?: string; roleFocused?: boolean },
  innerWidth: number,
): string {
  const head = '↑↓ select'
  const tail = 'esc close'
  // A focused ROLE row swaps the action vocabulary for the seat-slot grammar
  // m cycles model, +/− steps effort.
  if (opts.roleFocused) {
    const middle = [
      { text: 'm model', show: true, drop: 1 },
      { text: '+/- effort', show: true, drop: 2 },
    ]
    const join = (parts: string[]): string => parts.join(' · ')
    let shown = middle.filter(s => s.show)
    const fits = (): boolean => join([head, ...shown.map(s => s.text), tail]).length <= innerWidth
    while (!fits() && shown.length > 0) {
      let victim = 0
      for (let k = 1; k < shown.length; k++) if (shown[k]!.drop > shown[victim]!.drop) victim = k
      shown = shown.filter((_, k) => k !== victim)
    }
    return join([head, ...shown.map(s => s.text), tail])
  }
  const action = opts.gated ? `gated${opts.enableFlag ? ` (${opts.enableFlag})` : ''}` : '↵ switch'
  // Middle segments in DISPLAY order; `drop` = shed priority (higher sheds first).
  // head + tail are the floor and never shed.
  const middle = [
    { text: '←→ effort', show: opts.hasEffort, drop: 2 },
    { text: 'c context', show: opts.supports1m, drop: 3 },
    { text: action, show: true, drop: 1 },
  ]
  const join = (parts: string[]): string => parts.join(' · ')
  let shown = middle.filter(s => s.show)
  const fits = (): boolean => join([head, ...shown.map(s => s.text), tail]).length <= innerWidth
  while (!fits() && shown.length > 0) {
    let victim = 0
    for (let k = 1; k < shown.length; k++) if (shown[k]!.drop > shown[victim]!.drop) victim = k
    shown = shown.filter((_, k) => k !== victim)
  }
  return join([head, ...shown.map(s => s.text), tail])
}
