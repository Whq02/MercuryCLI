/** The needs-you count in words — ONE grammar for every count chip (the
 *  chat strip's ⚑ badge, the board's status strip): "1 needs you",
 *  "2 need you", "0 need you". A count is a subject; the verb agrees. */
export function needsYouCount(n: number): string {
  return `${n} need${n === 1 ? 's' : ''} you`
}
