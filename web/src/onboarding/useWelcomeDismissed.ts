import { useState, useCallback } from 'react'
import { readWelcomeDismissed, writeWelcomeDismissed } from './onboardingStore'

export function useWelcomeDismissed(): [boolean, (v: boolean) => void] {
  const [dismissed, setDismissedState] = useState<boolean>(readWelcomeDismissed)
  const setDismissed = useCallback((v: boolean) => {
    writeWelcomeDismissed(v)
    setDismissedState(v)
  }, [])
  return [dismissed, setDismissed]
}
