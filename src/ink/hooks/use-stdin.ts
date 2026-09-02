import { useContext } from 'react'
import StdinContext from '../components/StdinContext.js'

const useStdin = () => useContext(StdinContext)
export default useStdin
