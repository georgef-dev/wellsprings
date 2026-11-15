import { useCallback, useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { listen } from '@tauri-apps/api/event'
import { getFeeds, getItems, getItem, patchItem, getTheme, triggerFetch, reorderGroups } from './api'
import Settings from './Settings'

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

function FeedRow({ label, icon, unread, active, indent, onClick }) {
  return (
    <button className={`row${active ? ' active' : ''}${indent ? ' indent' : ''}`} onClick={onClick}>
      {icon !== undefined && <Icon src={icon} name={label} />}
      <span className="label">{label}</span>
      {unread > 0 && <span className="badge">{unread > 999 ? '999+' : unread}</span>}
    </button>
  )
}

function Sidebar({ feeds, scope, onSelect, onReorder }) {
  const [dragGid, setDragGid] = useState(null)
  const [dropBefore, setDropBefore] = useState(null)
  if (!feeds) return <nav className="sidebar" />
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
    <nav className="sidebar">
      <div className="brand">wellsprings</div>
      <FeedRow
        label="All feeds"
        unread={feeds.totalUnread}
        active={scope.type === 'all'}
        onClick={() => onSelect({ type: 'all', id: null, label: 'All feeds' })}
      />
      {feeds.groups.map((g, i) => (
        <div key={'g' + g.gid} className={`group${dragGid === g.gid ? ' dragging' : ''}${dropBefore === g.gid ? ' drop-before' : ''}`} {...dragHandlers(g.gid, i)}>
          <FeedRow
            label={g.name}
            unread={g.unread}
            active={scope.type === 'group' && scope.id === g.gid}
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
              onClick={() => onSelect({ type: 'source', id: s.sid, label: s.name })}
            />
          ))}
        </div>
      )}
      <footer className="hints">hjkl move · o open · m read · s star · u unread · r fetch</footer>
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

  const listRef = useRef(null)
  const contentCache = useRef(new Map())

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

  useEffect(() => {
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

  // Spatial grid navigation: h/j/k/l move between cards left/down/up/right
  // following the row-major card grid. Edges stay put; moving down past the
  // loaded items still triggers load-more and retries.
  const gridMove = useCallback(
    (dir) => {
      const list = itemsRef.current
      if (!list.length) return
      const idx = list.findIndex((i) => i._id === selectedRef.current)
      if (idx === -1) {
        select(list[0]._id)
        if (articleRef.current) loadArticle(list[0]._id)
        return
      }
      const n = articleRef.current ? 1 : (cols === 'auto' ? autoCols : Number(cols)) || 1
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
    [cols, autoCols, select, loadArticle]
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

  const refresh = useCallback(async () => {
    setFetching(true)
    try {
      await triggerFetch()
    } catch {
      // keep the UI responsive even if the fetch fails
    }
    setFetching(false)
    loadFeeds()
    loadItems()
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

  useEffect(() => {
    const handler = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (settingsRef.current) {
        if (e.key === 'Escape') setSettingsOpen(false)
        return
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
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [gridMove, open, markRead, star])

  const effectiveCols = article ? 1 : cols === 'auto' ? autoCols : Number(cols)

  return (
    <div id="app" className={article ? 'with-article' : ''}>
      <Sidebar feeds={feeds} scope={scope} onSelect={setScope} onReorder={applyGroupOrder} />
      <section className="list-pane">
        <header className="list-head">
          <h2>{scope.label}</h2>
          <div className="tools">
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
        <aside className="article-pane">
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
    </div>
  )
}
