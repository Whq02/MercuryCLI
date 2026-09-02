export function modelPickerFooter(
  opts: { hasEffort: boolean; supports1m: boolean; gated: boolean; enableFlag?: string; roleFocused?: boolean },
  innerWidth: number,
): string {
  const head = '↑↓ select'
  const tail = 'esc close'
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
