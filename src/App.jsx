import { Routes, Route, Navigate, Link } from 'react-router-dom'
import { useAuth } from './auth.jsx'
import Login from './pages/Login.jsx'
import Home from './pages/Home.jsx'
import Deck from './pages/Deck.jsx'
import Study from './pages/Study.jsx'
import Admin from './pages/Admin.jsx'
import MathFacts from './pages/MathFacts.jsx'

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
  if (loading) return <div className="center">Loading...</div>
  if (!session) return <Login />
  if (!profile) {
    return (
      <div className="center">
        <p>This login has no profile yet. Ask Dad to finish setting up your account.</p>
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
