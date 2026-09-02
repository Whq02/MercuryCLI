
import type { EnterpriseGateway } from '../gatewayTrust.js'
import type { OAuthTokens } from '../../services/oauth/types.js'

export interface SecureStorageData {
  claudeAiOauth?: OAuthTokens
  enterpriseGateway?: EnterpriseGateway
  gatewayTrust?: Record<string, string>
  mcpOAuth?: Record<string, any>
  mcpOAuthClientConfig?: Record<string, any>
  mcpXaaIdp?: Record<string, any>
  mcpXaaIdpConfig?: Record<string, any>
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
