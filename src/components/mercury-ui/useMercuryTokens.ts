
import { useTheme } from '../../ink.js'
import {
  type MercuryThemeTokens,
  resolveMercuryTokens,
} from '../../utils/mercuryTokens.js'
import { useSessionAccent } from './sessionAccent.js'

export function useMercuryTokens(): MercuryThemeTokens {
  const [currentTheme] = useTheme()
  const accent = useSessionAccent().accent
  return resolveMercuryTokens(currentTheme, accent)
}
