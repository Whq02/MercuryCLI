

export type SetupMessage = {
  message: string
  userActionRequired: boolean
  type: 'path' | 'alias' | 'info' | 'error'
}

export async function checkInstall(_force?: boolean): Promise<SetupMessage[]> {
  return []
}
