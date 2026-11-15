use feed_rs::model as fm;
use feed_rs::parser;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::db;
use crate::models::{FetchResult, FetchedItem};
use crate::AppState;

const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) feeds/2.0";
const TIMEOUT_SECS: u64 = 15;

fn text_of(t: &Option<fm::Text>) -> String {
    t.as_ref().map(|t| t.content.clone()).unwrap_or_default()
}

fn link_of(entry: &fm::Entry) -> Option<String> {
    entry
        .links
        .iter()
        .find(|l| l.rel.is_none() || l.rel.as_deref() == Some("alternate"))
        .or_else(|| entry.links.first())
        .map(|l| l.href.clone())
}

fn date_of(entry: &fm::Entry) -> i64 {
    entry
        .published
        .or(entry.updated)
        .map(|d| d.timestamp_millis())
        .unwrap_or_else(db::now_ms)
}

/// thumb chain: media thumbnail -> media content image -> image enclosure ->
/// first <img> in the content. Same order the Node fetcher proved out.
fn thumb_of(entry: &fm::Entry, content: &str) -> Option<String> {
    for m in &entry.media {
        for t in &m.thumbnails {
            if !t.image.uri.is_empty() {
                return Some(t.image.uri.clone());
            }
        }
    }
    for m in &entry.media {
        for c in &m.content {
            if let Some(uri) = &c.url {
                let mime = c.content_type.as_ref().map(|m| m.to_string());
                let looks_image = mime.map(|m| m.starts_with("image/")).unwrap_or(false)
                    || path_is_image(uri.as_str());
                if looks_image {
                    return Some(uri.as_str().to_string());
                }
            }
        }
    }
    for l in &entry.links {
        if l.rel.as_deref() == Some("enclosure")
            && l.media_type.as_deref().map(|m| m.starts_with("image/")).unwrap_or(false)
        {
            return Some(l.href.clone());
        }
    }
    find_img_src(content)
}

fn path_is_image(url: &str) -> bool {
    let path = url.split('?').next().unwrap_or(url);
    let ext = path.rsplit('.').next().unwrap_or("");
    matches!(ext.to_lowercase().as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "avif")
}

fn find_img_src(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let mut search = lower.as_str();
    while let Some(pos) = search.find("<img") {
        let rest = &search[pos..];
        let end = rest.find('>').unwrap_or(rest.len());
        let tag = &rest[..end];
        for quote in ['"', '\''] {
            let needle = format!("src={quote}");
            if let Some(start) = tag.find(&needle) {
                let after = &tag[start + needle.len()..];
                if let Some(close) = after.find(quote) {
                    let src = &after[..close];
                    if !src.is_empty() {
                        return Some(src.to_string());
                    }
                }
            }
        }
        search = &rest[end.min(rest.len())..];
    }
    None
}

fn decode_entities(s: &str) -> String {
    const NAMED: &[(&str, &str)] = &[
        ("amp", "&"), ("lt", "<"), ("gt", ">"), ("quot", "\""),
        ("apos", "'"), ("nbsp", " "),
    ];
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        // Bounded byte scan for ';'. UTF-8 continuation bytes never equal
        // b';', so the found offset always lands on a char boundary — slicing
        // stays safe even when multi-byte characters sit inside the window.
        let end = tail[1..]
            .bytes()
            .take(9)
            .position(|b| b == b';')
            .map(|p| p + 1);
        match end {
            Some(len) if len > 1 => {
                let entity = &tail[1..len];
                if let Some(num) = entity.strip_prefix('#') {
                    let code = if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        num.parse::<u32>().ok()
                    };
                    if let Some(c) = code.and_then(char::from_u32) {
                        out.push(c);
                        rest = &tail[len + 1..];
                        continue;
                    }
                } else if let Some((_, replacement)) = NAMED.iter().find(|(name, _)| name.eq_ignore_ascii_case(entity)) {
                    out.push_str(replacement);
                    rest = &tail[len + 1..];
                    continue;
                }
                out.push('&');
                rest = &tail[1..];
            }
            _ => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    let decoded = decode_entities(&out);
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn snippet_of(content: &str) -> String {
    strip_html(content).chars().take(300).collect()
}

/// Parses a feed document into (title, entries). The title names new sources
/// added by URL; entries are empty when the document is not a feed.
pub fn parse_feed(xml: &[u8]) -> (Option<String>, Vec<FetchedItem>) {
    let feed = match parser::parse(xml) {
        Ok(feed) => feed,
        Err(_) => return (None, Vec::new()),
    };
    let title = feed
        .title
        .as_ref()
        .map(|t| t.content.trim().to_string())
        .filter(|t| !t.is_empty());
    let entries = feed.entries
        .iter()
        .filter_map(|entry| {
            let link = link_of(entry)?;
            let title = text_of(&entry.title);
            if title.is_empty() {
                return None;
            }
            // Atom <content> lands in entry.content; RSS <description> lands in
            // entry.summary. Real feeds use either as the body text.
            let content = entry
                .content
                .as_ref()
                .and_then(|c| c.body.clone())
                .or_else(|| entry.summary.as_ref().map(|s| s.content.clone()))
                .unwrap_or_default();
            Some(FetchedItem {
                guid: Some(entry.id.clone()),
                title,
                link,
                date: date_of(entry),
                thumb: thumb_of(entry, &content),
                snippet: snippet_of(&content),
                content,
                author: entry.authors.first().map(|p| p.name.clone()),
            })
        })
        .collect();
    (title, entries)
}

pub fn parse_entries(xml: &[u8]) -> Vec<FetchedItem> {
    parse_feed(xml).1
}

pub(crate) fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())
}

/// "https://a.example/rss" -> "a.example", used when a feed has no title.
pub(crate) fn host_of(url: &str) -> String {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    let host = after_scheme.split('/').next().unwrap_or(url);
    host.chars().take(120).collect()
}

/// GET a feed URL as text with the standard accept header. Shared by the
/// fetch loop and add-feed.
pub(crate) async fn fetch_body(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let res = client
        .get(url)
        .header(
            "accept",
            "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        )
        .send()
        .await
        .map_err(|e| format!("{url}: {e}"))?;
    res.error_for_status()
        .map_err(|e| format!("{url}: {e}"))?
        .text()
        .await
        .map_err(|e| format!("{url}: {e}"))
}

async fn fetch_source(
    handle: &AppHandle,
    client: &reqwest::Client,
    sid: i64,
    url: String,
) -> Result<usize, String> {
    let body = fetch_body(client, &url).await?;
    let entries = parse_entries(body.as_bytes());
    let state = handle.state::<AppState>();
    let conn = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db::store_entries(&conn, sid, &entries).map_err(|e| format!("{url}: {e}"))
}

pub async fn fetch_all(handle: &AppHandle) -> FetchResult {
    let started = std::time::Instant::now();
    let sources: Vec<(i64, String)> = {
        let state = handle.state::<AppState>();
        let conn = match state.db.lock() {
            Ok(c) => c,
            Err(_) => {
                return FetchResult { ok: 0, total: 0, inserted: 0, errors: vec!["db lock poisoned".into()] }
            }
        };
        let mut stmt = match conn.prepare("SELECT id, url FROM sources") {
            Ok(s) => s,
            Err(e) => {
                return FetchResult { ok: 0, total: 0, inserted: 0, errors: vec![e.to_string()] }
            }
        };
        match stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|rows| rows.collect::<Result<Vec<_>, _>>()) {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => return FetchResult { ok: 0, total: 0, inserted: 0, errors: vec![e.to_string()] },
            Err(e) => return FetchResult { ok: 0, total: 0, inserted: 0, errors: vec![e.to_string()] },
        }
    };
    let total = sources.len() as u32;
    let Ok(client) = client() else {
        return FetchResult { ok: 0, total, inserted: 0, errors: vec!["http client".into()] }
    };

    let mut handles = Vec::new();
    for (sid, url) in sources {
        let handle = handle.clone();
        let client = client.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            fetch_source(&handle, &client, sid, url).await
        }));
    }

    let mut ok = 0u32;
    let mut inserted = 0u32;
    let mut errors = Vec::new();
    for h in handles {
        match h.await {
            Ok(Ok(n)) => {
                ok += 1;
                inserted += n as u32;
            }
            Ok(Err(err)) => errors.push(err),
            Err(err) => errors.push(err.to_string()),
        }
    }
    println!(
        "[fetch] {ok}/{total} sources ok, {inserted} new items in {}ms",
        started.elapsed().as_millis()
    );
    if !errors.is_empty() {
        println!("[fetch] errors: {}", errors.join(" | "));
    }
    let _ = handle.emit("fetch-done", json!({ "ok": ok, "total": total, "inserted": inserted }));
    FetchResult { ok, total, inserted, errors }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSS: &str = include_str!("../tests/fixtures/rss2.xml");
    const ATOM: &str = include_str!("../tests/fixtures/atom.xml");

    #[test]
    fn parses_rss2_with_media_thumbnail() {
        let items = parse_entries(RSS.as_bytes());
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.title, "RSS Entry One");
        assert_eq!(item.link, "https://example.com/rss-1");
        assert_eq!(item.guid.as_deref(), Some("rss-item-1"));
        assert_eq!(item.thumb.as_deref(), Some("https://example.com/thumb1.jpg"));
        assert_eq!(item.author.as_deref(), Some("John Smith"));
        assert!(item.date > 1_700_000_000_000, "date in ms: {}", item.date);
        assert!(item.content.contains("Body"));
        assert!(item.snippet.contains("Body"));
        assert!(!item.snippet.contains('<'), "snippet should be stripped");
    }

    #[test]
    fn parses_atom_with_media_content() {
        let items = parse_entries(ATOM.as_bytes());
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.title, "Atom Entry One");
        assert_eq!(item.link, "https://example.com/atom-1");
        assert_eq!(item.guid.as_deref(), Some("urn:uuid:item-1"));
        assert_eq!(item.thumb.as_deref(), Some("https://example.com/img/one.jpg"));
        assert_eq!(item.author.as_deref(), Some("Jane Doe"));
        assert!(item.content.contains("world"));
    }

    #[test]
    fn garbage_xml_yields_nothing() {
        assert!(parse_entries(b"not xml at all").is_empty());
    }

    #[test]
    fn finds_img_src_in_content() {
        let src = find_img_src("<p>hi</p><img src=\"https://x/y.jpg\" alt=\"\">");
        assert_eq!(src.as_deref(), Some("https://x/y.jpg"));
        let single = find_img_src("<img src='https://x/z.png'>");
        assert_eq!(single.as_deref(), Some("https://x/z.png"));
        assert_eq!(find_img_src("<p>no image</p>"), None);
    }

    #[test]
    fn strips_entities_and_whitespace() {
        assert_eq!(strip_html("<p>A &amp; B</p>\n  <p>C</p>"), "A & B C");
        assert_eq!(strip_html("5 &lt; 6 &gt; 4"), "5 < 6 > 4");
        assert_eq!(strip_html("a&nbsp;b"), "a b");
    }

    #[test]
    fn decode_survives_multibyte_after_ampersand() {
        // Regression: the bounded entity scan must never slice inside a
        // multi-byte character ("& agenda íntegra" panicked the old version).
        assert_eq!(strip_html("& agenda íntegra"), "& agenda íntegra");
        assert_eq!(strip_html("feijão &amp; arroz íntegro"), "feijão & arroz íntegro");
        assert_eq!(strip_html("R&#233;sum&#233; &amp; Co"), "Résumé & Co");
    }
}
