import { isEnvTruthy } from '../envUtils.js'


export type SetupMessage = {
  message: string
  userActionRequired: boolean
  type: 'path' | 'alias' | 'info' | 'error'
}

export async function checkInstall(_force?: boolean): Promise<SetupMessage[]> {
  if (isEnvTruthy(process.env.DISABLE_INSTALLATION_CHECKS)) return []
  return []
}
