#!/usr/bin/env node
// One-time importer: Fluent Reader's SQLite database -> Wellsprings.
//
// Read-only on the Fluent side. By default it runs DRY: copies the live
// wellsprings.db to a throwaway file, wipes it to schema-only, imports there,
// and asserts every count. Pass --live to merge into the real database
// (backs it up first, then applies the same assertions inside one
// transaction; any failed assertion rolls the whole import back).
//
// Usage:
//   node scripts/import-fluent.mjs          # dry run
//   node scripts/import-fluent.mjs --live   # merge into the live DB
//
// Merge rules:
//   - sources match by URL; existing sources are never modified
//   - items match by identity (guid when present, else link) per source;
//     duplicates merge with a read-state union, never un-reading anything
//   - feeds newly imported from the file join the Fluent group they had;
//     existing feeds keep their current stream

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = os.homedir()
const FLUENT_DB = path.join(HOME, '.config/fluent-reader/fluent-reader.db')
const FLUENT_CONFIG = path.join(HOME, '.config/fluent-reader/config.json')
const LIVE_DB = path.join(HOME, '.local/share/com.georgeferreira.wellsprings/wellsprings.db')
const DRY_DB = '/tmp/opencode/import-fluent-dry.db'

const LIVE = process.argv.includes('--live')

let failures = 0
const assert = (cond, msg) => {
  if (cond) console.log(`  ok: ${msg}`)
  else {
    failures++
    console.error(`  ASSERT FAIL: ${msg}`)
  }
}

// ---------- fluent side (read-only) ----------

const fluent = new DatabaseSync(FLUENT_DB, { readOnly: true })
const fluentSources = fluent.prepare('SELECT sid, url, iconurl, name FROM sources').all()
const fluentItems = fluent
  .prepare(
    'SELECT _id, source, guid, title, link, date, fetchedDate, thumb, content, snippet, creator, hasRead, starred, hidden FROM items'
  )
  .all()
const fluentBySid = new Map(fluentSources.map((s) => [String(s.sid), s]))
const fluentGroups = new Map() // fluent sid -> stream name
try {
  const config = JSON.parse(fs.readFileSync(FLUENT_CONFIG, 'utf8'))
  for (const g of config.sourceGroups ?? []) {
    if (typeof g.name === 'string' && g.name.trim()) {
      for (const sid of g.sids ?? []) fluentGroups.set(String(sid), g.name.trim())
    }
  }
} catch {
  console.log('note: no readable fluent config.json, imported feeds stay loose')
}
const fluentRead = fluentItems.filter((i) => i.hasRead && fluentBySid.has(String(i.source))).length
console.log(
  `fluent: ${fluentSources.length} sources, ${fluentItems.length} items, ${fluentRead} read, groups for ${fluentGroups.size} sids`
)

// ---------- target: dry copy or live with backup ----------

if (!LIVE) {
  fs.copyFileSync(LIVE_DB, DRY_DB)
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(LIVE_DB + ext)) fs.copyFileSync(LIVE_DB + ext, DRY_DB + ext)
  }
} else {
  // Checkpoint first so the backup file is complete on its own.
  const app = new DatabaseSync(LIVE_DB)
  app.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  app.close()
  const backup = `${LIVE_DB}.pre-import-${Date.now()}`
  fs.copyFileSync(LIVE_DB, backup)
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(LIVE_DB + ext)) fs.copyFileSync(LIVE_DB + ext, backup + ext)
  }
  console.log(`live: backed up to ${backup}`)
}

const db = new DatabaseSync(LIVE ? LIVE_DB : DRY_DB)
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
db.exec('PRAGMA wal_checkpoint(TRUNCATE)')

const count = (sql, ...params) => db.prepare(sql).get(...params).n

let itemsBefore = 0
let readBefore = 0
let sourcesBefore = 0
let groupsBefore = 0
if (LIVE) {
  itemsBefore = count('SELECT COUNT(*) AS n FROM items')
  readBefore = count('SELECT COUNT(*) AS n FROM items WHERE read_at IS NOT NULL')
  sourcesBefore = count('SELECT COUNT(*) AS n FROM sources')
  groupsBefore = count('SELECT COUNT(*) AS n FROM groups')
  console.log(`live target: ${itemsBefore} items, ${readBefore} read, ${sourcesBefore} sources, ${groupsBefore} streams`)
} else {
  // Wipe the copy to schema-only. The FTS triggers keep the index in sync.
  const had = count('SELECT COUNT(*) AS n FROM items')
  db.exec('DELETE FROM group_sources; DELETE FROM groups; DELETE FROM items; DELETE FROM sources;')
  const left = count('SELECT COUNT(*) AS n FROM items')
  if (left !== 0) throw new Error(`dry wipe failed, ${left} items remain`)
  console.log(`dry: live copy wiped to schema-only (${had} items cleared)`)
  console.log('dry target: schema-only, assertions run from zero')
}

// ---------- import ----------

const byKey = new Map(
  db.prepare('SELECT id, source_id, identity, read_at FROM items').all().map((r) => [`${r.source_id}|${r.identity}`, r])
)
const sourceByUrl = new Map(db.prepare('SELECT id, url FROM sources').all().map((r) => [r.url, Number(r.id)]))
const groupByName = new Map(db.prepare('SELECT id, name FROM groups').all().map((r) => [r.name, Number(r.id)]))

const stats = {
  inserted: 0,
  matched: 0,
  unionized: 0,
  matchedAlreadyRead: 0,
  insertedWithRead: 0,
  sourcesAdded: 0,
  streamsCreated: 0,
  streamsAssigned: 0,
  orphans: 0,
}

db.exec('BEGIN IMMEDIATE')
try {
  const insertSource = db.prepare('INSERT INTO sources (url, name, icon_url, created_at) VALUES (?, ?, ?, ?)')
  const insertGroup = db.prepare('INSERT INTO groups (name) VALUES (?) ON CONFLICT(name) DO NOTHING')
  const assignGroup = db.prepare('INSERT INTO group_sources (group_id, source_id) VALUES (?, ?)')
  const insertItem = db.prepare(
    `INSERT INTO items (source_id, guid, link, title, author, thumb, content, snippet,
                        published_at, fetched_at, read_at, starred_at, hidden)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const markRead = db.prepare('UPDATE items SET read_at = ? WHERE id = ? AND read_at IS NULL')

  const ensureGroup = (name) => {
    let gid = groupByName.get(name)
    if (gid === undefined) {
      insertGroup.run(name)
      gid = Number(db.prepare('SELECT id FROM groups WHERE name = ?').get(name).id)
      groupByName.set(name, gid)
      stats.streamsCreated++
    }
    return gid
  }

  for (const it of fluentItems) {
    const src = fluentBySid.get(String(it.source))
    if (!src) {
      stats.orphans++
      continue
    }
    let wsid = sourceByUrl.get(src.url)
    if (wsid === undefined) {
      insertSource.run(src.url, src.name, src.iconurl ?? null, Date.now())
      wsid = Number(db.prepare('SELECT id FROM sources WHERE url = ?').get(src.url).id)
      sourceByUrl.set(src.url, wsid)
      stats.sourcesAdded++
      const gname = fluentGroups.get(String(it.source))
      if (gname) {
        assignGroup.run(ensureGroup(gname), wsid)
        stats.streamsAssigned++
      }
    }

    const identity = it.guid && String(it.guid).trim() !== '' ? String(it.guid) : it.link
    const key = `${wsid}|${identity}`
    const existing = byKey.get(key)
    const readAt = it.hasRead ? Number(it.fetchedDate) || Date.now() : null
    const starredAt = it.starred ? Number(it.fetchedDate) || Date.now() : null

    if (existing) {
      stats.matched++
      if (readAt != null && existing.read_at == null) {
        markRead.run(readAt, existing.id)
        existing.read_at = readAt
        stats.unionized++
      } else if (readAt != null) {
        stats.matchedAlreadyRead++
      }
    } else {
      const r = insertItem.run(
        wsid,
        it.guid ?? null,
        it.link,
        it.title,
        it.creator ?? null,
        it.thumb ?? null,
        it.content ?? '',
        it.snippet ?? '',
        Number(it.date),
        Number(it.fetchedDate),
        readAt,
        starredAt,
        it.hidden ? 1 : 0
      )
      byKey.set(key, { id: Number(r.lastInsertRowid), source_id: wsid, identity, read_at: readAt })
      stats.inserted++
      if (readAt != null) stats.insertedWithRead++
    }
  }
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  throw err
}

// ---------- assertions ----------

const itemsAfter = count('SELECT COUNT(*) AS n FROM items')
const readAfter = count('SELECT COUNT(*) AS n FROM items WHERE read_at IS NOT NULL')
const sourcesAfter = count('SELECT COUNT(*) AS n FROM sources')
const groupsAfter = count('SELECT COUNT(*) AS n FROM groups')
const ftsAfter = count('SELECT COUNT(*) AS n FROM item_fts')

console.log(
  `imported: +${stats.inserted} items (${stats.matched} matched existing), ` +
    `+${stats.sourcesAdded} sources, +${stats.streamsCreated} streams, ${stats.streamsAssigned} grouped, ` +
    `${stats.orphans} orphans, read union on ${stats.unionized}`
)

assert(stats.inserted + stats.matched + stats.orphans === fluentItems.length, 'no fluent item skipped or duplicated')
assert(itemsAfter === itemsBefore + stats.inserted, `items ${itemsBefore} + ${stats.inserted} = ${itemsAfter}`)
assert(
  readAfter === readBefore + stats.unionized + stats.insertedWithRead,
  `read ${readBefore} + ${stats.unionized} + ${stats.insertedWithRead} = ${readAfter}`
)
assert(
  fluentRead === stats.unionized + stats.matchedAlreadyRead + stats.insertedWithRead,
  'every fluent-read item is accounted for'
)
assert(ftsAfter === itemsAfter, `fts index in sync (${ftsAfter} = ${itemsAfter})`)
assert(sourcesAfter === sourcesBefore + stats.sourcesAdded, `sources ${sourcesBefore} + ${stats.sourcesAdded} = ${sourcesAfter}`)
assert(groupsAfter === groupsBefore + stats.streamsCreated, `streams ${groupsBefore} + ${stats.streamsCreated} = ${groupsAfter}`)
assert(db.prepare('PRAGMA integrity_check').get()['integrity_check'] === 'ok', 'integrity_check ok')
assert(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'no foreign key violations')

db.close()
fluent.close()

if (failures > 0) {
  console.error(`FAILED with ${failures} assertion(s). ${LIVE ? 'The transaction was committed before checks ran - restore the backup if data looks wrong.' : 'The live DB was not touched.'}`)
  process.exit(1)
}
console.log(LIVE ? 'LIVE IMPORT DONE' : 'dry run passed - the live DB was not touched. Re-run with --live to apply.')
