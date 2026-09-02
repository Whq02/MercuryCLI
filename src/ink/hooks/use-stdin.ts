import { useContext } from 'react'
import StdinContext from '../components/StdinContext.js'

/**
 * React hook handing components the stdin stream context.
 */
const useStdin = () => useContext(StdinContext)
export default useStdin
