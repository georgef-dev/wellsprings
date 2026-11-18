import { invoke } from '@tauri-apps/api/core'

// Same functions and return shapes as the Node version, backed by Tauri
// commands instead of HTTP, so App.jsx is unchanged.

export const getTheme = () => invoke('get_theme')

export const getFeeds = () => invoke('list_feeds')

export const getItems = (scope, unread, limit, offset) =>
  invoke('list_items', { scope, unreadOnly: unread, limit, offset })

export const getItem = (id) => invoke('get_item', { id })

export const patchItem = (id, patch) =>
  patch.hasRead !== undefined
    ? invoke('set_read', { id, read: patch.hasRead })
    : invoke('set_starred', { id, starred: patch.starred })

export const markAllRead = (scope) => invoke('mark_all_read', { scope })

export const triggerFetch = () => invoke('fetch_now')

export const getSettings = () => invoke('get_settings')
export const setSetting = (key, value) => invoke('set_setting', { key, value })

export const createGroup = (name) => invoke('create_group', { name })
export const renameGroup = (id, name) => invoke('rename_group', { id, name })
export const deleteGroup = (id) => invoke('delete_group', { id })
export const reorderGroups = (ids) => invoke('reorder_groups', { ids })
export const setSourceGroup = (sid, gid) => invoke('set_source_group', { sid, gid })
export const renameSource = (sid, name) => invoke('rename_source', { sid, name })
export const removeSource = (sid) => invoke('remove_source', { sid })
export const addSource = (url, gid) => invoke('add_source', { url, gid })

export const search = (query, limit = 60) => invoke('search', { query, limit })
export const exportOpml = () => invoke('export_opml')
export const importOpml = (text) => invoke('import_opml', { text })
