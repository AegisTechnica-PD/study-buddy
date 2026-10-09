const DAY = 864e5

export const dayKey = (d) => {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

// Monday of the week containing d, local time
export function weekStart(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  const dow = (x.getDay() + 6) % 7
  x.setDate(x.getDate() - dow)
  return x
}

export const fmtMin = (sec) => {
  const m = Math.round((sec || 0) / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// Consecutive days (ending today or yesterday) with at least 1 minute of study
export function streak(sessions) {
  const days = new Set(sessions.filter((s) => s.active_seconds >= 60).map((s) => dayKey(s.started_at)))
  let n = 0
  let d = new Date()
  if (!days.has(dayKey(d))) d = new Date(Date.now() - DAY)
  while (days.has(dayKey(d))) {
    n++
    d = new Date(d.getTime() - DAY)
  }
  return n
}
