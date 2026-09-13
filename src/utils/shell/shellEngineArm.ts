export type ShellEngineArm = 'pin' | 'setting' | 'no-bash'

export type ShellEngineRequest =
  | { requested: 'brush'; arm: ShellEngineArm }
  | { requested: 'system'; arm: 'pin' | 'setting' | 'default' }

export function shellEngineRequest(pin: string | undefined, setting: 'system' | 'brush' | undefined, bashAbsent: boolean): ShellEngineRequest {
  if (pin === 'brush') return { requested: 'brush', arm: 'pin' }
  if (pin === 'system') return { requested: 'system', arm: 'pin' }
  if (setting === 'brush') return { requested: 'brush', arm: 'setting' }
  if (setting === 'system') return { requested: 'system', arm: 'setting' }
  if (bashAbsent) return { requested: 'brush', arm: 'no-bash' }
  return { requested: 'system', arm: 'default' }
}

export function shellEngineArmWords(arm: ShellEngineArm | 'default'): string {
  if (arm === 'pin') return 'the MERCURY_SHELL_ENGINE pin'
  if (arm === 'setting') return 'the Shell engine setting'
  if (arm === 'no-bash') return 'no bash.exe was found on this machine'
  return 'the default'
}
