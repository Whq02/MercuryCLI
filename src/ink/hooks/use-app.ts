import { useContext } from 'react'
import AppContext from '../components/AppContext.js'

const useApp = () => useContext(AppContext)
export default useApp
