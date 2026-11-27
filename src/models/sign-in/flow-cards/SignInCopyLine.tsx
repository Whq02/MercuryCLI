import * as React from 'react'
import { useContext, useRef, useState } from 'react'
import { useClaim, useMount } from '../../../screen/effects/effects.js'
import { ScreenInstanceContext } from '../../../screen/renderer/elements/ScreenInstanceContext.js'
import { Text } from '../../../screen/themedRenderer.js'
import { useMercuryTokens } from '../../../screen/widgets/useMercuryTokens.js'
import { startTimeout } from '../../../platform/async/timers.js'
import { copyForSignIn, signInCopySaid, SIGN_IN_COPY_ACK_MS, type SignInCopied, type SignInCopySaid } from '../signInCopy.js'

export function useMouseHandedBack(active: boolean): void {
  const instance = useContext(ScreenInstanceContext)
  useClaim(() => {
    if (!active || instance === undefined || !instance.isMouseTrackingEnabled()) return
    instance.setMouseTrackingEnabled(false)
    return () => instance.setMouseTrackingEnabled(true)
  }, [active, instance])
}

export function useSignInCopy(): SignInCopySaid & { copy: (text: string, what?: SignInCopied) => void } {
  const [said, setSaid] = useState<SignInCopySaid>({ copied: false, copyNote: null })
  const mounted = useRef(true)
  useMount(() => () => {
    mounted.current = false
  })
  const copy = (text: string, what: SignInCopied = 'URL'): void => {
    void copyForSignIn(text).then(answer => {
      if (!mounted.current) return
      setSaid(signInCopySaid(answer, what))
      if (answer !== 'copied') return
      startTimeout(() => {
        if (mounted.current) setSaid(current => ({ ...current, copied: false }))
      }, SIGN_IN_COPY_ACK_MS)
    })
  }
  return { ...said, copy }
}

export function SignInCopyLine({ said, address, quiet }: { said: SignInCopySaid; address?: string | undefined; quiet?: boolean }): React.ReactNode {
  const tokens = useMercuryTokens()
  useMouseHandedBack(said.copyNote !== null)
  if (said.copied) return quiet === true ? null : <Text color={tokens.success}>Copied to clipboard</Text>
  if (said.copyNote === null) return null
  return (
    <>
      {address !== undefined ? <Text color={tokens.info} wrap="wrap">{address}</Text> : null}
      <Text color={tokens.warning} wrap="wrap">{said.copyNote.charAt(0).toUpperCase() + said.copyNote.slice(1)}</Text>
    </>
  )
}
