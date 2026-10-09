import { useEffect, useRef } from 'react'

// Counts study seconds only while the tab is visible and the student interacted in the last 60 seconds.
// Returns a ref holding the seconds. onPersist(seconds) is called every 15 seconds.
export function useActiveTimer(running, onPersist) {
  const sec = useRef(0)
  const lastAct = useRef(Date.now())
  const persist = useRef(onPersist)
  persist.current = onPersist

  useEffect(() => {
    if (!running) return
    lastAct.current = Date.now()
    const touch = () => { lastAct.current = Date.now() }
    const evs = ['pointerdown', 'keydown', 'touchstart', 'scroll']
    evs.forEach((e) => window.addEventListener(e, touch, { passive: true }))
    let ticks = 0
    const t = setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - lastAct.current < 60000) sec.current += 1
      ticks += 1
      if (ticks % 15 === 0) persist.current?.(sec.current)
    }, 1000)
    return () => {
      clearInterval(t)
      evs.forEach((e) => window.removeEventListener(e, touch))
    }
  }, [running])

  return sec
}
