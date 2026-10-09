import { admin, requireUser } from './_lib/auth.js'

const USERNAME_RE = /^[a-z0-9_.-]{3,20}$/
const toEmail = (u) => `${u}@studyapp.internal`

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const me = await requireUser(req)
  if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Admins only' })

  const { action, username, displayName, grade, password, userId } = req.body || {}

  try {
    if (action === 'create') {
      const u = String(username || '').trim().toLowerCase()
      if (!USERNAME_RE.test(u)) return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, . _ -' })
      if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })
      if (!displayName) return res.status(400).json({ error: 'Display name required' })

      const { data, error } = await admin.auth.admin.createUser({
        email: toEmail(u),
        password,
        email_confirm: true
      })
      if (error) return res.status(400).json({ error: error.message })

      const { error: pErr } = await admin.from('profiles').insert({
        id: data.user.id,
        username: u,
        display_name: displayName,
        grade: grade || null,
        role: 'student'
      })
      if (pErr) {
        await admin.auth.admin.deleteUser(data.user.id)
        return res.status(400).json({ error: pErr.message })
      }
      return res.json({ ok: true, id: data.user.id })
    }

    if (action === 'reset') {
      if (!userId || !password || String(password).length < 8) {
        return res.status(400).json({ error: 'userId and a password of 8+ characters required' })
      }
      const { data: target } = await admin.from('profiles').select('role').eq('id', userId).single()
      if (!target) return res.status(404).json({ error: 'User not found' })
      const { error } = await admin.auth.admin.updateUserById(userId, { password })
      if (error) return res.status(400).json({ error: error.message })
      return res.json({ ok: true })
    }

    return res.status(400).json({ error: 'Unknown action' })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
