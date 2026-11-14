import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const APP_DIR = path.join(homedir(), '.config', 'fluent-reader')
export const DB_PATH = path.join(APP_DIR, 'fluent-reader.db')
export const CONFIG_PATH = path.join(APP_DIR, 'config.json')

export function openDb() {
  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

export function readGroups() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    return (cfg.sourceGroups ?? [])
      .filter((g) => g.isMultiple)
      .map((g) => ({ gid: g.gid, name: g.name, sids: g.sids }))
  } catch {
    return []
  }
}

export function readFetchInterval(defaultMinutes = 30) {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    const n = Number(cfg.fetchInterval)
    return n > 0 ? n : defaultMinutes
  } catch {
    return defaultMinutes
  }
}

export function listFeeds(db) {
  const rows = db
    .prepare(
      `SELECT s.sid, s.name, s.iconurl AS icon,
              SUM(CASE WHEN i.hasRead = 0 AND i.hidden = 0 THEN 1 ELSE 0 END) AS unread
       FROM sources s LEFT JOIN items i ON i.source = s.sid
       WHERE s.hidden = 0
       GROUP BY s.sid
       ORDER BY s.name COLLATE NOCASE`
    )
    .all()
  const sources = rows.map((r) => ({ sid: r.sid, name: r.name, icon: r.icon || null, unread: r.unread || 0 }))
  const bySid = new Map(sources.map((s) => [s.sid, s]))
  const groups = readGroups()
    .map((g) => {
      const members = g.sids.map((sid) => bySid.get(sid)).filter(Boolean)
      return {
        gid: g.gid,
        name: g.name,
        sids: members.map((m) => m.sid),
        unread: members.reduce((n, m) => n + m.unread, 0),
      }
    })
    .filter((g) => g.sids.length > 0)
  const grouped = new Set(groups.flatMap((g) => g.sids))
  const loose = sources.filter((s) => !grouped.has(s.sid))
  return { sources, groups, loose, totalUnread: sources.reduce((n, s) => n + s.unread, 0) }
}

export function listItems(db, { scope, unread, limit, offset }) {
  const where = ['i.hidden = 0']
  const args = []
  if (unread) where.push('i.hasRead = 0')
  if (scope.type === 'source') {
    where.push('i.source = ?')
    args.push(scope.id)
  }
  if (scope.type === 'group') {
    const g = readGroups().find((g) => g.gid === scope.id)
    const sids = g ? g.sids : []
    where.push(`i.source IN (${sids.map(() => '?').join(',') || 'NULL'})`)
    args.push(...sids)
  }
  const rows = db
    .prepare(
      `SELECT i._id, i.source, i.title, i.link, i.date, i.thumb, i.snippet, i.hasRead, i.starred,
              s.name AS sourceName, s.iconurl AS sourceIcon
       FROM items i JOIN sources s ON s.sid = i.source
       WHERE ${where.join(' AND ')}
       ORDER BY i.date DESC, i._id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...args, limit + 1, offset)
  const hasMore = rows.length > limit
  return { items: rows.slice(0, limit), hasMore }
}

export function getItem(db, id) {
  return (
    db
      .prepare(
        `SELECT i.*, s.name AS sourceName, s.iconurl AS sourceIcon
         FROM items i JOIN sources s ON s.sid = i.source
         WHERE i._id = ?`
      )
      .get(id) ?? null
  )
}

export function patchItem(db, id, patch) {
  const sets = []
  const args = []
  if (typeof patch.hasRead === 'boolean') {
    sets.push('hasRead = ?')
    args.push(patch.hasRead ? 1 : 0)
  }
  if (typeof patch.starred === 'boolean') {
    sets.push('starred = ?')
    args.push(patch.starred ? 1 : 0)
  }
  if (!sets.length) return null
  const info = db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE _id = ?`).run(...args, id)
  if (info.changes === 0) return null
  return getItem(db, id)
}
