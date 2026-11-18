use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::models::{
    FeedsPayload, GroupSummary, ItemDetail, ItemSummary, ItemsPayload, Scope, SourceSummary,
};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn open_db(path: &Path) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open(path)?;
    // execute_batch (not pragma_update) because journal_mode returns a row.
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         PRAGMA busy_timeout=5000;",
    )?;
    Ok(conn)
}

const SCHEMA_V1: &str = "
BEGIN IMMEDIATE;
CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    url TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    icon_url TEXT,
    site_url TEXT,
    last_fetched INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE TABLE groups (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE group_sources (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, source_id)
);
CREATE TABLE items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    guid TEXT,
    link TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    thumb TEXT,
    content TEXT NOT NULL DEFAULT '',
    snippet TEXT NOT NULL DEFAULT '',
    published_at INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    read_at INTEGER,
    starred_at INTEGER,
    hidden INTEGER NOT NULL DEFAULT 0,
    identity TEXT GENERATED ALWAYS AS (COALESCE(NULLIF(guid, ''), link)) STORED,
    UNIQUE (source_id, identity)
);
CREATE INDEX idx_items_source_date ON items(source_id, published_at DESC);
CREATE INDEX idx_items_date ON items(published_at DESC);
CREATE INDEX idx_items_unread ON items(source_id) WHERE read_at IS NULL;
CREATE VIRTUAL TABLE item_fts USING fts5(
    title, snippet, author, content, content='items', content_rowid='id'
);
CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
    INSERT INTO item_fts(rowid, title, snippet, author, content)
    VALUES (new.id, new.title, new.snippet, new.author, new.content);
END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
    INSERT INTO item_fts(item_fts, rowid, title, snippet, author, content)
    VALUES ('delete', old.id, old.title, old.snippet, old.author, old.content);
END;
CREATE TRIGGER items_au AFTER UPDATE ON items BEGIN
    INSERT INTO item_fts(item_fts, rowid, title, snippet, author, content)
    VALUES ('delete', old.id, old.title, old.snippet, old.author, old.content);
    INSERT INTO item_fts(rowid, title, snippet, author, content)
    VALUES (new.id, new.title, new.snippet, new.author, new.content);
END;
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
COMMIT;
";

pub fn run_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS migrations (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );",
    )?;
    let applied: i64 = conn.query_row(
        "SELECT COUNT(*) FROM migrations WHERE name = '001_init'",
        [],
        |r| r.get(0),
    )?;
    if applied == 0 {
        conn.execute_batch(SCHEMA_V1)?;
        conn.execute(
            "INSERT INTO migrations (name, applied_at) VALUES ('001_init', ?)",
            params![now_ms()],
        )?;
    }
    Ok(())
}

// ---------- reads ----------

fn source_summaries(conn: &Connection) -> Result<(Vec<SourceSummary>, std::collections::HashMap<i64, i64>), rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.name, s.icon_url,
                COUNT(i.id) FILTER (WHERE i.read_at IS NULL AND i.hidden = 0)
         FROM sources s LEFT JOIN items i ON i.source_id = s.id
         GROUP BY s.id
         ORDER BY s.name COLLATE NOCASE",
    )?;
    let mut sources = Vec::new();
    let mut unread_by_sid = std::collections::HashMap::new();
    let rows = stmt.query_map([], |r| {
        let sid: i64 = r.get(0)?;
        let name: String = r.get(1)?;
        let icon: Option<String> = r.get(2)?;
        let unread: i64 = r.get(3)?;
        Ok((sid, name, icon, unread))
    })?;
    for row in rows {
        let (sid, name, icon, unread) = row?;
        unread_by_sid.insert(sid, unread);
        sources.push(SourceSummary { sid, name, icon, unread });
    }
    Ok((sources, unread_by_sid))
}

pub fn list_feeds(conn: &Connection) -> Result<FeedsPayload, rusqlite::Error> {
    let (sources, unread_by_sid) = source_summaries(conn)?;

    let mut groups = Vec::new();
    let mut grouped = std::collections::HashSet::new();
    let mut stmt = conn.prepare("SELECT id, name FROM groups ORDER BY position, name")?;
    let gids: Vec<(i64, String)> =
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    let mut members_stmt = conn.prepare(
        "SELECT source_id FROM group_sources WHERE group_id = ?",
    )?;
    for (gid, name) in gids {
        let sids: Vec<i64> = members_stmt
            .query_map([gid], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        let unread = sids.iter().filter_map(|s| unread_by_sid.get(s)).sum();
        grouped.extend(sids.iter().copied());
        groups.push(GroupSummary { gid, name, sids, unread });
    }

    let loose = sources
        .iter()
        .filter(|s| !grouped.contains(&s.sid))
        .cloned()
        .collect();

    let total_unread = sources.iter().map(|s| s.unread).sum();
    Ok(FeedsPayload { sources, groups, loose, total_unread })
}

const ITEM_COLUMNS: &str =
    "i.id, i.source_id, i.title, i.link, i.published_at, i.thumb, i.snippet,
     CASE WHEN i.read_at IS NULL THEN 0 ELSE 1 END,
     CASE WHEN i.starred_at IS NULL THEN 0 ELSE 1 END,
     s.name, s.icon_url";

fn item_summary_from_row(row: &rusqlite::Row) -> rusqlite::Result<ItemSummary> {
    Ok(ItemSummary {
        id: row.get(0)?,
        source_id: row.get(1)?,
        title: row.get(2)?,
        link: row.get(3)?,
        date: row.get(4)?,
        thumb: row.get(5)?,
        snippet: row.get(6)?,
        has_read: row.get(7)?,
        starred: row.get(8)?,
        source_name: row.get(9)?,
        source_icon: row.get(10)?,
    })
}

pub fn list_items(
    conn: &Connection,
    scope: &Scope,
    unread_only: bool,
    limit: u32,
    offset: u32,
) -> Result<ItemsPayload, rusqlite::Error> {
    let mut where_clauses = vec!["i.hidden = 0".to_string()];
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if unread_only {
        where_clauses.push("i.read_at IS NULL".to_string());
    }
    match scope.kind.as_str() {
        "source" => {
            where_clauses.push("i.source_id = ?".to_string());
            args.push(Box::new(scope.id.unwrap_or(-1)));
        }
        "group" => {
            let sids = group_member_ids(conn, scope.id.unwrap_or(-1))?;
            if sids.is_empty() {
                return Ok(ItemsPayload { items: vec![], has_more: false });
            }
            where_clauses.push(format!(
                "i.source_id IN ({})",
                sids.iter().map(|_| "?".to_string()).collect::<Vec<_>>().join(",")
            ));
            for sid in sids {
                args.push(Box::new(sid));
            }
        }
        _ => {}
    }

    let sql = format!(
        "SELECT {ITEM_COLUMNS} FROM items i JOIN sources s ON s.id = i.source_id
         WHERE {}
         ORDER BY i.published_at DESC, i.id DESC
         LIMIT ? OFFSET ?",
        where_clauses.join(" AND ")
    );
    args.push(Box::new(limit + 1));
    args.push(Box::new(offset));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(args.iter().map(|a| a.as_ref())), item_summary_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let has_more = rows.len() > limit as usize;
    Ok(ItemsPayload {
        items: rows.into_iter().take(limit as usize).collect(),
        has_more,
    })
}

/// FTS5 search over title, snippet, author, and content. The query is split
/// into tokens; each is stripped to its alphanumeric characters, lowercased,
/// and double-quoted so FTS syntax in user input stays literal, and tokens
/// AND together. The operator words AND/OR/NOT/NEAR are dropped: users type
/// them as boolean junk, not as words to match.
pub fn search(conn: &Connection, query: &str, limit: u32) -> Result<ItemsPayload, rusqlite::Error> {
    const OPERATORS: [&str; 4] = ["and", "or", "not", "near"];
    let tokens: Vec<String> = query
        .split_whitespace()
        .map(|t| t.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
        .filter(|t| !t.is_empty() && !OPERATORS.contains(&t.to_lowercase().as_str()))
        .map(|t| format!("\"{}\"", t.to_lowercase()))
        .collect();
    if tokens.is_empty() {
        return Ok(ItemsPayload { items: vec![], has_more: false });
    }
    let sql = format!(
        "SELECT {ITEM_COLUMNS} FROM item_fts f
         JOIN items i ON i.id = f.rowid
         JOIN sources s ON s.id = i.source_id
         WHERE item_fts MATCH ? AND i.hidden = 0
         ORDER BY rank, i.published_at DESC
         LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params![tokens.join(" "), limit], item_summary_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ItemsPayload { items: rows, has_more: false })
}

fn group_member_ids(conn: &Connection, gid: i64) -> Result<Vec<i64>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT source_id FROM group_sources WHERE group_id = ?")?;
    let ids = stmt.query_map([gid], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

pub fn get_item(conn: &Connection, id: i64) -> Result<Option<ItemDetail>, rusqlite::Error> {
    let sql = format!(
        "SELECT {ITEM_COLUMNS}, i.content
         FROM items i JOIN sources s ON s.id = i.source_id
         WHERE i.id = ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map([id], |row| {
        let summary = item_summary_from_row(row)?;
        Ok(ItemDetail {
            id: summary.id,
            source_id: summary.source_id,
            title: summary.title,
            link: summary.link,
            date: summary.date,
            thumb: summary.thumb,
            content: row.get(11)?,
            snippet: summary.snippet,
            has_read: summary.has_read,
            starred: summary.starred,
            source_name: summary.source_name,
            source_icon: summary.source_icon,
        })
    })?;
    match rows.next() {
        Some(item) => Ok(Some(item?)),
        None => Ok(None),
    }
}

// ---------- writes ----------

pub fn set_read(conn: &Connection, id: i64, read: bool) -> Result<bool, rusqlite::Error> {
    let value = if read { Some(now_ms()) } else { None };
    let n = conn.execute("UPDATE items SET read_at = ? WHERE id = ?", params![value, id])?;
    Ok(n > 0)
}

pub fn set_starred(conn: &Connection, id: i64, starred: bool) -> Result<bool, rusqlite::Error> {
    let value = if starred { Some(now_ms()) } else { None };
    let n = conn.execute("UPDATE items SET starred_at = ? WHERE id = ?", params![value, id])?;
    Ok(n > 0)
}

/// Marks every unread, non-hidden item in a scope read in a single statement.
/// The WHERE clause excludes already-read rows, so existing read timestamps
/// are preserved and the FTS update trigger only fires for rows that change.
/// Returns the number of items newly marked.
pub fn mark_all_read(conn: &Connection, scope: &Scope) -> Result<u32, rusqlite::Error> {
    let mut where_clauses = vec!["hidden = 0".to_string(), "read_at IS NULL".to_string()];
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    match scope.kind.as_str() {
        "source" => {
            where_clauses.push("source_id = ?".to_string());
            args.push(Box::new(scope.id.unwrap_or(-1)));
        }
        "group" => {
            where_clauses.push(
                "source_id IN (SELECT source_id FROM group_sources WHERE group_id = ?)".to_string(),
            );
            args.push(Box::new(scope.id.unwrap_or(-1)));
        }
        _ => {}
    }
    let sql = format!(
        "UPDATE items SET read_at = ? WHERE {}",
        where_clauses.join(" AND ")
    );
    // Binding order follows the SQL text: the timestamp precedes the WHERE args.
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(now_ms())];
    params.extend(args);
    let mut stmt = conn.prepare(&sql)?;
    let n = stmt.execute(params_from_iter(params.iter().map(|a| a.as_ref())))?;
    Ok(n as u32)
}

// ---------- feed & group management ----------

pub fn create_group(conn: &Connection, name: &str) -> Result<i64, rusqlite::Error> {
    conn.execute("INSERT INTO groups (name) VALUES (?)", params![name])?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_group(conn: &Connection, id: i64, name: &str) -> Result<(), rusqlite::Error> {
    conn.execute("UPDATE groups SET name = ? WHERE id = ?", params![name, id])?;
    Ok(())
}

pub fn delete_group(conn: &Connection, id: i64) -> Result<(), rusqlite::Error> {
    // group_sources rows cascade; sources stay and become loose.
    conn.execute("DELETE FROM groups WHERE id = ?", params![id])?;
    Ok(())
}

/// Persists the sidebar display order. `ids` is every group id in the wanted
/// order; positions are rewritten 0..n inside one transaction.
pub fn reorder_groups(conn: &Connection, ids: &[i64]) -> Result<(), rusqlite::Error> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<(), rusqlite::Error> {
        for (pos, gid) in ids.iter().enumerate() {
            conn.execute("UPDATE groups SET position = ? WHERE id = ?", params![pos as i64, gid])?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(err);
        }
    }
    Ok(())
}

/// One call per feed-row dropdown change: Some(gid) moves the source into that
/// group, None makes it loose.
pub fn group_id_by_name(conn: &Connection, name: &str) -> Result<Option<i64>, rusqlite::Error> {
    conn.query_row("SELECT id FROM groups WHERE name = ?", params![name], |r| r.get(0))
        .optional()
}

pub fn set_source_group(conn: &Connection, sid: i64, gid: Option<i64>) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM group_sources WHERE source_id = ?", params![sid])?;
    if let Some(gid) = gid {
        conn.execute(
            "INSERT INTO group_sources (group_id, source_id) VALUES (?, ?)",
            params![gid, sid],
        )?;
    }
    Ok(())
}

pub fn add_source(
    conn: &Connection,
    url: &str,
    name: &str,
    icon: Option<&str>,
    site_url: Option<&str>,
) -> Result<i64, rusqlite::Error> {
    conn.execute(
        "INSERT INTO sources (url, name, icon_url, site_url, created_at) VALUES (?, ?, ?, ?, ?)",
        params![url, name, icon, site_url, now_ms()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_source(conn: &Connection, sid: i64, name: &str) -> Result<(), rusqlite::Error> {
    conn.execute("UPDATE sources SET name = ? WHERE id = ?", params![name, sid])?;
    Ok(())
}

pub fn remove_source(conn: &Connection, sid: i64) -> Result<(), rusqlite::Error> {
    // items cascade via FK; the FTS delete trigger keeps the index in sync.
    conn.execute("DELETE FROM sources WHERE id = ?", params![sid])?;
    Ok(())
}

pub fn source_url_exists(conn: &Connection, url: &str) -> Result<bool, rusqlite::Error> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sources WHERE url = ?",
        params![url],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

pub fn get_settings(conn: &Connection) -> Result<std::collections::BTreeMap<String, String>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().collect())
}

pub fn get_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0)).ok()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Inserts new entries for a source, skipping any whose guid or link already
/// exists for that source. The existence check runs inside the same immediate
/// transaction as the inserts so concurrent fetch passes cannot double-insert.
pub fn store_entries(
    conn: &Connection,
    source_id: i64,
    entries: &[crate::models::FetchedItem],
) -> Result<usize, rusqlite::Error> {
    let mut known = std::collections::HashSet::new();
    {
        // Track both identities and raw links: a fresh guid pointing at an
        // already-stored link must not insert a second copy.
        let mut stmt = conn.prepare("SELECT identity, link FROM items WHERE source_id = ?")?;
        let rows = stmt
            .query_map([source_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (identity, link) in rows {
            known.insert(identity);
            known.insert(link);
        }
    }
    let mut inserted = 0;
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<usize, rusqlite::Error> {
        let mut stmt = conn.prepare(
            "INSERT INTO items (source_id, guid, link, title, author, thumb, content, snippet, published_at, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )?;
        let now = now_ms();
        for e in entries {
            if known.contains(e.guid.as_deref().unwrap_or(&e.link)) || known.contains(&e.link) {
                continue;
            }
            stmt.execute(params![
                source_id, e.guid, e.link, e.title, e.author, e.thumb, e.content, e.snippet,
                e.date, now
            ])?;
            if let Some(g) = &e.guid {
                known.insert(g.clone());
            }
            known.insert(e.link.clone());
            inserted += 1;
        }
        conn.execute("UPDATE sources SET last_fetched = ? WHERE id = ?", params![now, source_id])?;
        Ok(inserted)
    })();
    match result {
        Ok(n) => {
            conn.execute_batch("COMMIT")?;
            Ok(n)
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        // In-memory so parallel tests can never share a file.
        let conn = Connection::open_in_memory().expect("open temp db");
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
            .expect("pragmas");
        run_migrations(&conn).expect("migrate");
        conn
    }

    fn seed(conn: &Connection) {
        conn.execute_batch(
            "INSERT INTO sources (id, url, name, created_at) VALUES
                (1, 'https://a.example/rss', 'Alpha', 0),
                (2, 'https://b.example/rss', 'Beta', 0);
             INSERT INTO groups (id, name) VALUES (10, 'G1');
             INSERT INTO group_sources (group_id, source_id) VALUES (10, 1);
             INSERT INTO items (id, source_id, guid, link, title, published_at, fetched_at) VALUES
                (100, 1, 'g-1', 'https://a.example/1', 'First', 3000, 3000),
                (101, 1, 'g-2', 'https://a.example/2', 'Second', 2000, 2000),
                (102, 2, 'g-3', 'https://b.example/3', 'Third', 1000, 1000);",
        )
        .expect("seed");
    }

    #[test]
    fn migrations_create_schema_and_are_idempotent() {
        let conn = test_conn();
        for table in ["sources", "groups", "group_sources", "items", "item_fts", "settings", "migrations"] {
            let n: i64 = conn
                .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','index') AND name = ?", [table], |r| r.get(0))
                .expect("table exists");
            assert!(n > 0, "missing {table}");
        }
        run_migrations(&conn).expect("second migration");
        let applied: i64 = conn
            .query_row("SELECT COUNT(*) FROM migrations WHERE name = '001_init'", [], |r| r.get(0))
            .expect("count");
        assert_eq!(applied, 1);
    }

    #[test]
    fn list_feeds_counts_unread_and_groups() {
        let conn = test_conn();
        seed(&conn);
        let feeds = list_feeds(&conn).expect("list_feeds");
        assert_eq!(feeds.total_unread, 3);
        let alpha = feeds.sources.iter().find(|s| s.sid == 1).expect("alpha");
        assert_eq!(alpha.unread, 2);
        assert_eq!(feeds.groups.len(), 1);
        assert_eq!(feeds.groups[0].sids, vec![1]);
        assert_eq!(feeds.groups[0].unread, 2);
        assert_eq!(feeds.loose.len(), 1);
        assert_eq!(feeds.loose[0].sid, 2);
    }

    #[test]
    fn list_items_filters_and_pages() {
        let conn = test_conn();
        seed(&conn);
        let all = list_items(&conn, &Scope { kind: "all".into(), id: None }, false, 2, 0).expect("items");
        assert_eq!(all.items.len(), 2);
        assert!(all.has_more);
        assert_eq!(all.items[0].id, 100);

        let unread = list_items(&conn, &Scope { kind: "all".into(), id: None }, true, 50, 0).expect("unread");
        assert_eq!(unread.items.len(), 3);

        let by_group = list_items(&conn, &Scope { kind: "group".into(), id: Some(10) }, false, 50, 0).expect("group");
        assert_eq!(by_group.items.len(), 2);

        let empty_group = list_items(&conn, &Scope { kind: "group".into(), id: Some(99) }, false, 50, 0).expect("empty group");
        assert_eq!(empty_group.items.len(), 0);
    }

    #[test]
    fn set_read_and_star_round_trip() {
        let conn = test_conn();
        seed(&conn);
        assert!(set_read(&conn, 100, true).expect("set read"));
        let unread = list_items(&conn, &Scope { kind: "all".into(), id: None }, true, 50, 0).expect("unread");
        assert_eq!(unread.items.len(), 2);
        assert!(set_read(&conn, 100, false).expect("unset"));
        assert!(set_starred(&conn, 101, true).expect("star"));
        let item = get_item(&conn, 101).expect("get").expect("exists");
        assert_eq!(item.starred, 1);
        assert!(!set_read(&conn, 999, true).expect("missing id"));
    }

    #[test]
    fn mark_all_read_all_scope_preserves_read_state() {
        let conn = test_conn();
        seed(&conn);
        set_read(&conn, 101, true).expect("pre-read");
        let original_ts: i64 = conn
            .query_row("SELECT read_at FROM items WHERE id = 101", [], |r| r.get(0))
            .expect("ts");

        let n = mark_all_read(&conn, &Scope { kind: "all".into(), id: None }).expect("mark all");
        assert_eq!(n, 2); // 100 and 102 were unread
        let unread: i64 = conn
            .query_row("SELECT COUNT(*) FROM items WHERE read_at IS NULL", [], |r| r.get(0))
            .expect("unread");
        assert_eq!(unread, 0);
        let ts: i64 = conn
            .query_row("SELECT read_at FROM items WHERE id = 101", [], |r| r.get(0))
            .expect("ts");
        assert_eq!(ts, original_ts);

        let again = mark_all_read(&conn, &Scope { kind: "all".into(), id: None }).expect("again");
        assert_eq!(again, 0); // idempotent
    }

    #[test]
    fn mark_all_read_source_and_group_scopes() {
        let conn = test_conn();
        seed(&conn);
        // Group 10 holds source 1 only (items 100, 101); item 102 stays unread.
        let n = mark_all_read(&conn, &Scope { kind: "group".into(), id: Some(10) }).expect("group");
        assert_eq!(n, 2);
        let unread: i64 = conn
            .query_row("SELECT COUNT(*) FROM items WHERE read_at IS NULL", [], |r| r.get(0))
            .expect("unread");
        assert_eq!(unread, 1);

        let conn = test_conn();
        seed(&conn);
        let n = mark_all_read(&conn, &Scope { kind: "source".into(), id: Some(2) }).expect("source");
        assert_eq!(n, 1);
        let unread: i64 = conn
            .query_row("SELECT COUNT(*) FROM items WHERE read_at IS NULL", [], |r| r.get(0))
            .expect("unread");
        assert_eq!(unread, 2); // source 1 untouched

        let empty = mark_all_read(&conn, &Scope { kind: "group".into(), id: Some(999) }).expect("empty");
        assert_eq!(empty, 0);
    }

    #[test]
    fn mark_all_read_skips_hidden_and_keeps_fts_synced() {
        let conn = test_conn();
        seed(&conn);
        conn.execute("UPDATE items SET hidden = 1 WHERE id = 100", []).expect("hide");

        let n = mark_all_read(&conn, &Scope { kind: "all".into(), id: None }).expect("mark all");
        assert_eq!(n, 2);
        let hidden_unread: i64 = conn
            .query_row("SELECT COUNT(*) FROM items WHERE id = 100 AND read_at IS NULL", [], |r| r.get(0))
            .expect("hidden unread");
        assert_eq!(hidden_unread, 1);
        let fts: i64 = conn
            .query_row("SELECT COUNT(*) FROM item_fts", [], |r| r.get(0))
            .expect("fts count");
        assert_eq!(fts, 3); // update trigger kept the index in sync
    }

    #[test]
    fn item_detail_includes_content() {
        let conn = test_conn();
        seed(&conn);
        conn.execute("UPDATE items SET content = '<p>full body</p>' WHERE id = 100", [])
            .expect("content");
        let item = get_item(&conn, 100).expect("get").expect("exists");
        assert_eq!(item.content, "<p>full body</p>");
        assert_eq!(item.source_name, "Alpha");
    }

    #[test]
    fn dedupe_skips_known_guid_or_link() {
        let conn = test_conn();
        seed(&conn);
        let entries = vec![crate::models::FetchedItem {
            guid: Some("g-1".into()),
            link: "https://a.example/1".into(),
            title: "dup by guid".into(),
            date: 4000,
            content: String::new(),
            thumb: None,
            snippet: String::new(),
            author: None,
        }, crate::models::FetchedItem {
            guid: Some("brand-new".into()),
            link: "https://a.example/2".into(),
            title: "dup by link".into(),
            date: 4001,
            content: String::new(),
            thumb: None,
            snippet: String::new(),
            author: None,
        }, crate::models::FetchedItem {
            guid: Some("fresh".into()),
            link: "https://a.example/fresh".into(),
            title: "kept".into(),
            date: 4002,
            content: String::new(),
            thumb: None,
            snippet: String::new(),
            author: None,
        }];
        let n = store_entries(&conn, 1, &entries).expect("store");
        assert_eq!(n, 1);
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE source_id = 1", [], |r| r.get(0)).expect("count");
        assert_eq!(total, 3);
    }

    #[test]
    fn settings_round_trip() {
        let conn = test_conn();
        assert_eq!(get_setting(&conn, "fetch_interval_min"), None);
        set_setting(&conn, "fetch_interval_min", "15").expect("set");
        assert_eq!(get_setting(&conn, "fetch_interval_min"), Some("15".into()));
        set_setting(&conn, "fetch_interval_min", "45").expect("overwrite");
        assert_eq!(get_setting(&conn, "fetch_interval_min"), Some("45".into()));
        let all = get_settings(&conn).expect("all");
        assert_eq!(all.get("fetch_interval_min").map(String::as_str), Some("45"));
    }

    #[test]
    fn group_lifecycle_and_membership() {
        let conn = test_conn();
        seed(&conn);
        let gid = create_group(&conn, "Later").expect("create");
        set_source_group(&conn, 2, Some(gid)).expect("assign");
        let feeds = list_feeds(&conn).expect("feeds");
        let g = feeds.groups.iter().find(|g| g.gid == gid).expect("group exists");
        assert_eq!(g.name, "Later");
        assert_eq!(g.sids, vec![2]);
        assert_eq!(feeds.loose.len(), 0);

        set_source_group(&conn, 2, None).expect("unassign");
        let feeds = list_feeds(&conn).expect("feeds");
        assert_eq!(feeds.loose.iter().map(|s| s.sid).collect::<Vec<_>>(), vec![2]);

        rename_group(&conn, gid, "Renamed").expect("rename");
        let name: String = conn.query_row("SELECT name FROM groups WHERE id = ?", [gid], |r| r.get(0)).expect("name");
        assert_eq!(name, "Renamed");

        delete_group(&conn, gid).expect("delete");
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM groups", [], |r| r.get(0)).expect("count");
        assert_eq!(count, 1); // seed group G1 survives
    }

    #[test]
    fn group_order_persists() {
        let conn = test_conn();
        seed(&conn);
        let g2 = create_group(&conn, "Second").expect("g2");
        let g3 = create_group(&conn, "Third").expect("g3");
        // Seed group is 10; reorder to Third, G1, Second.
        reorder_groups(&conn, &[g3, 10, g2]).expect("reorder");
        let feeds = list_feeds(&conn).expect("feeds");
        let order: Vec<i64> = feeds.groups.iter().map(|g| g.gid).collect();
        assert_eq!(order, vec![g3, 10, g2]);
        // Partial reorder (only some ids) leaves the rest untouched.
        reorder_groups(&conn, &[10]).expect("partial");
        let feeds = list_feeds(&conn).expect("feeds");
        assert_eq!(feeds.groups[0].gid, 10);
    }

    #[test]
    fn search_matches_across_columns_and_excludes_hidden() {
        let conn = test_conn();
        seed(&conn);
        conn.execute_batch(
            "UPDATE items SET content = '<p>quokka habitat facts</p>', snippet = 'quokka', author = 'Ada' WHERE id = 100;
             UPDATE items SET title = 'GAAP rules', snippet = 'second hand' WHERE id = 101;
             INSERT INTO items (id, source_id, guid, link, title, snippet, published_at, fetched_at, hidden)
             VALUES (103, 2, 'g-4', 'https://b.example/4', 'Quokka hidden', 'quokka', 500, 500, 1);",
        )
        .expect("seed search");

        // Title (case-folded)
        let hits = search(&conn, "first", 10).expect("title search");
        assert_eq!(hits.items.iter().map(|i| i.id).collect::<Vec<_>>(), vec![100]);

        // Content and snippet
        let hits = search(&conn, "quokka", 10).expect("content search");
        assert_eq!(hits.items.iter().map(|i| i.id).collect::<Vec<_>>(), vec![100]);
        // The hidden copy of the same word must not surface.
        assert!(!hits.items.iter().any(|i| i.id == 103));

        // Author
        let hits = search(&conn, "ada", 10).expect("author search");
        assert_eq!(hits.items.len(), 1);

        // Multiple tokens AND together: no item is both First and GAAP.
        assert!(search(&conn, "first gaap", 10).expect("multi token").items.is_empty());
        // But one item can match both tokens in different columns.
        assert_eq!(search(&conn, "gaap second", 10).expect("cross column").items.len(), 1);

        // FTS operators and punctuation in the query are stripped, never
        // executed: AND/OR/NOT drop out as operator words, so raw boolean
        // junk can neither error nor change the semantics.
        let hits = search(&conn, "first\")) OR (*", 10).expect("injection");
        assert_eq!(hits.items.len(), 1);
        assert!(search(&conn, "first AND second", 10).expect("operator words").items.is_empty());

        // Symbol-only input matches nothing instead of erroring.
        assert!(search(&conn, "*** (( ", 10).expect("symbols").items.is_empty());
        assert!(search(&conn, "", 10).expect("empty").items.is_empty());
    }

    #[test]
    fn feed_lifecycle() {
        let conn = test_conn();
        seed(&conn);
        assert!(!source_url_exists(&conn, "https://x.example/rss").expect("exists"));
        let sid = add_source(&conn, "https://x.example/rss", "X Blog", None, None).expect("add");
        assert!(source_url_exists(&conn, "https://x.example/rss").expect("exists"));
        let feeds = list_feeds(&conn).expect("feeds");
        assert!(feeds.loose.iter().any(|s| s.sid == sid));

        rename_source(&conn, sid, "Renamed Feed").expect("rename");
        let name: String = conn.query_row("SELECT name FROM sources WHERE id = ?", [sid], |r| r.get(0)).expect("name");
        assert_eq!(name, "Renamed Feed");

        remove_source(&conn, 2).expect("remove");
        let items: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).expect("items");
        assert_eq!(items, 2); // source 2's item cascaded away
        let stale: i64 = conn
            .query_row("SELECT COUNT(*) FROM item_fts WHERE item_fts MATCH 'Third'", [], |r| r.get(0))
            .expect("fts");
        assert_eq!(stale, 0); // FTS index cleaned by trigger
    }
}
