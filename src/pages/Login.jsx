import { useState } from 'react'
import { useAuth } from '../auth.jsx'

export default function Login() {
  const { signIn } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    const { error } = await signIn(username, password)
    if (error) {
      const m = String(error.message || '')
      if (/invalid login credentials/i.test(m)) setErr('Wrong username or password.')
      else if (/not confirmed/i.test(m)) setErr('This account is not confirmed. In Supabase, turn off "Confirm email" and confirm the user.')
      else setErr(`Sign in failed: ${m || 'could not reach the server'}`)
    }
    setBusy(false)
  }

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <h1>Study Buddy</h1>
        <label>Username (parents can use their email)
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" autoComplete="username" required />
        </label>
        <label>Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {err && <p className="err">{err}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
      </form>
    </div>
  )
}
