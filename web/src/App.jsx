import { useCallback, useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { listen } from '@tauri-apps/api/event'
import { getFeeds, getItems, getItem, patchItem, getTheme, triggerFetch, reorderGroups, search, markAllRead } from './api'
import Settings from './Settings'
import Shortcuts from './Shortcuts'

const PAGE = 50

function relTime(ms) {
  const d = Date.now() - ms
  if (d < 60e3) return 'now'
  if (d < 36e5) return `${Math.floor(d / 60e3)}m`
  if (d < 864e5) return `${Math.floor(d / 36e5)}h`
  if (d < 7 * 864e5) return `${Math.floor(d / 864e5)}d`
  return new Date(ms).toLocaleDateString()
}

function Icon({ src, name }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return <span className="avatar">{(name || '?').trim().charAt(0).toUpperCase()}</span>
  }
  return <img className="icon" src={src} alt="" onError={() => setFailed(true)} />
}

function FeedRow({ label, icon, unread, active, indent, dataScope, onClick }) {
  return (
    <button
      className={`row${active ? ' active' : ''}${indent ? ' indent' : ''}`}
      data-scope={dataScope}
      onClick={onClick}
    >
      {icon !== undefined && <Icon src={icon} name={label} />}
      <span className="label">{label}</span>
      {unread > 0 && <span className="badge">{unread > 999 ? '999+' : unread}</span>}
    </button>
  )
}

function Sidebar({ feeds, scope, onSelect, onReorder, navRef, onRowFocus }) {
  const [dragGid, setDragGid] = useState(null)
  const [dropBefore, setDropBefore] = useState(null)
  if (!feeds) return <nav className="sidebar" ref={navRef} />
  const dragHandlers = (gid, index) => ({
    draggable: true,
    onDragStart: (e) => {
      setDragGid(gid)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(gid))
    },
    onDragEnd: () => {
      setDragGid(null)
      setDropBefore(null)
    },
    onDragOver: (e) => {
      if (dragGid == null || dragGid === gid) return
      e.preventDefault()
      setDropBefore(gid)
    },
    onDrop: (e) => {
      e.preventDefault()
      if (dragGid != null && dragGid !== gid) onReorder(dragGid, gid)
      setDragGid(null)
      setDropBefore(null)
    },
    'data-index': index,
  })
  return (
    <nav className="sidebar" ref={navRef} onFocusCapture={onRowFocus}>
      <div className="brand">wellsprings</div>
      <FeedRow
        label="All feeds"
        unread={feeds.totalUnread}
        active={scope.type === 'all'}
        dataScope="all"
        onClick={() => onSelect({ type: 'all', id: null, label: 'All feeds' })}
      />
      {feeds.groups.map((g, i) => (
        <div key={'g' + g.gid} className={`group${dragGid === g.gid ? ' dragging' : ''}${dropBefore === g.gid ? ' drop-before' : ''}`} {...dragHandlers(g.gid, i)}>
          <FeedRow
            label={g.name}
            unread={g.unread}
            active={scope.type === 'group' && scope.id === g.gid}
            dataScope={`group:${g.gid}`}
            onClick={() => onSelect({ type: 'group', id: g.gid, label: g.name })}
          />
          {g.sids.map((sid) => {
            const s = feeds.sources.find((x) => x.sid === sid)
            return s ? (
              <FeedRow
                key={sid}
                indent
                label={s.name}
                icon={s.icon}
                unread={s.unread}
                active={scope.type === 'source' && scope.id === sid}
                dataScope={`source:${sid}`}
                onClick={() => onSelect({ type: 'source', id: sid, label: s.name })}
              />
            ) : null
          })}
        </div>
      ))}
      {dragGid != null && (
        <div
          className="drop-end"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            onReorder(dragGid, null)
            setDragGid(null)
            setDropBefore(null)
          }}
        />
      )}
      {feeds.loose.length > 0 && (
        <div className="group">
          <div className="group-title">Feeds</div>
          {feeds.loose.map((s) => (
            <FeedRow
              key={s.sid}
              indent
              label={s.name}
              icon={s.icon}
              unread={s.unread}
              active={scope.type === 'source' && scope.id === s.sid}
              dataScope={`source:${s.sid}`}
              onClick={() => onSelect({ type: 'source', id: s.sid, label: s.name })}
            />
          ))}
        </div>
      )}
      <footer className="hints">hjkl move · h sidebar · l grid · o open · m read · s star · u unread · M mark all · gg/G ends · , settings · ? help · r fetch</footer>
    </nav>
  )
}

function Card({ item, selected, onOpen, onStar }) {
  return (
    <article
      data-id={item._id}
      className={`card${selected ? ' selected' : ''}${item.hasRead ? ' read' : ''}`}
      onClick={() => onOpen(item._id)}
    >
      {item.thumb && (
        <div className="thumb">
          <img
            src={item.thumb}
            alt=""
            loading="lazy"
            onError={(e) => {
              e.currentTarget.parentElement.style.display = 'none'
            }}
          />
        </div>
      )}
      <div className="card-body">
        <h3>{item.title}</h3>
        {item.snippet && <p>{item.snippet}</p>}
        <footer>
          <span className="src">{item.sourceName}</span>
          <span>{relTime(item.date)}</span>
          <button
            className={item.starred ? 'star on' : 'star'}
            title="Star (s)"
            onClick={(e) => {
              e.stopPropagation()
              onStar(item._id)
            }}
          >
            {item.starred ? '★' : '☆'}
          </button>
        </footer>
      </div>
      {!item.hasRead && <span className="dot" />}
    </article>
  )
}

export default function App() {
  const [feeds, setFeeds] = useState(null)
  const [scope, setScope] = useState({ type: 'all', id: null, label: 'All feeds' })
  const [unreadOnly, setUnreadOnly] = useState(true)
  const [items, setItems] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [article, setArticle] = useState(null)
  const [fetching, setFetching] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(null)
  const [cols, setCols] = useState(() => {
    const v = localStorage.getItem('feeds.cols')
    return ['1', '2', '3', '4'].includes(v) ? v : 'auto'
  })
  const [autoCols, setAutoCols] = useState(1)
  const [query, setQuery] = useState('')

  const listRef = useRef(null)
  const contentCache = useRef(new Map())
  const sideRef = useRef(null)

  const feedsRef = useRef(feeds)
  feedsRef.current = feeds
  const itemsRef = useRef(items)
  itemsRef.current = items
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  const hasMoreRef = useRef(hasMore)
  hasMoreRef.current = hasMore
  const articleRef = useRef(article)
  articleRef.current = article
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const unreadOnlyRef = useRef(unreadOnly)
  unreadOnlyRef.current = unreadOnly
  const searchRef = useRef(null)
  const queryRef = useRef(query)
  queryRef.current = query
  const searchingRef = useRef(false)

  useEffect(() => {
    localStorage.setItem('feeds.cols', cols)
  }, [cols])

  // Auto column count follows the width of the list area.
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const compute = () => {
      const w = el.clientWidth
      setAutoCols(w >= 2100 ? 4 : w >= 1400 ? 3 : w >= 860 ? 2 : 1)
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Theme follows the current Omarchy theme (colors.toml), re-applied live
  // when `omarchy theme set` changes it.
  useEffect(() => {
    const apply = (t) => {
      const root = document.documentElement
      for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v)
    }
    getTheme().then(apply).catch(() => {})
    let unlisten
    listen('theme-changed', (e) => apply(e.payload)).then((u) => { unlisten = u })
    return () => { if (unlisten) unlisten() }
  }, [])

  const findItem = (id) =>
    itemsRef.current.find((i) => i._id === id) ??
    (articleRef.current?.item?._id === id ? articleRef.current.item : null)

  const loadItems = useCallback((offset = 0, append = false) => {
    const { scope, unread } = { scope: scopeRef.current, unread: unreadOnlyRef.current }
    return getItems(scope, unread, PAGE, offset).then(({ items: next, hasMore: more }) => {
      const prev = itemsRef.current
      const seen = new Set(prev.map((p) => p._id))
      const add = next.filter((n) => !seen.has(n._id))
      setItems(append ? [...prev, ...add] : next)
      setHasMore(more)
      setLoaded(true)
      setError(null)
      return add.length
    }).catch((err) => {
      setLoaded(true)
      setError(String(err.message || err))
      return 0
    })
  }, [])

  // While a search query is active the grid shows FTS results instead of the
  // scope list; scope and unread changes are ignored until it is cleared.
  useEffect(() => {
    const q = query.trim()
    if (q) {
      searchingRef.current = true
      setArticle(null)
      setSelectedId(null)
      setLoaded(false)
      const t = setTimeout(() => {
        search(q)
          .then(({ items: next }) => {
            setItems(next)
            setHasMore(false)
            setLoaded(true)
            setError(null)
          })
          .catch((err) => {
            setLoaded(true)
            setError(String(err.message || err))
          })
      }, 220)
      return () => clearTimeout(t)
    }
    if (searchingRef.current) {
      searchingRef.current = false
      setArticle(null)
      setSelectedId(null)
      setLoaded(false)
      setItems([])
      loadItems()
    }
  }, [query, loadItems])

  useEffect(() => {
    if (queryRef.current.trim()) return
    setArticle(null)
    setSelectedId(null)
    setLoaded(false)
    setItems([])
    loadItems()
  }, [loadItems, scope, unreadOnly])

  const loadFeeds = useCallback(() => getFeeds().then(setFeeds).catch(console.error), [])
  useEffect(() => {
    loadFeeds()
    const t = setInterval(loadFeeds, 60e3)
    return () => clearInterval(t)
  }, [loadFeeds])

  const bumpUnread = (sid, delta) =>
    setFeeds((f) => {
      if (!f) return f
      const sources = f.sources.map((s) => (s.sid === sid ? { ...s, unread: Math.max(0, s.unread + delta) } : s))
      const groups = f.groups.map((g) =>
        g.sids.includes(sid) ? { ...g, unread: Math.max(0, g.unread + delta) } : g
      )
      return { ...f, sources, groups, totalUnread: Math.max(0, f.totalUnread + delta) }
    })

  const markRead = useCallback((id, value) => {
    const item = findItem(id)
    if (!item || !!item.hasRead === value) return
    setItems((list) => list.map((i) => (i._id === id ? { ...i, hasRead: value ? 1 : 0 } : i)))
    setArticle((a) => (a && a.item?._id === id ? { ...a, item: { ...a.item, hasRead: value ? 1 : 0 } } : a))
    bumpUnread(item.source, value ? -1 : 1)
    patchItem(id, { hasRead: value }).catch(() => {
      setItems((list) => list.map((i) => (i._id === id ? { ...i, hasRead: item.hasRead } : i)))
      bumpUnread(item.source, value ? 1 : -1)
    })
  }, [])

  const star = useCallback((id) => {
    const item = findItem(id)
    if (!item) return
    const value = !item.starred
    setItems((list) => list.map((i) => (i._id === id ? { ...i, starred: value ? 1 : 0 } : i)))
    setArticle((a) => (a && a.item?._id === id ? { ...a, item: { ...a.item, starred: value ? 1 : 0 } } : a))
    patchItem(id, { starred: value }).catch(() => {
      setItems((list) => list.map((i) => (i._id === id ? { ...i, starred: item.starred } : i)))
    })
  }, [])

  const scrollToId = (id) =>
    requestAnimationFrame(() => {
      listRef.current?.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
    })

  const loadArticle = useCallback((id) => {
    const listItem = itemsRef.current.find((i) => i._id === id)
    const cached = contentCache.current.get(id)
    if (listItem && cached != null) {
      setArticle({ item: { ...listItem, content: cached }, content: cached })
      return
    }
    setArticle((a) => (a?.item?._id === id ? a : { loading: true }))
    getItem(id)
      .then((item) => {
        contentCache.current.set(id, item.content)
        setArticle({ item, content: item.content })
      })
      .catch(() => setArticle(null))
  }, [])

  const select = useCallback((id) => {
    setSelectedId(id)
    scrollToId(id)
  }, [])

  const loadMore = useCallback(
    (cb) => {
      const p = loadItems(itemsRef.current.length, true)
      return p.then((added) => {
        if (cb && added > 0) requestAnimationFrame(() => cb())
      })
    },
    [loadItems]
  )
  const loadMoreRef = useRef(loadMore)
  loadMoreRef.current = loadMore

  const focusSidebar = useCallback(() => {
    const rows = [...(sideRef.current?.querySelectorAll('[data-scope]') ?? [])]
    const s = scopeRef.current
    const key = s.type === 'all' ? 'all' : `${s.type}:${s.id}`
    const row = rows.find((r) => r.dataset.scope === key) ?? rows[0]
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: 'nearest' })
  }, [])

  const returnToGrid = useCallback(() => {
    if (sideRef.current?.contains(document.activeElement)) document.activeElement.blur()
    const list = itemsRef.current
    const id = list.some((i) => i._id === selectedRef.current) ? selectedRef.current : list[0]?._id
    if (id != null) select(id)
  }, [select])

  // Spatial grid navigation: h/j/k/l move between cards left/down/up/right
  // following the row-major card grid. Edges stay put; moving down past the
  // loaded items still triggers load-more and retries.
  const gridMove = useCallback(
    (dir) => {
      const list = itemsRef.current
      const n = articleRef.current ? 1 : (cols === 'auto' ? autoCols : Number(cols)) || 1
      const idx = list.findIndex((i) => i._id === selectedRef.current)
      if (dir === 'left' && (idx === -1 || idx % n === 0)) {
        focusSidebar()
        return
      }
      if (!list.length) return
      if (idx === -1) {
        select(list[0]._id)
        if (articleRef.current) loadArticle(list[0]._id)
        return
      }
      const col = idx % n
      let next = null
      if (dir === 'left' && col > 0) next = idx - 1
      else if (dir === 'right' && col < n - 1) next = idx + 1
      else if (dir === 'up' && idx >= n) next = idx - n
      else if (dir === 'down') next = idx + n
      if (next == null) return // edge: stay put
      if (next >= list.length) {
        if (hasMoreRef.current) {
          loadMoreRef.current(() => gridMove(dir))
          return
        }
        return // bottom edge: stay put
      }
      select(list[next]._id)
      if (articleRef.current) loadArticle(list[next]._id)
    },
    [cols, autoCols, select, loadArticle, focusSidebar]
  )

  const open = useCallback(
    (id) => {
      select(id)
      const item = findItem(id)
      if (item && !item.hasRead) markRead(id, true)
      loadArticle(id)
    },
    [select, markRead, loadArticle]
  )

  // gg/G: jump to the top or bottom of the loaded list. G stops at the last
  // loaded item; j keeps paging further down.
  const jumpListEdge = useCallback(
    (which) => {
      const list = itemsRef.current
      if (!list.length) return
      const id = which === 'top' ? list[0]._id : list[list.length - 1]._id
      select(id)
      if (articleRef.current) loadArticle(id)
    },
    [select, loadArticle]
  )

  // Mark every visible item in the current scope read, then resync the list
  // and sidebar counts. Any open article belongs to this scope, so it flips
  // to read in place.
  const markAllScopeRead = useCallback(async () => {
    try {
      await markAllRead(scopeRef.current)
    } catch {
      return
    }
    loadFeeds()
    loadItems()
    setArticle((a) => (a && a.item ? { ...a, item: { ...a.item, hasRead: 1 } } : a))
  }, [loadFeeds, loadItems])
  const markAllScopeReadRef = useRef(markAllScopeRead)
  markAllScopeReadRef.current = markAllScopeRead

  const refresh = useCallback(async () => {
    setFetching(true)
    try {
      await triggerFetch()
    } catch {
      // keep the UI responsive even if the fetch fails
    }
    setFetching(false)
    loadFeeds()
    // During an active search, refresh re-runs the query instead of the
    // scope list, so new items show up without losing the results.
    if (searchingRef.current) {
      const q = queryRef.current.trim()
      if (q) {
        search(q)
          .then(({ items: next }) => {
            setItems(next)
            setHasMore(false)
            setLoaded(true)
          })
          .catch(() => {})
      }
    } else {
      loadItems()
    }
  }, [loadFeeds, loadItems])
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // After settings mutations: refresh the sidebar, and if the change removed
  // the feed the current scope points at, fall back to all feeds.
  const reloadAfterSettings = useCallback(
    (removedSid) => {
      loadFeeds()
      const s = scopeRef.current
      if (removedSid != null && s?.type === 'source' && s.id === removedSid) {
        setScope({ type: 'all', id: null, label: 'All feeds' })
      } else {
        loadItems()
      }
    },
    [loadFeeds, loadItems]
  )

  // Sidebar group order: optimistic repaint, persist, then resync from the DB.
  const applyGroupOrder = useCallback(
    (fromGid, beforeGid) => {
      const f = feedsRef.current
      if (!f || fromGid == null) return
      const rest = f.groups.map((g) => g.gid).filter((id) => id !== fromGid)
      const idx = beforeGid == null ? rest.length : rest.indexOf(beforeGid)
      if (idx === -1) return
      rest.splice(idx, 0, fromGid)
      setFeeds({ ...f, groups: rest.map((id) => f.groups.find((g) => g.gid === id)) })
      reorderGroups(rest).then(loadFeeds).catch(loadFeeds)
    },
    [loadFeeds]
  )

  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef(settingsOpen)
  settingsRef.current = settingsOpen
  const [helpOpen, setHelpOpen] = useState(false)
  const helpRef = useRef(helpOpen)
  helpRef.current = helpOpen
  const [confirmMarkAll, setConfirmMarkAll] = useState(false)
  const confirmMarkAllRef = useRef(confirmMarkAll)
  confirmMarkAllRef.current = confirmMarkAll
  const pendingGRef = useRef(false) // first press of a g g chord

  useEffect(() => {
    const handler = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key !== 'g') pendingGRef.current = false
      if (settingsRef.current) {
        if (e.key === 'Escape') setSettingsOpen(false)
        return
      }
      if (helpRef.current) {
        if (e.key === 'Escape') setHelpOpen(false)
        return
      }
      if (confirmMarkAllRef.current) {
        if (e.key === 'Escape') setConfirmMarkAll(false)
        return
      }
      const rows = [...(sideRef.current?.querySelectorAll('[data-scope]') ?? [])]
      const sideIndex = rows.indexOf(document.activeElement)
      if (sideIndex !== -1) {
        let target
        switch (e.key) {
          case 'j':
          case 'ArrowDown':
            target = rows[Math.min(sideIndex + 1, rows.length - 1)]
            break
          case 'k':
          case 'ArrowUp':
            target = rows[Math.max(sideIndex - 1, 0)]
            break
          case 'h':
          case 'ArrowLeft':
            target = rows[sideIndex].dataset.scope.startsWith('source:')
              ? rows[sideIndex].closest('.group')?.querySelector('[data-scope^="group:"]') ?? rows[0]
              : rows[0]
            break
          case 'l':
          case 'ArrowRight':
          case 'Escape':
            e.preventDefault()
            returnToGrid()
            return
          case 'o':
          case 'Enter':
          case ' ':
            e.preventDefault()
            setQuery('')
            rows[sideIndex].click()
            return
          case 'm':
          case 's':
            return // Article actions must not affect a stale grid selection.
        }
        if (target) {
          e.preventDefault()
          target.focus({ preventScroll: true })
          target.scrollIntoView({ block: 'nearest' })
          return
        }
      }
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault()
          gridMove('down')
          break
        case 'k':
        case 'ArrowUp':
          e.preventDefault()
          gridMove('up')
          break
        case 'h':
        case 'ArrowLeft':
          e.preventDefault()
          gridMove('left')
          break
        case 'l':
        case 'ArrowRight':
          e.preventDefault()
          gridMove('right')
          break
        case 'o':
          open(selectedRef.current)
          break
        case '/':
          e.preventDefault()
          searchRef.current?.focus()
          break
        case 'Enter':
          if (tag === 'BUTTON') break
          open(selectedRef.current)
          break
        case 'Escape':
          setArticle(null)
          break
        case 'm': {
          const id = selectedRef.current
          if (id != null) {
            const it = findItem(id)
            if (it) markRead(id, !it.hasRead)
          }
          break
        }
        case 's': {
          const id = selectedRef.current
          if (id != null) star(id)
          break
        }
        case 'u':
          e.preventDefault()
          setUnreadOnly((v) => !v)
          break
        case 'r':
          e.preventDefault()
          refreshRef.current()
          break
        case ',':
          e.preventDefault()
          setSettingsOpen(true)
          break
        case '?':
          e.preventDefault()
          setHelpOpen(true)
          break
        case 'M': {
          // Bulk action: confirm first, and never run it over search results
          // (the command marks the whole scope, not just matching items).
          if (searchingRef.current) break
          setConfirmMarkAll(true)
          break
        }
        case 'g':
          if (pendingGRef.current) {
            pendingGRef.current = false
            jumpListEdge('top')
          } else {
            pendingGRef.current = true
          }
          break
        case 'G':
          jumpListEdge('bottom')
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [gridMove, open, markRead, star, returnToGrid, jumpListEdge])

  const effectiveCols = article ? 1 : cols === 'auto' ? autoCols : Number(cols)

  return (
    <div id="app" className={article ? 'with-article' : ''}>
      <Sidebar
        feeds={feeds}
        scope={scope}
        navRef={sideRef}
        onSelect={setScope}
        onRowFocus={(e) => e.target.scrollIntoView({ block: 'nearest' })}
        onReorder={applyGroupOrder}
      />
      <section className="list-pane" onPointerDown={() => {
        if (sideRef.current?.contains(document.activeElement)) returnToGrid()
      }}>
        <header className="list-head">
          <h2>{query.trim() ? `Search: ${query.trim()}` : scope.label}</h2>
          <div className="tools">
            <input
              ref={searchRef}
              className="search"
              type="search"
              placeholder="search (/)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setQuery('')
                  e.target.blur()
                }
              }}
            />
            <div className="seg" title="Columns (A = auto, scales with screen width)">
              {['auto', '1', '2', '3', '4'].map((v) => (
                <button key={v} className={`seg-btn${cols === v ? ' on' : ''}`} onClick={() => setCols(v)}>
                  {v === 'auto' ? 'A' : v}
                </button>
              ))}
            </div>
            <button className={unreadOnly ? 'toggle on' : 'toggle'} onClick={() => setUnreadOnly((v) => !v)}>
              unread
            </button>
            <button className="toggle" onClick={() => refreshRef.current()} disabled={fetching}>
              {fetching ? 'fetching…' : 'fetch'}
            </button>
            <button className="toggle" onClick={() => setSettingsOpen(true)}>
              settings
            </button>
          </div>
        </header>
        {error && <div className="error">{error}</div>}
        <div className={`items${effectiveCols > 1 ? ` cols-${effectiveCols}` : ''}`} ref={listRef}>
          {items.map((item) => (
            <Card key={item._id} item={item} selected={item._id === selectedId} onOpen={open} onStar={star} />
          ))}
          {loaded && items.length === 0 && !error && <div className="empty">Nothing here</div>}
          {!loaded && <div className="empty">loading…</div>}
          {hasMore && (
            <button className="more" onClick={() => loadMoreRef.current()}>
              Load more
            </button>
          )}
        </div>
      </section>
      {article && (
        <aside className="article-pane" onPointerDown={() => {
          if (sideRef.current?.contains(document.activeElement)) returnToGrid()
        }}>
          {article.loading ? (
            <div className="empty">loading…</div>
          ) : (
            <>
              <header className="article-head">
                <div className="meta">
                  {article.item.sourceName} · {new Date(article.item.date).toLocaleString()}
                </div>
                <div className="actions">
                  <button
                    className={article.item.starred ? 'toggle on' : 'toggle'}
                    onClick={() => star(article.item._id)}
                  >
                    {article.item.starred ? '★ starred' : '☆ star'}
                  </button>
                  <button
                    className="toggle"
                    onClick={() => markRead(article.item._id, !article.item.hasRead)}
                  >
                    {article.item.hasRead ? 'mark unread' : 'mark read'}
                  </button>
                  <button className="toggle" onClick={() => setArticle(null)}>
                    close
                  </button>
                </div>
              </header>
              <h1>
                <a href={article.item.link} target="_blank" rel="noreferrer">
                  {article.item.title}
                </a>
              </h1>
              <div className="content" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(article.content) }} />
            </>
          )}
        </aside>
      )}
      {settingsOpen && (
        <Settings
          feeds={feeds}
          onClose={() => setSettingsOpen(false)}
          onChanged={reloadAfterSettings}
          onReorder={applyGroupOrder}
        />
      )}
      {helpOpen && <Shortcuts onClose={() => setHelpOpen(false)} />}
      {confirmMarkAll && (
        <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setConfirmMarkAll(false)}>
          <div className="sheet confirm">
            <h3>Mark all read</h3>
            <p className="hint">Mark everything in “{scope.label}” as read?</p>
            <div className="sheet-actions">
              <button className="toggle" onClick={() => { setConfirmMarkAll(false); markAllScopeReadRef.current() }}>
                Mark all read
              </button>
              <button className="toggle" onClick={() => setConfirmMarkAll(false)}>Keep unread</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
