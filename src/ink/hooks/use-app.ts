import { useContext } from 'react'
import AppContext from '../components/AppContext.js'

/**
 * React hook exposing app-level control — notably a manual exit (unmount).
 */
const useApp = () => useContext(AppContext)
export default useApp
