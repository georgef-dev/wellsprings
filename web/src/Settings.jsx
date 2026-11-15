import { useEffect, useState } from 'react'
import {
  getSettings,
  setSetting,
  createGroup,
  renameGroup,
  deleteGroup,
  setSourceGroup,
  renameSource,
  removeSource,
  addSource,
  exportOpml,
  importOpml,
} from './api'

// Settings sheet: fetch interval, groups, and feed management. Mutations call
// onChanged(sidRemoved?) so App can reload feeds/items and escape a scope that
// points at a removed feed.
export default function Settings({ feeds, onClose, onChanged, onReorder }) {
  const [interval, setIntervalMin] = useState('')
  const [url, setUrl] = useState('')
  const [newGroup, setNewGroup] = useState('')
  const [status, setStatus] = useState(null) // { text, err }
  const [busy, setBusy] = useState(false)
  const [editingName, setEditingName] = useState(null) // { kind: 'feed'|'group', id, value }
  const [dragGid, setDragGid] = useState(null)
  const [dropBefore, setDropBefore] = useState(null)

  useEffect(() => {
    getSettings()
      .then((s) => setIntervalMin(s.fetch_interval_min ?? '30'))
      .catch(() => setIntervalMin('30'))
  }, [])

  if (!feeds) return null

  const groupOf = (sid) => feeds.groups.find((g) => g.sids.includes(sid))

  const run = async (fn, doneText, removedSid) => {
    setBusy(true)
    setStatus(null)
    try {
      await fn()
      setStatus({ text: doneText })
      onChanged(removedSid)
    } catch (err) {
      setStatus({ text: String(err.message || err), err: true })
    }
    setBusy(false)
  }

  const removeFeed = (sid, name) => {
    if (!window.confirm(`Remove "${name}" and its articles?`)) return
    run(() => removeSource(sid), '', sid)
  }

  const removeGid = (gid, name) => {
    if (!window.confirm(`Delete stream "${name}"? Feeds stay, just loose.`)) return
    run(() => deleteGroup(gid), '')
  }

  const saveName = (kind, id, value) => {
    setEditingName(null)
    const name = value.trim()
    if (!name) return
    run(
      kind === 'feed' ? () => renameSource(id, name) : () => renameGroup(id, name),
      ''
    )
  }

  const doExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const info = await exportOpml()
      setStatus({ text: `Wrote ${info.path}` })
    } catch (err) {
      setStatus({ text: String(err.message || err), err: true })
    }
    setBusy(false)
  }

  const onImportFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    setStatus(null)
    try {
      const info = await importOpml(await file.text())
      const bits = []
      if (info.feedsAdded) bits.push(`${info.feedsAdded} new feed${info.feedsAdded === 1 ? '' : 's'}`)
      if (info.streamsCreated) bits.push(`${info.streamsCreated} new stream${info.streamsCreated === 1 ? '' : 's'}`)
      if (info.streamsAssigned) bits.push(`${info.streamsAssigned} feed${info.streamsAssigned === 1 ? '' : 's'} grouped`)
      setStatus({ text: bits.length ? `Import: ${bits.join(', ')}` : 'Import: nothing new' })
      onChanged()
    } catch (err) {
      setStatus({ text: String(err.message || err), err: true })
    }
    setBusy(false)
  }

  const NameCell = ({ kind, id, name }) =>
    editingName?.kind === kind && editingName?.id === id ? (
      <input
        type="text"
        className="grow"
        autoFocus
        defaultValue={name}
        onBlur={(e) => saveName(kind, id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') saveName(kind, id, e.target.value)
          if (e.key === 'Escape') setEditingName(null)
        }}
      />
    ) : (
      <span className="name grow" title="Click to rename" onClick={() => setEditingName({ kind, id, value: name })}>
        {name}
      </span>
    )

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <h3>Fetching</h3>
        <div className="srow">
          <span>Every</span>
          <input
            type="number"
            min="1"
            max="720"
            value={interval}
            onChange={(e) => setIntervalMin(e.target.value)}
            onBlur={() => {
              const v = Math.max(1, Math.round(Number(interval) || 30))
              setIntervalMin(String(v))
              run(() => setSetting('fetch_interval_min', String(v)), `Every ${v} min from the next cycle`)
            }}
          />
          <span>minutes</span>
        </div>
        <div className="hint">Applies to the next fetch cycle. "fetch" in the toolbar is always immediate.</div>

        <h3>Add feed</h3>
        <div className="srow">
          <input
            type="text"
            className="grow"
            placeholder="https://example.com/feed.xml"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && url.trim()) {
                const u = url.trim()
                setUrl('')
                run(() => addSource(u, null), `Added ${u}`)
              }
            }}
          />
          <button
            className="toggle"
            disabled={busy || !url.trim()}
            onClick={() => {
              const u = url.trim()
              setUrl('')
              run(() => addSource(u, null), `Added ${u}`)
            }}
          >
            add
          </button>
        </div>
        <div className="hint">The feed is fetched once on add; its title becomes the name (click a name to rename).</div>

        <h3>Feeds ({feeds.sources.length})</h3>
        {feeds.sources.map((s) => {
          const g = groupOf(s.sid)
          return (
            <div className="srow" key={s.sid}>
              <NameCell kind="feed" id={s.sid} name={s.name} />
              <select
                value={g?.gid ?? ''}
                onChange={(e) => {
                  const gid = e.target.value === '' ? null : Number(e.target.value)
                  run(() => setSourceGroup(s.sid, gid), '')
                }}
              >
                <option value="">— no stream —</option>
                {feeds.groups.map((gr) => (
                  <option key={gr.gid} value={gr.gid}>
                    {gr.name}
                  </option>
                ))}
              </select>
              <button className="x" title="Remove feed" disabled={busy} onClick={() => removeFeed(s.sid, s.name)}>
                ×
              </button>
            </div>
          )
        })}

        <h3>Streams ({feeds.groups.length})</h3>
        {feeds.groups.map((g) => (
          <div
            className={`srow drag-row${dragGid === g.gid ? ' dragging' : ''}${dropBefore === g.gid ? ' drop-before' : ''}`}
            key={g.gid}
            draggable
            onDragStart={(e) => {
              setDragGid(g.gid)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', String(g.gid))
            }}
            onDragEnd={() => {
              setDragGid(null)
              setDropBefore(null)
            }}
            onDragOver={(e) => {
              if (dragGid == null || dragGid === g.gid) return
              e.preventDefault()
              setDropBefore(g.gid)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragGid != null && dragGid !== g.gid) onReorder(dragGid, g.gid)
              setDragGid(null)
              setDropBefore(null)
            }}
          >
            <NameCell kind="group" id={g.gid} name={g.name} />
            <span className="hint">{g.sids.length} feeds</span>
            <button className="x" title="Delete stream" disabled={busy} onClick={() => removeGid(g.gid, g.name)}>
              ×
            </button>
          </div>
        ))}
        {dragGid != null && (
          <div
            className="srow drop-end"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              onReorder(dragGid, null)
              setDragGid(null)
              setDropBefore(null)
            }}
          />
        )}
        <div className="srow">
          <input
            type="text"
            className="grow"
            placeholder="New stream name"
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newGroup.trim()) {
                const n = newGroup.trim()
                setNewGroup('')
                run(() => createGroup(n), `Stream "${n}" created`)
              }
            }}
          />
          <button
            className="toggle"
            disabled={busy || !newGroup.trim()}
            onClick={() => {
              const n = newGroup.trim()
              setNewGroup('')
              run(() => createGroup(n), `Stream "${n}" created`)
            }}
          >
            add
          </button>
        </div>

        <h3>OPML</h3>
        <div className="srow">
          <button className="toggle" disabled={busy} onClick={doExport}>
            export
          </button>
          <label className="toggle" title="Merge feeds and streams from an .opml file">
            import
            <input
              type="file"
              accept=".opml,.xml,text/xml,application/xml,text/plain"
              disabled={busy}
              hidden
              onChange={onImportFile}
            />
          </label>
        </div>
        <div className="hint">
          Export writes every feed and stream to ~/Downloads/wellsprings.opml. Import merges by URL: existing feeds
          stay untouched, ungrouped feeds join the file's streams, new feeds fetch on the next cycle.
        </div>

        <div className={`status${status?.err ? ' err' : ''}`}>{status?.text}</div>
        <div className="sheet-actions">
          <button className="toggle" onClick={onClose}>
            close
          </button>
        </div>
      </div>
    </div>
  )
}
