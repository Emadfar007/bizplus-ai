import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class ObserverStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS checks (id TEXT PRIMARY KEY, key TEXT NOT NULL, completed_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, key TEXT NOT NULL, status TEXT NOT NULL, opened_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS check_recency ON checks(key,completed_at DESC);`);
  }
  save(check) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO checks VALUES (?,?,?,?)').run(check.id, check.key, check.completedAt, JSON.stringify(check));
      const rows = this.db.prepare("SELECT payload FROM incidents WHERE key=? AND status='open' ORDER BY opened_at DESC").all(check.key);
      // A browser runner failure must never resolve an open website incident.
      if (check.status === 'passed') {
        for (const row of rows) {
          const incident = JSON.parse(row.payload);
          incident.status = 'resolved'; incident.resolvedAt = check.completedAt; incident.lastSeenAt = check.completedAt;
          this.db.prepare('UPDATE incidents SET status=?,payload=? WHERE id=?').run('resolved', JSON.stringify(incident), incident.id);
        }
      } else {
        const incident = rows.length ? JSON.parse(rows[0].payload) : {
          id: randomUUID(), key: check.key, label: check.label,
          status: 'open', openedAt: check.completedAt, resolvedAt: null,
        };
        incident.lastSeenAt = check.completedAt;
        incident.diagnosis = check.diagnosis;
        incident.failureKind = check.status;
        if (rows.length) this.db.prepare('UPDATE incidents SET payload=? WHERE id=?').run(JSON.stringify(incident), incident.id);
        else this.db.prepare('INSERT INTO incidents VALUES (?,?,?,?,?)').run(incident.id, incident.key, incident.status, incident.openedAt, JSON.stringify(incident));
      }
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
      this.db.prepare('DELETE FROM checks WHERE completed_at < ?').run(cutoff);
      this.db.exec('DELETE FROM checks WHERE id NOT IN (SELECT id FROM checks ORDER BY completed_at DESC LIMIT 1000)');
      this.db.prepare("DELETE FROM incidents WHERE status='resolved' AND opened_at < ?").run(cutoff);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  latest() {
    return this.db.prepare('SELECT payload FROM checks WHERE rowid IN (SELECT MAX(rowid) FROM checks GROUP BY key) ORDER BY key').all().map(row => JSON.parse(row.payload));
  }
  incidents() {
    return this.db.prepare('SELECT payload FROM incidents ORDER BY opened_at DESC LIMIT 100').all().map(row => JSON.parse(row.payload));
  }
  close() { this.db.close(); }
}
