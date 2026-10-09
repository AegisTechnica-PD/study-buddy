import { Routes, Route, Navigate, Link } from 'react-router-dom'
import { useAuth } from './auth.jsx'
import Login from './pages/Login.jsx'
import Home from './pages/Home.jsx'
import Deck from './pages/Deck.jsx'
import Study from './pages/Study.jsx'
import Admin from './pages/Admin.jsx'
import MathFacts from './pages/MathFacts.jsx'
import { configProblem } from './lib/supabase.js'

function Shell({ children }) {
  const { profile, signOut } = useAuth()
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">Study Buddy</Link>
        <nav>
          <Link to="/math">Math facts</Link>
          {profile.role === 'admin' && <Link to="/admin">Admin</Link>}
          <span className="who">{profile.display_name}</span>
          <button className="link" onClick={signOut}>Sign out</button>
        </nav>
      </header>
      <main className="page">{children}</main>
    </div>
  )
}

export default function App() {
  const { session, profile, loading, signOut } = useAuth()
  if (configProblem) return <div className="center"><p className="err">{configProblem}</p></div>
  if (loading) return <div className="center">Loading...</div>
  if (!session) return <Login />
  if (!profile) {
    return (
      <div className="center">
        <p>You are signed in, but this login has no profile yet. Parents: run the profile insert from the README (setup step 5) and make sure the user's email is exactly paul@studyapp.internal. Kids: ask a parent to create your account in Admin.</p>
        <button onClick={signOut}>Sign out</button>
      </div>
    )
  }
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/deck/:id" element={<Deck />} />
        <Route path="/study/:id" element={<Study />} />
        <Route path="/math" element={<MathFacts />} />
        <Route path="/admin" element={profile.role === 'admin' ? <Admin /> : <Navigate to="/" />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Shell>
  )
}
