use serde::{Deserialize, Serialize};

/// Wire shapes mirror the Node API exactly (including `_id`, `sourceName`,
/// `sourceIcon`) so web/src/App.jsx works unchanged.

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSummary {
    pub sid: i64,
    pub name: String,
    pub icon: Option<String>,
    pub unread: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSummary {
    pub gid: i64,
    pub name: String,
    pub sids: Vec<i64>,
    pub unread: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedsPayload {
    pub sources: Vec<SourceSummary>,
    pub groups: Vec<GroupSummary>,
    pub loose: Vec<SourceSummary>,
    pub total_unread: i64,
}

#[derive(Serialize)]
pub struct ItemSummary {
    #[serde(rename = "_id")]
    pub id: i64,
    #[serde(rename = "source")]
    pub source_id: i64,
    pub title: String,
    pub link: String,
    pub date: i64,
    pub thumb: Option<String>,
    pub snippet: String,
    pub has_read: i64,
    pub starred: i64,
    #[serde(rename = "sourceName")]
    pub source_name: String,
    #[serde(rename = "sourceIcon")]
    pub source_icon: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemsPayload {
    pub items: Vec<ItemSummary>,
    pub has_more: bool,
}

#[derive(Serialize)]
pub struct ItemDetail {
    #[serde(rename = "_id")]
    pub id: i64,
    #[serde(rename = "source")]
    pub source_id: i64,
    pub title: String,
    pub link: String,
    pub date: i64,
    pub thumb: Option<String>,
    pub content: String,
    pub snippet: String,
    pub has_read: i64,
    pub starred: i64,
    #[serde(rename = "sourceName")]
    pub source_name: String,
    #[serde(rename = "sourceIcon")]
    pub source_icon: Option<String>,
}

#[derive(Deserialize)]
pub struct Scope {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResult {
    pub ok: u32,
    pub total: u32,
    pub inserted: u32,
    pub errors: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpmlExportInfo {
    pub path: String,
    pub feeds: usize,
    pub streams: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpmlImportInfo {
    pub feeds_found: usize,
    pub feeds_added: usize,
    pub streams_created: usize,
    pub streams_assigned: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePayload {
    pub name: Option<String>,
    pub vars: std::collections::HashMap<String, String>,
}

/// A parsed feed entry ready to be stored. Produced by fetch::parse_entries,
/// consumed by db::store_entries.
pub struct FetchedItem {
    pub guid: Option<String>,
    pub title: String,
    pub link: String,
    pub date: i64,
    pub content: String,
    pub thumb: Option<String>,
    pub snippet: String,
    pub author: Option<String>,
}
