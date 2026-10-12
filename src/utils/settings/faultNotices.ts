import { getSettingsWithAllErrors } from './allErrors.js'
import { settingsFaultLine, type ValidationError } from './validation.js'

const told = new Set<string>()

function faultKey(fault: ValidationError): string {
  return `${fault.file ?? ''}|${fault.path}|${fault.message}|${fault.severity ?? ''}`
}

export function currentSettingsFaults(): ValidationError[] {
  return getSettingsWithAllErrors().errors.filter(fault => fault.mcpErrorMetadata === undefined)
}

export function untoldSettingsFaults(): ValidationError[] {
  const faults = currentSettingsFaults()
  const present = new Set(faults.map(faultKey))
  for (const key of told) if (!present.has(key)) told.delete(key)
  const fresh = faults.filter(fault => !told.has(faultKey(fault)))
  for (const fault of fresh) told.add(faultKey(fault))
  return fresh
}

export function untoldSettingsFaultLines(): string[] {
  return untoldSettingsFaults().map(settingsFaultLine)
}

export function resetToldSettingsFaults(): void {
  told.clear()
}
