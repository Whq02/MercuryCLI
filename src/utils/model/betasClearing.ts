let whatClearsTheBetas: (() => void) | undefined

export function tellWhatClearsTheBetas(clear: () => void): void {
  whatClearsTheBetas = clear
}

export function clearBetasWhereKept(): void {
  if (whatClearsTheBetas !== undefined) whatClearsTheBetas()
}
