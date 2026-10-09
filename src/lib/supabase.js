import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

// Kids log in with a username. Supabase Auth wants an email, so we map it.
export const toEmail = (u) => `${String(u).trim().toLowerCase()}@studyapp.internal`
