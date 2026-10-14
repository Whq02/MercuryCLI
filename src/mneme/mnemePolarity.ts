import { wordsOf } from './mnemeText.js'

export const POLARITY_PAIRS: ReadonlyArray<{ name: string; left: readonly string[]; right: readonly string[] }> = [
  { name: 'always/never', left: ['always'], right: ['never'] },
  { name: 'on/off', left: ['on'], right: ['off'] },
  { name: 'enabled/disabled', left: ['enable', 'enables', 'enabled', 'enabling'], right: ['disable', 'disables', 'disabled', 'disabling'] },
  { name: 'allowed/forbidden', left: ['allow', 'allows', 'allowed', 'allowing'], right: ['forbid', 'forbids', 'forbade', 'forbidden', 'forbidding', 'deny', 'denies', 'denied', 'denying'] },
  { name: 'included/excluded', left: ['include', 'includes', 'included', 'including'], right: ['exclude', 'excludes', 'excluded', 'excluding'] },
  { name: 'before/after', left: ['before'], right: ['after'] },
  { name: 'true/false', left: ['true'], right: ['false'] },
]

export const POLARITY_WORDS: ReadonlySet<string> = new Set(POLARITY_PAIRS.flatMap(pair => [...pair.left, ...pair.right]))

export type PolaritySides = Map<string, { left: boolean; right: boolean }>

export function polaritySides(words: readonly string[]): PolaritySides {
  const sides: PolaritySides = new Map()
  for (const pair of POLARITY_PAIRS) {
    sides.set(pair.name, { left: words.some(word => pair.left.includes(word)), right: words.some(word => pair.right.includes(word)) })
  }
  return sides
}

export function flippedPolarity(a: PolaritySides, b: PolaritySides): string | null {
  for (const pair of POLARITY_PAIRS) {
    const left = a.get(pair.name)!
    const right = b.get(pair.name)!
    if ((left.left && !left.right && right.right && !right.left) || (left.right && !left.left && right.left && !right.right)) return pair.name
  }
  return null
}

export function polarityFlipBetween(left: string, right: string): string | null {
  return flippedPolarity(polaritySides(wordsOf(left)), polaritySides(wordsOf(right)))
}
