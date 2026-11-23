import { useContext } from 'react'
import AppContext from '../elements/AppContext.js'

const useApp = () => useContext(AppContext)
export default useApp
