export function createSessionRepository(db) {
  const find = db.prepare('SELECT * FROM admin_sessions WHERE token_hash = ?');
  const save = db.prepare(`INSERT INTO admin_sessions (token_hash, csrf_token_hash, role, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET
    csrf_token_hash = excluded.csrf_token_hash, role = excluded.role, created_at = excluded.created_at, expires_at = excluded.expires_at`);
  const remove = db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?');
  const expired = db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?');
  return {
    findSession(tokenHash, now = Date.now()) {
      const row = find.get(tokenHash);
      if (!row) return null;
      if (row.expires_at <= now) { remove.run(tokenHash); return null; }
      return { tokenHash: row.token_hash, csrfTokenHash: row.csrf_token_hash, role: row.role, createdAt: row.created_at, expiresAt: row.expires_at };
    },
    saveSession(session) { save.run(session.tokenHash, session.csrfTokenHash, session.role, session.createdAt, session.expiresAt); },
    deleteSession(tokenHash) { return Boolean(remove.run(tokenHash).changes); },
    prune(now = Date.now()) { return Number(expired.run(now).changes); },
  };
}
