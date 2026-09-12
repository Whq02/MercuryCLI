import { makeGreeting } from '../core/index.js'

export function Banner(props: { name: string }) {
  return <h1 title={makeGreeting(props.name).message}>{props.name}</h1>
}

export function Page() {
  return <Banner name="crew" />
}
