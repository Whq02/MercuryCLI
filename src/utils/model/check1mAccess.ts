import { is1mContextDisabled } from './capabilities.js'

function familyHas1mAccess(): boolean {
  return !is1mContextDisabled()
}

export function checkOpus1mAccess(): boolean {
  return familyHas1mAccess()
}

export function checkSonnet1mAccess(): boolean {
  return familyHas1mAccess()
}
