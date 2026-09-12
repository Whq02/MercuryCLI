import { makeGreeting, loudness } from '../core/greeting.js'

export function report(name) {
  return makeGreeting(name).message + ' ' + String(loudness)
}
