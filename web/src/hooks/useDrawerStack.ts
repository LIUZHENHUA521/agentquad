import { useEffect, useRef } from 'react'
import { useDrawerStackStore } from '../store/drawerStackStore'

/**
 * Wire a drawer into the global drawer stack.
 * - Registers the drawer's close handler under `key`
 * - Maintains open-order stack as `open` toggles
 *
 * Each instance must use a unique `key`.
 */
export function useDrawerStack(key: string, open: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose)
  // Keep ref pointing to latest onClose without resubscribing
  useEffect(() => {
    onCloseRef.current = onClose
  })

  // Register / unregister on mount/key-change
  useEffect(() => {
    const { register, unregister } = useDrawerStackStore.getState()
    register(key, () => onCloseRef.current())
    return () => unregister(key)
  }, [key])

  // Track open/close in stack
  useEffect(() => {
    const { open: pushOpen, close: popClose } = useDrawerStackStore.getState()
    if (open) pushOpen(key)
    else popClose(key)
  }, [open, key])
}
