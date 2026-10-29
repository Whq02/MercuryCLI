import { CHANNEL_TAG } from '../../constants/xml.js'
import { escapeXmlAttr } from '../../utils/xml.js'

const SAFE_META_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

export function wrapChannelMessage(
  serverName: string,
  content: string,
  meta?: Record<string, unknown>,
): string {
  const attributes = [`source="${escapeXmlAttr(serverName)}"`]
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (!SAFE_META_KEY.test(key)) continue

    attributes.push(`${key}="${escapeXmlAttr(String(value))}"`)
  }
  return `<${CHANNEL_TAG} ${attributes.join(' ')}>\n${content}\n</${CHANNEL_TAG}>`
}
