import { XMLParser } from 'fast-xml-parser'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) feeds/1.0'
const TIMEOUT_MS = 15_000

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', trimValues: true })

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function text(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object' && typeof v['#text'] === 'string') return v['#text']
  return ''
}

function arr(v) {
  return v == null ? [] : Array.isArray(v) ? v : [v]
}

function decode(s) {
  return s.replace(/&([a-z]+|#\d+);/gi, (m, c) => ENTITIES[c.toLowerCase()] ?? m)
}

function stripHtml(html) {
  return decode(
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

function linkOf(e) {
  if (typeof e.link === 'string') return e.link.trim()
  const links = arr(e.link)
  const alts = links.filter((l) => !l?.['@rel'] || l['@rel'] === 'alternate')
  return (alts[0]?.['@href'] || links[0]?.['@href'] || '').trim()
}

function dateOf(e) {
  const raw = text(e.pubDate) || text(e.published) || text(e.updated) || text(e['dc:date'])
  const t = raw ? Date.parse(raw) : NaN
  return Number.isNaN(t) ? Date.now() : t
}

function thumbOf(e, content) {
  const mt = arr(e['media:thumbnail']).map((t) => t?.['@url']).find(Boolean)
  const mc = arr(e['media:content'])
    .map((c) => (c?.['@medium'] === 'image' || /\.(png|jpe?g|webp|gif)/i.test(c?.['@url'] || '') ? c?.['@url'] : null))
    .find(Boolean)
  const en = arr(e.enclosure)
    .map((c) => (String(c?.['@type'] || '').startsWith('image/') ? c?.['@url'] : null))
    .find(Boolean)
  const inContent = content?.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1]
  return mt || mc || en || inContent || null
}

function normalize(e) {
  const link = linkOf(e)
  const guid = text(e.guid) || text(e.id) || null
  const content =
    text(e['content:encoded']) || text(e.content) || text(e.description) || text(e.summary) || ''
  return {
    title: text(e.title).trim(),
    link,
    guid,
    date: dateOf(e),
    content,
    thumb: thumbOf(e, content),
    snippet: stripHtml(content).slice(0, 300),
    creator: text(e['dc:creator']) || text(e.author?.name) || text(e.author) || null,
  }
}

async function fetchSource(db, { sid, url }) {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const doc = parser.parse(await res.text())
  const raw = arr(doc?.rss?.channel?.item ?? doc?.feed?.entry ?? doc?.['rdf:RDF']?.item)
  const entries = raw.map(normalize).filter((e) => (e.link || e.guid) && e.title)

  const known = db.prepare('SELECT guid, link FROM items WHERE source = ?').all(sid)
  const guids = new Set(known.map((r) => r.guid).filter(Boolean))
  const links = new Set(known.map((r) => r.link).filter(Boolean))

  const insert = db.prepare(
    `INSERT INTO items (source, guid, title, link, date, fetchedDate, thumb, content, snippet, creator, hasRead, starred, hidden, notify)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`
  )
  // The existence check runs inside the immediate transaction so concurrent
  // writers (Fluent Reader or another fetch pass) cannot double-insert.
  const exists = db.prepare(
    `SELECT 1 FROM items WHERE source = ? AND ((? IS NOT NULL AND (? = guid OR ? = link)) OR (? IS NULL AND link = ?)) LIMIT 1`
  )
  let inserted = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const e of entries) {
      if (exists.get(sid, e.guid, e.guid, e.guid, e.guid, e.link)) continue
      insert.run(sid, e.guid, e.title, e.link, e.date, Date.now(), e.thumb, e.content, e.snippet, e.creator)
      inserted++
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  db.prepare('UPDATE sources SET lastFetched = ? WHERE sid = ?').run(Date.now(), sid)
  return { inserted, seen: entries.length }
}

export async function fetchAll(db) {
  const sources = db.prepare('SELECT sid, url FROM sources WHERE hidden = 0').all()
  const started = Date.now()
  const results = await Promise.allSettled(sources.map((s) => fetchSource(db, s)))
  let inserted = 0
  let ok = 0
  const errors = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      inserted += r.value.inserted
      ok++
    } else {
      errors.push(`${sources[i].url}: ${r.reason?.message ?? r.reason}`)
    }
  })
  console.log(`[fetch] ${ok}/${sources.length} sources ok, ${inserted} new items in ${Date.now() - started}ms`)
  if (errors.length) console.warn('[fetch] errors:', errors.join(' | '))
  return { inserted, ok, total: sources.length, errors }
}
