
import { useTheme } from '../themedRenderer.js'
import {
  type MercuryThemeTokens,
  resolveMercuryTokens,
} from '../theme/mercuryTokens.js'
import { useSessionAccent } from './sessionAccent.js'

export function useMercuryTokens(): MercuryThemeTokens {
  const [currentTheme] = useTheme()
  const accent = useSessionAccent().accent
  return resolveMercuryTokens(currentTheme, accent)
}
