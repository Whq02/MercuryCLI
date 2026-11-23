import { useContext } from 'react'
import StdinContext from '../elements/StdinContext.js'

const useStdin = () => useContext(StdinContext)
export default useStdin
