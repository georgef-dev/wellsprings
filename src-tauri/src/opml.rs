use std::fs;
use std::path::PathBuf;

use opml::{Head, OPML, Outline};
use rusqlite::{params, Connection};

use crate::db;
use crate::models::{OpmlExportInfo, OpmlImportInfo};

/// OPML export/import. Export writes every feed, nested under its stream, to
/// ~/Downloads/wellsprings.opml. Import merges by feed URL: existing feeds are
/// never touched, ungrouped feeds join the file's streams, missing feeds are
/// inserted with html_url as their site link. The whole import runs in one
/// transaction, so a failure leaves the database untouched.

pub struct FeedRow {
    pub stream: Option<String>,
    pub name: String,
    pub url: String,
    pub site_url: Option<String>,
}

fn export_rows(conn: &Connection) -> Result<Vec<FeedRow>, rusqlite::Error> {
    // Streams first in sidebar order, loose feeds after, each group sorted.
    let mut stmt = conn.prepare(
        "SELECT g.name, s.name, s.url, s.site_url
         FROM sources s
         LEFT JOIN group_sources gs ON gs.source_id = s.id
         LEFT JOIN groups g ON g.id = gs.group_id
         ORDER BY (g.position IS NULL), g.position, s.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(FeedRow {
            stream: r.get(0)?,
            name: r.get(1)?,
            url: r.get(2)?,
            site_url: r.get(3)?,
        })
    })?;
    rows.collect()
}

/// Builds the OPML document. Returns (xml, feed count, stream count).
pub fn build_document(conn: &Connection) -> Result<(String, usize, usize), String> {
    let rows = export_rows(conn).map_err(|e| e.to_string())?;
    let mut doc = OPML::default();
    doc.version = "2.0".to_string();
    doc.head = Some(Head {
        title: Some("Wellsprings feeds".to_string()),
        ..Head::default()
    });

    let mut folders: Vec<(String, Outline)> = Vec::new();
    for row in rows {
        let mut feed = Outline::default();
        feed.text = row.name;
        feed.xml_url = Some(row.url);
        feed.html_url = row.site_url;
        match row.stream {
            Some(stream) => match folders.iter_mut().find(|(name, _)| name == &stream) {
                Some((_, folder)) => folder.outlines.push(feed),
                None => {
                    let mut folder = Outline::default();
                    folder.text = stream.clone();
                    folder.outlines.push(feed);
                    folders.push((stream, folder));
                }
            },
            None => doc.body.outlines.push(feed),
        }
    }
    for (_, folder) in folders {
        doc.body.outlines.push(folder);
    }

    let feeds: usize = conn
        .query_row("SELECT COUNT(*) FROM sources", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let streams: usize = conn
        .query_row("SELECT COUNT(*) FROM groups", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let xml = doc.to_string().map_err(|e| e.to_string())?;
    Ok((xml, feeds, streams))
}

pub fn export_to_file(conn: &Connection) -> Result<OpmlExportInfo, String> {
    let (xml, feeds, streams) = build_document(conn)?;
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let dir = PathBuf::from(home).join("Downloads");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("wellsprings.opml");
    fs::write(&path, xml).map_err(|e| e.to_string())?;
    Ok(OpmlExportInfo {
        path: path.to_string_lossy().into_owned(),
        feeds,
        streams,
    })
}

/// Feeds from an outline and all its descendants, flattened.
fn collect_feeds(outline: &Outline, out: &mut Vec<Outline>) {
    for child in &outline.outlines {
        if child.xml_url.is_some() {
            out.push(child.clone());
        } else {
            collect_feeds(child, out);
        }
    }
}

fn host_of(url: &str) -> String {
    let rest = url.split_once("//").map(|(_, r)| r).unwrap_or(url);
    rest.split(['/', '?', '#']).next().unwrap_or(rest).to_string()
}

pub fn import(conn: &mut Connection, text: &str) -> Result<OpmlImportInfo, String> {
    let doc = OPML::from_str(text).map_err(|e| format!("Not a valid OPML file: {e}"))?;

    // Top-level feeds stay loose; every folder (at any depth) becomes one
    // stream holding all of its descendant feeds.
    let mut entries: Vec<(Option<String>, Outline)> = Vec::new();
    for top in &doc.body.outlines {
        if top.xml_url.is_some() {
            entries.push((None, top.clone()));
        } else if !top.outlines.is_empty() {
            let mut feeds = Vec::new();
            collect_feeds(top, &mut feeds);
            let name = if top.text.is_empty() {
                top.title.clone().unwrap_or_default()
            } else {
                top.text.clone()
            };
            let name = if name.is_empty() { "Imported".to_string() } else { name };
            for feed in feeds {
                entries.push((Some(name.clone()), feed));
            }
        }
    }

    let mut info = OpmlImportInfo {
        feeds_found: 0,
        feeds_added: 0,
        streams_created: 0,
        streams_assigned: 0,
    };
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (stream, feed) in &entries {
        let url = match feed.xml_url.as_deref().map(str::trim) {
            Some(u) if !u.is_empty() => u,
            _ => continue,
        };
        info.feeds_found += 1;
        let name = if feed.text.is_empty() {
            feed.title.clone().unwrap_or_else(|| host_of(url))
        } else {
            feed.text.clone()
        };
        let gid = match stream {
            Some(stream_name) => {
                let gid = match db::group_id_by_name(&tx, stream_name).map_err(|e| e.to_string())? {
                    Some(gid) => gid,
                    None => {
                        let gid = db::create_group(&tx, stream_name).map_err(|e| e.to_string())?;
                        info.streams_created += 1;
                        gid
                    }
                };
                Some(gid)
            }
            None => None,
        };
        let sid = if db::source_url_exists(&tx, url).map_err(|e| e.to_string())? {
            tx.query_row("SELECT id FROM sources WHERE url = ?", params![url], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())?
        } else {
            let sid =
                db::add_source(&tx, url, &name, None, feed.html_url.as_deref()).map_err(|e| e.to_string())?;
            info.feeds_added += 1;
            sid
        };
        if let Some(gid) = gid {
            let grouped: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM group_sources WHERE source_id = ?",
                    params![sid],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if grouped == 0 {
                db::set_source_group(&tx, sid, Some(gid)).map_err(|e| e.to_string())?;
                info.streams_assigned += 1;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn conn() -> Connection {
        let c = db::open_db(Path::new(":memory:")).expect("open");
        db::run_migrations(&c).expect("migrate");
        c
    }

    fn seed(conn: &Connection) {
        let a = db::add_source(conn, "https://a.example/rss", "A Blog", None, Some("https://a.example")).expect("a");
        let b = db::add_source(conn, "https://b.example/rss", "B News", None, None).expect("b");
        let g = db::create_group(conn, "Tech").expect("g");
        db::set_source_group(conn, a, Some(g)).expect("assign");
        let _ = b;
    }

    #[test]
    fn round_trip_recreates_streams_and_feeds() {
        let source = conn();
        seed(&source);
        let (doc, feeds, streams) = build_document(&source).expect("doc");
        assert_eq!(feeds, 2);
        assert_eq!(streams, 1);
        assert!(doc.starts_with("<opml version=\"2.0\">"));
        assert!(doc.contains("https://a.example/rss"));
        assert!(doc.contains("Tech"));

        let mut target = conn();
        let info = import(&mut target, &doc).expect("import");
        assert_eq!(info.feeds_found, 2);
        assert_eq!(info.feeds_added, 2);
        assert_eq!(info.streams_created, 1);
        assert_eq!(info.streams_assigned, 1);

        assert!(db::source_url_exists(&target, "https://a.example/rss").expect("a"));
        assert!(db::source_url_exists(&target, "https://b.example/rss").expect("b"));
        let grouped: i64 = target
            .query_row(
                "SELECT COUNT(*) FROM group_sources gs JOIN groups g ON g.id = gs.group_id WHERE g.name = 'Tech'",
                [],
                |r| r.get(0),
            )
            .expect("tech count");
        assert_eq!(grouped, 1);

        // Re-importing the same file changes nothing.
        let again = import(&mut target, &doc).expect("reimport");
        assert_eq!(again.feeds_found, 2);
        assert_eq!(again.feeds_added, 0);
        assert_eq!(again.streams_created, 0);
        assert_eq!(again.streams_assigned, 0);
    }

    #[test]
    fn import_never_steals_grouped_feeds() {
        let source = conn();
        seed(&source);
        let (doc, _, _) = build_document(&source).expect("doc");

        let mut target = conn();
        let sid = db::add_source(&target, "https://a.example/rss", "A Blog", None, None).expect("a");
        let home = db::create_group(&target, "Home").expect("home");
        db::set_source_group(&target, sid, Some(home)).expect("assign");

        let info = import(&mut target, &doc).expect("import");
        assert_eq!(info.feeds_added, 1); // only B is new
        assert_eq!(info.streams_created, 1); // Tech folder
        assert_eq!(info.streams_assigned, 0); // A stays in Home
        let in_home: i64 = target
            .query_row("SELECT COUNT(*) FROM group_sources WHERE group_id = ?", params![home], |r| r.get(0))
            .expect("home count");
        assert_eq!(in_home, 1);
    }

    #[test]
    fn nested_folders_flatten_into_one_stream() {
        let xml = r#"<opml version="2.0"><head/><body>
          <outline text="News">
            <outline text="World">
              <outline text="W1" xmlUrl="https://w1.example/rss"/>
              <outline text="W2" xmlUrl="https://w2.example/rss"/>
            </outline>
            <outline text="W3" xmlUrl="https://w3.example/rss"/>
          </outline>
        </body></opml>"#;
        let mut c = conn();
        let info = import(&mut c, xml).expect("import");
        assert_eq!(info.feeds_added, 3);
        assert_eq!(info.streams_created, 1);
        assert_eq!(info.streams_assigned, 3);
        let in_news: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM group_sources gs JOIN groups g ON g.id = gs.group_id WHERE g.name = 'News'",
                [],
                |r| r.get(0),
            )
            .expect("news count");
        assert_eq!(in_news, 3);
    }
}
