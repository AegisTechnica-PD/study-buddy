import { createClient } from '@supabase/supabase-js'

const rawUrl = String(import.meta.env.VITE_SUPABASE_URL || '').trim()
// Tolerate a pasted API address such as https://xxxx.supabase.co/rest/v1/
const url = rawUrl.replace(/\/(rest|auth|storage)\/v1.*$/i, '').replace(/\/+$/, '')
const key = String(import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim()

function keyRole(k) {
  try {
    const part = k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(part)).role
  } catch {
    return null
  }
}

// Shown on screen instead of a blank page or a misleading "wrong password".
export const configProblem = !url || !key
  ? 'This site is missing its Supabase settings (VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY). Add them in Vercel, then redeploy.'
  : keyRole(key) === 'service_role'
    ? 'The service_role key was pasted into VITE_SUPABASE_ANON_KEY. That key must never reach a browser. Put the anon key there, then in Supabase generate a new JWT secret to retire the exposed key.'
    : null

export const supabase = createClient(url || 'https://missing.invalid', key || 'missing')

// Kids log in with a username. Supabase Auth wants an email, so we map it.
// Anything that already contains an @ (such as a parent's real email) is used as is.
export const toEmail = (u) => {
  const v = String(u).trim().toLowerCase()
  return v.includes('@') ? v : `${v}@studyapp.internal`
}
