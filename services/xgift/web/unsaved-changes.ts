import { useEffect, useRef } from 'react'

const pending = new Set<symbol>()

/** Track presence only: no form values or credentials are stored. */
export function useUnsavedChanges(active: boolean) {
  const key = useRef(Symbol('unsaved-work'))
  useEffect(() => {
    const id = key.current
    if (active) pending.add(id)
    else pending.delete(id)
    return () => { pending.delete(id) }
  }, [active])
}

export function hasUnsavedChanges() { return pending.size > 0 }
