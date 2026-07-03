import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
  ASSETS: Fetcher
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// ============ Helpers ============

const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 KeepAliveBot/1.0'

async function pingUrl(
  url: string,
  method: string,
  timeoutMs: number,
  headersJson: string
): Promise<{ status: 'up' | 'down'; httpStatus: number | null; responseTimeMs: number; error: string | null }> {
  const start = Date.now()
  try {
    let extraHeaders: Record<string, string> = {}
    try {
      extraHeaders = JSON.parse(headersJson || '{}')
    } catch {}

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs || 15000, 30000))

    const res = await fetch(url, {
      method: method || 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
        'Cache-Control': 'no-cache',
        ...extraHeaders,
      },
    })
    clearTimeout(timer)

    // Read a bit of the body so the visit counts as a real page load (wakes up sleeping apps)
    try {
      await res.arrayBuffer()
    } catch {}

    const elapsed = Date.now() - start
    const ok = res.status >= 200 && res.status < 400
    return {
      status: ok ? 'up' : 'down',
      httpStatus: res.status,
      responseTimeMs: elapsed,
      error: ok ? null : `HTTP ${res.status}`,
    }
  } catch (e: any) {
    return {
      status: 'down',
      httpStatus: null,
      responseTimeMs: Date.now() - start,
      error: e?.name === 'AbortError' ? 'Timeout - انتهت مهلة الاتصال' : String(e?.message || e),
    }
  }
}

async function runChecks(env: Bindings, force = false): Promise<any[]> {
  // Get links that are due for a check based on their individual interval
  const query = force
    ? `SELECT * FROM links WHERE enabled = 1`
    : `SELECT * FROM links WHERE enabled = 1 AND (
         last_checked_at IS NULL OR
         datetime(last_checked_at, '+' || interval_minutes || ' minutes') <= datetime('now')
       )`
  const { results: links } = await env.DB.prepare(query).all()
  if (!links || links.length === 0) return []

  const outcomes: any[] = []

  // Ping all due links in parallel
  await Promise.all(
    links.map(async (link: any) => {
      const result = await pingUrl(link.url, link.method, link.timeout_ms, link.headers_json)
      outcomes.push({ link_id: link.id, name: link.name, url: link.url, ...result })

      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO checks (link_id, status, http_status, response_time_ms, error) VALUES (?, ?, ?, ?, ?)`
        ).bind(link.id, result.status, result.httpStatus, result.responseTimeMs, result.error),
        env.DB.prepare(`UPDATE links SET last_checked_at = datetime('now') WHERE id = ?`).bind(link.id),
      ])
    })
  )

  // Prune: keep only latest 100 checks per link (cleanup old history)
  await env.DB.prepare(
    `DELETE FROM checks WHERE id NOT IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY link_id ORDER BY id DESC) AS rn FROM checks
       ) WHERE rn <= 100
     )`
  ).run().catch(() => {})

  return outcomes
}

// ============ API Routes ============

// List all links with their latest status + uptime stats
app.get('/api/links', async (c) => {
  const { results: links } = await c.env.DB.prepare(`SELECT * FROM links ORDER BY id DESC`).all()

  const enriched = await Promise.all(
    (links || []).map(async (link: any) => {
      const latest = await c.env.DB.prepare(
        `SELECT status, http_status, response_time_ms, error, checked_at FROM checks WHERE link_id = ? ORDER BY id DESC LIMIT 1`
      ).bind(link.id).first()

      const stats = await c.env.DB.prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up_count,
           AVG(CASE WHEN status = 'up' THEN response_time_ms END) AS avg_response
         FROM checks WHERE link_id = ?`
      ).bind(link.id).first()

      return {
        ...link,
        latest_check: latest || null,
        uptime_percent: stats && (stats as any).total > 0 ? Math.round(((stats as any).up_count / (stats as any).total) * 100) : null,
        avg_response_ms: stats && (stats as any).avg_response ? Math.round((stats as any).avg_response) : null,
        total_checks: (stats as any)?.total || 0,
      }
    })
  )

  return c.json({ links: enriched })
})

// Add a new link
app.post('/api/links', async (c) => {
  const body = await c.req.json()
  let { name, url, interval_minutes, method, timeout_ms, headers_json } = body

  if (!url || typeof url !== 'string') return c.json({ error: 'الرابط مطلوب' }, 400)
  url = url.trim()
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url

  try {
    new URL(url)
  } catch {
    return c.json({ error: 'الرابط غير صحيح' }, 400)
  }

  const interval = Math.max(1, Math.min(parseInt(interval_minutes) || 5, 1440))
  const linkName = (name || '').trim() || new URL(url).hostname

  const result = await c.env.DB.prepare(
    `INSERT INTO links (name, url, interval_minutes, method, timeout_ms, headers_json) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(linkName, url, interval, method || 'GET', parseInt(timeout_ms) || 15000, headers_json || '{}').run()

  const linkId = result.meta.last_row_id

  // Immediately do first check
  const check = await pingUrl(url, method || 'GET', parseInt(timeout_ms) || 15000, headers_json || '{}')
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO checks (link_id, status, http_status, response_time_ms, error) VALUES (?, ?, ?, ?, ?)`
    ).bind(linkId, check.status, check.httpStatus, check.responseTimeMs, check.error),
    c.env.DB.prepare(`UPDATE links SET last_checked_at = datetime('now') WHERE id = ?`).bind(linkId),
  ])

  return c.json({ id: linkId, name: linkName, url, first_check: check })
})

// Update link settings
app.put('/api/links/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const { name, url, interval_minutes, method, timeout_ms, headers_json, enabled } = body

  const existing = await c.env.DB.prepare(`SELECT * FROM links WHERE id = ?`).bind(id).first()
  if (!existing) return c.json({ error: 'الرابط غير موجود' }, 404)

  let newUrl = url !== undefined ? String(url).trim() : (existing as any).url
  if (newUrl && !/^https?:\/\//i.test(newUrl)) newUrl = 'https://' + newUrl

  await c.env.DB.prepare(
    `UPDATE links SET
       name = ?, url = ?, interval_minutes = ?, method = ?, timeout_ms = ?, headers_json = ?, enabled = ?
     WHERE id = ?`
  ).bind(
    name !== undefined ? name : (existing as any).name,
    newUrl,
    interval_minutes !== undefined ? Math.max(1, Math.min(parseInt(interval_minutes) || 5, 1440)) : (existing as any).interval_minutes,
    method !== undefined ? method : (existing as any).method,
    timeout_ms !== undefined ? parseInt(timeout_ms) || 15000 : (existing as any).timeout_ms,
    headers_json !== undefined ? headers_json : (existing as any).headers_json,
    enabled !== undefined ? (enabled ? 1 : 0) : (existing as any).enabled,
    id
  ).run()

  return c.json({ success: true })
})

// Delete a link
app.delete('/api/links/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM checks WHERE link_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM links WHERE id = ?`).bind(id),
  ])
  return c.json({ success: true })
})

// Get check history for a link
app.get('/api/links/:id/checks', async (c) => {
  const id = c.req.param('id')
  const limit = Math.min(parseInt(c.req.query('limit') || '30'), 100)
  const { results } = await c.env.DB.prepare(
    `SELECT status, http_status, response_time_ms, error, checked_at FROM checks WHERE link_id = ? ORDER BY id DESC LIMIT ?`
  ).bind(id, limit).all()
  return c.json({ checks: results || [] })
})

// Manual check-now for one link
app.post('/api/links/:id/check', async (c) => {
  const id = c.req.param('id')
  const link: any = await c.env.DB.prepare(`SELECT * FROM links WHERE id = ?`).bind(id).first()
  if (!link) return c.json({ error: 'الرابط غير موجود' }, 404)

  const result = await pingUrl(link.url, link.method, link.timeout_ms, link.headers_json)
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO checks (link_id, status, http_status, response_time_ms, error) VALUES (?, ?, ?, ?, ?)`
    ).bind(id, result.status, result.httpStatus, result.responseTimeMs, result.error),
    c.env.DB.prepare(`UPDATE links SET last_checked_at = datetime('now') WHERE id = ?`).bind(id),
  ])

  return c.json(result)
})

// Tick endpoint: runs due checks (backup trigger — the dashboard also calls this while open)
app.get('/api/tick', async (c) => {
  const results = await runChecks(c.env, false)
  return c.json({ ran: results.length, results })
})

// Overall summary
app.get('/api/summary', async (c) => {
  const total: any = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM links WHERE enabled = 1`).first()
  const latest = await c.env.DB.prepare(
    `SELECT l.id, c.status FROM links l
     LEFT JOIN checks c ON c.id = (SELECT id FROM checks WHERE link_id = l.id ORDER BY id DESC LIMIT 1)
     WHERE l.enabled = 1`
  ).all()
  const up = (latest.results || []).filter((r: any) => r.status === 'up').length
  const down = (latest.results || []).filter((r: any) => r.status === 'down').length
  return c.json({ total: total?.n || 0, up, down })
})

// ============ Scheduled (Cron) Handler ============
// This runs every minute on Cloudflare's servers — phone can be off, links stay awake

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runChecks(env, false))
  },
}
