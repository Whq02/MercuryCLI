export type ModelPickerFooterDoor =
  | { open: false }
  | { open: true; onHeader: boolean; filtering: boolean }

export function modelPickerFooter(
  opts: { hasEffort: boolean; supports1m: boolean; gated: boolean; enableFlag?: string; door?: ModelPickerFooterDoor },
  innerWidth: number,
): string {
  const head = '↑↓ select'
  const door = opts.door
  const tail = door?.open ? (door.filtering ? 'esc clear' : 'esc collapse') : 'esc close'
  const action = opts.gated
    ? `gated${opts.enableFlag ? ` (${opts.enableFlag})` : ''}`
    : door === undefined
      ? '↵ switch'
      : !door.open
        ? '↵ expand'
        : door.onHeader
          ? '↵ collapse'
          : '↵ switch'
  const middle = [
    { text: '←→ effort', show: opts.hasEffort, drop: 2 },
    { text: 'c context', show: opts.supports1m, drop: 3 },
    { text: 'type to filter', show: door?.open === true, drop: 0 },
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
