import type { EnterpriseGateway } from '../gatewayTrust.js'
import type { OAuthTokens } from '../../services/oauth/types.js'

export interface SecureStorageData {
  claudeAiOauth?: OAuthTokens
  enterpriseGateway?: EnterpriseGateway
  gatewayTrust?: Record<string, string>
  mcpOAuth?: Record<string, unknown>
  mcpOAuthClientConfig?: Record<string, unknown>
  extensionSecrets?: Record<string, Record<string, string>>
  trustedDeviceToken?: string
}

export interface SecureStorage {
  name: string
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean; warning?: string; code?: string }
  delete(): boolean
}
