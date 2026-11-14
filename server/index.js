import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, listFeeds, listItems, getItem, patchItem, readFetchInterval } from './db.js'
import { themeVars } from './theme.js'
import { fetchAll } from './fetcher.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = 8787

const db = openDb()
const app = Fastify({ logger: false })

app.get('/api/theme', async () => themeVars())

app.get('/api/feeds', async () => listFeeds(db))

app.get('/api/items', async (req) => {
  const q = req.query ?? {}
  const [type, rawId] = String(q.scope ?? 'all').split(':')
  const scope = { type: type === 'group' || type === 'source' ? type : 'all', id: rawId ? Number(rawId) : null }
  const unread = q.unread === '1'
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200)
  const offset = Math.max(Number(q.offset) || 0, 0)
  return listItems(db, { scope, unread, limit, offset })
})

app.get('/api/items/:id', async (req, reply) => {
  const item = getItem(db, Number(req.params.id))
  if (!item) return reply.code(404).send({ error: 'not found' })
  return item
})

app.patch('/api/items/:id', async (req, reply) => {
  const item = patchItem(db, Number(req.params.id), req.body ?? {})
  if (!item) return reply.code(400).send({ error: 'bad patch or unknown id' })
  return { ok: true, item }
})

app.post('/api/fetch', async () => fetchAll(db))

const distDir = path.join(__dirname, '..', 'web', 'dist')
if (existsSync(distDir)) {
  app.register(fastifyStatic, { root: distDir })
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url.startsWith('/api')) return reply.code(404).send({ error: 'not found' })
    return reply.sendFile('index.html')
  })
} else {
  console.warn(`[feeds] ${distDir} not found; run "npm run build" to serve the UI`)
}

await app.listen({ port: PORT, host: '127.0.0.1' })
console.log(`[feeds] listening on http://127.0.0.1:${PORT}`)

const intervalMin = readFetchInterval()
fetchAll(db).catch((err) => console.error('[fetch] boot fetch failed:', err))
setInterval(() => fetchAll(db).catch((err) => console.error('[fetch] failed:', err)), intervalMin * 60_000)
