import type { Key } from '../themedRenderer.js';

export function typedName(name: string, input: string, key: Key, max: number): string | null {
  if (key.backspace || key.delete) return name.slice(0, -1);
  if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return null;
  return input.length > 0 && !/[\x00-\x1f\x7f]/.test(input) ? (name + input).slice(0, max) : null;
}
