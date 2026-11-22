import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type InputHandler = (...args: Unbuilt[]) => Unbuilt

type Options = Unbuilt

export default function useInput(handler: InputHandler, options?: Options): void {
  return notBuilt('src/ink/hooks/use-input.ts:13')
}
