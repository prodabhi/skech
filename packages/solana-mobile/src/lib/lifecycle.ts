import { useSyncExternalStore } from 'react'
import { AppState } from 'react-native'

const active = () => AppState.currentState === 'active' || AppState.currentState === null
const subscribe = (listener: () => void) => {
  const subscription = AppState.addEventListener('change', listener)
  return () => subscription.remove()
}

/** Stop live work while the app cannot be used. */
export function useAppActive() {
  return useSyncExternalStore(subscribe, active, () => true)
}
