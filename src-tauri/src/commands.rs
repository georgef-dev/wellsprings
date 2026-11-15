use tauri::{AppHandle, Manager, State};

use crate::db;
use crate::models::{FeedsPayload, FetchResult, ItemDetail, ItemsPayload, Scope, ThemePayload};
use crate::{fetch, theme, AppState};

#[tauri::command]
pub fn list_feeds(state: State<'_, AppState>) -> Result<FeedsPayload, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db::list_feeds(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_items(
    state: State<'_, AppState>,
    scope: Scope,
    unread_only: bool,
    limit: u32,
    offset: u32,
) -> Result<ItemsPayload, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db::list_items(&conn, &scope, unread_only, limit, offset).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_item(state: State<'_, AppState>, id: i64) -> Result<Option<ItemDetail>, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db::get_item(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_read(state: State<'_, AppState>, id: i64, read: bool) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db::set_read(&conn, id, read).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_starred(state: State<'_, AppState>, id: i64, starred: bool) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db::set_starred(&conn, id, starred).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_theme() -> ThemePayload {
    theme::get_theme()
}

#[tauri::command]
pub async fn fetch_now(app: AppHandle) -> Result<FetchResult, String> {
    Ok(fetch::fetch_all(&app).await)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<std::collections::BTreeMap<String, String>, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db::get_settings(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db::set_setting(&conn, &key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_group(state: State<'_, AppState>, name: String) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db::create_group(&conn, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_group(state: State<'_, AppState>, id: i64, name: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db::rename_group(&conn, id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_group(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db::delete_group(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_groups(state: State<'_, AppState>, ids: Vec<i64>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db::reorder_groups(&conn, &ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_source_group(state: State<'_, AppState>, sid: i64, gid: Option<i64>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db::set_source_group(&conn, sid, gid).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_source(state: State<'_, AppState>, sid: i64, name: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db::rename_source(&conn, sid, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_source(state: State<'_, AppState>, sid: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    db::remove_source(&conn, sid).map_err(|e| e.to_string())
}

/// Adds a feed by URL: fetches it, names it from the feed title, stores its
/// current entries, and optionally drops it into a group. Errors when the URL
/// is unreachable, not a feed, or already added.
#[tauri::command]
pub async fn add_source(app: AppHandle, url: String, gid: Option<i64>) -> Result<i64, String> {
    let client = fetch::client()?;
    let body = fetch::fetch_body(&client, &url).await?;
    let (title, entries) = fetch::parse_feed(body.as_bytes());
    if entries.is_empty() {
        return Err("No feed entries found at that URL".into());
    }
    let name = title
        .map(|t| t.chars().take(120).collect::<String>())
        .unwrap_or_else(|| fetch::host_of(&url));
    let state = app.state::<AppState>();
    let conn = state.db.lock().map_err(|_| "db lock poisoned".to_string())?;
    if db::source_url_exists(&conn, &url).map_err(|e| e.to_string())? {
        return Err("Feed already added".into());
    }
    let sid = db::add_source(&conn, &url, &name, None).map_err(|e| e.to_string())?;
    if let Some(gid) = gid {
        db::set_source_group(&conn, sid, Some(gid)).map_err(|e| e.to_string())?;
    }
    db::store_entries(&conn, sid, &entries).map_err(|e| e.to_string())?;
    Ok(sid)
}
