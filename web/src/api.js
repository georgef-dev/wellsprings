const json = (res) => {
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export const getTheme = () => fetch('/api/theme').then(json)

export const getFeeds = () => fetch('/api/feeds').then(json)

export const getItems = (scope, unread, limit, offset) => {
  const s = scope.type + (scope.id != null ? `:${scope.id}` : '')
  return fetch(`/api/items?scope=${encodeURIComponent(s)}&unread=${unread ? 1 : 0}&limit=${limit}&offset=${offset}`).then(json)
}

export const getItem = (id) => fetch(`/api/items/${id}`).then(json)

export const patchItem = (id, patch) =>
  fetch(`/api/items/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }).then(json)

export const triggerFetch = () => fetch('/api/fetch', { method: 'POST' }).then(json)
