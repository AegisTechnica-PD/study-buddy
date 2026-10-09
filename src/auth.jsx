import { createContext, useContext, useEffect, useState } from 'react'
import { supabase, toEmail } from './lib/supabase.js'

const Ctx = createContext(null)
export const useAuth = () => useContext(Ctx)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (!data.session) setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s)
      if (!s) {
        setProfile(null)
        setLoading(false)
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const uid = session?.user?.id
  useEffect(() => {
    if (!uid) return
    supabase.from('profiles').select('*').eq('id', uid).single().then(({ data }) => {
      setProfile(data)
      setLoading(false)
    })
  }, [uid])

  const signIn = (username, password) =>
    supabase.auth.signInWithPassword({ email: toEmail(username), password })
  const signOut = () => supabase.auth.signOut()

  return (
    <Ctx.Provider value={{ session, profile, loading, signIn, signOut }}>{children}</Ctx.Provider>
  )
}
