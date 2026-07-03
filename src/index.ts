import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
  ASSETS: Fetcher
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// ============ Config ============

// A pool of realistic desktop + mobile User-Agents. We rotate them so that
// sites (and Google) are less likely to fingerprint us as a single bot.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
]

function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
}

// ============ Ping engine ============

type PingOutcome = {
  status: 'up' | 'down'
  httpStatus: number | null
  responseTimeMs: number
  error: string | null
  note: string | null // e.g. "auth-redirect (reachable)"
}

/**
 * Perform a single HTTP visit to a URL.
 * Smart behaviours:
 *  - Rotating User-Agent
 *  - Reads part of the body so the visit counts as a real page-load
 *  - Optional keyword validation (page must contain a given string)
 *  - Auth-aware: a redirect to a login / accounts page is treated as
 *    "reachable" (the server IS awake) rather than a hard failure.
 */
async function pingOnce(
  url: string,
  method: string,
  timeoutMs: number,
  extraHeaders: Record<string, string>,
  keyword: string | null
): Promise<PingOutcome> {
  const start = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs || 15000, 45000))

    const res = await fetch(url, {
      method: method || 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': pickUserAgent(),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        ...extraHeaders,
      },
    })
    clearTimeout(timer)

    // Read (a slice of) the body so it counts as a real load and lets us
    // run keyword validation.
    let bodyText = ''
    try {
      const buf = await res.arrayBuffer()
      // Only decode the first ~64KB for keyword checks — enough for <title>/markers.
      const slice = buf.byteLength > 65536 ? buf.slice(0, 65536) : buf
      bodyText = new TextDecoder('utf-8', { fatal: false }).decode(slice)
    } catch {}

    const elapsed = Date.now() - start
    const finalUrl = res.url || url

    // Detect auth / login redirects (Google accounts, generic /login etc.)
    const isAuthRedirect =
      /accounts\.google\.com|\/signin|\/login|ServiceLogin|oauth|authredirect/i.test(finalUrl)

    // Keyword validation (if requested): the page must contain the keyword.
    if (keyword && res.status >= 200 && res.status < 400 && !isAuthRedirect) {
      if (!bodyText.toLowerCase().includes(keyword.toLowerCase())) {
        return {
          status: 'down',
          httpStatus: res.status,
          responseTimeMs: elapsed,
          error: `الكلمة المفتاحية "${keyword}" غير موجودة في الصفحة`,
          note: 'keyword-missing',
        }
      }
    }

    const okStatus = res.status >= 200 && res.status < 400

    if (isAuthRedirect) {
      // The server answered and pushed us to a login page — it IS alive.
      return {
        status: 'up',
        httpStatus: res.status,
        responseTimeMs: elapsed,
        error: null,
        note: 'auth-redirect (الموقع صاحٍ — يطلب تسجيل دخول)',
      }
    }

    return {
      status: okStatus ? 'up' : 'down',
      httpStatus: res.status,
      responseTimeMs: elapsed,
      error: okStatus ? null : `HTTP ${res.status}`,
      note: null,
    }
  } catch (e: any) {
    return {
      status: 'down',
      httpStatus: null,
      responseTimeMs: Date.now() - start,
      error: e?.name === 'AbortError' ? 'Timeout - انتهت مهلة الاتصال' : String(e?.message || e),
      note: null,
    }
  }
}

/**
 * Ping with smart retries: if the first attempt fails, retry up to `retries`
 * times with a short backoff before declaring the link down. This removes
 * false "down" reports from transient network blips.
 */
async function pingUrl(
  url: string,
  method: string,
  timeoutMs: number,
  headersJson: string,
  keyword: string | null,
  retries = 2
): Promise<PingOutcome> {
  let extraHeaders: Record<string, string> = {}
  try {
    extraHeaders = JSON.parse(headersJson || '{}')
  } catch {}

  let last: PingOutcome | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const outcome = await pingOnce(url, method, timeoutMs, extraHeaders, keyword)
    if (outcome.status === 'up') return outcome
    last = outcome
    if (attempt < retries) {
      // brief backoff: 400ms, 800ms ...
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
    }
  }
  return last as PingOutcome
}

async function runChecks(env: Bindings, force = false): Promise<any[]> {
  const query = force
    ? `SELECT * FROM links WHERE enabled = 1`
    : `SELECT * FROM links WHERE enabled = 1 AND (
         last_checked_at IS NULL OR
         datetime(last_checked_at, '+' || interval_minutes || ' minutes') <= datetime('now')
       )`
  const { results: links } = await env.DB.prepare(query).all()
  if (!links || links.length === 0) return []

  const outcomes: any[] = []

  await Promise.all(
    (links as any[]).map(async (link: any) => {
      const result = await pingUrl(
        link.url,
        link.method,
        link.timeout_ms,
        link.headers_json,
        link.keyword || null
      )
      outcomes.push({ link_id: link.id, name: link.name, url: link.url, ...result })

      // Track consecutive-failure streak for smarter alerting.
      let fails = link.consecutive_fails || 0
      fails = result.status === 'up' ? 0 : fails + 1

      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO checks (link_id, status, http_status, response_time_ms, error, note) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(link.id, result.status, result.httpStatus, result.responseTimeMs, result.error, result.note),
        env.DB.prepare(
          `UPDATE links SET last_checked_at = datetime('now'), consecutive_fails = ? WHERE id = ?`
        ).bind(fails, link.id),
      ])
    })
  )

  // Prune: keep only latest 100 checks per link.
  await env.DB.prepare(
    `DELETE FROM checks WHERE id NOT IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY link_id ORDER BY id DESC) AS rn FROM checks
       ) WHERE rn <= 100
     )`
  )
    .run()
    .catch(() => {})

  return outcomes
}

// ============ API Routes ============

app.get('/api/links', async (c) => {
  const { results: links } = await c.env.DB.prepare(`SELECT * FROM links ORDER BY id DESC`).all()

  const enriched = await Promise.all(
    (links || []).map(async (link: any) => {
      const latest = await c.env.DB.prepare(
        `SELECT status, http_status, response_time_ms, error, note, checked_at FROM checks WHERE link_id = ? ORDER BY id DESC LIMIT 1`
      )
        .bind(link.id)
        .first()

      const stats = await c.env.DB.prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up_count,
           AVG(CASE WHEN status = 'up' THEN response_time_ms END) AS avg_response,
           MIN(CASE WHEN status = 'up' THEN response_time_ms END) AS min_response,
           MAX(CASE WHEN status = 'up' THEN response_time_ms END) AS max_response
         FROM checks WHERE link_id = ?`
      )
        .bind(link.id)
        .first()

      const s: any = stats || {}
      return {
        ...link,
        latest_check: latest || null,
        uptime_percent: s.total > 0 ? Math.round((s.up_count / s.total) * 100) : null,
        avg_response_ms: s.avg_response ? Math.round(s.avg_response) : null,
        min_response_ms: s.min_response ? Math.round(s.min_response) : null,
        max_response_ms: s.max_response ? Math.round(s.max_response) : null,
        total_checks: s.total || 0,
      }
    })
  )

  return c.json({ links: enriched })
})

app.post('/api/links', async (c) => {
  const body = await c.req.json()
  let { name, url, interval_minutes, method, timeout_ms, headers_json, keyword } = body

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
    `INSERT INTO links (name, url, interval_minutes, method, timeout_ms, headers_json, keyword) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(linkName, url, interval, method || 'GET', parseInt(timeout_ms) || 15000, headers_json || '{}', (keyword || '').trim() || null)
    .run()

  const linkId = result.meta.last_row_id

  const check = await pingUrl(url, method || 'GET', parseInt(timeout_ms) || 15000, headers_json || '{}', (keyword || '').trim() || null)
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO checks (link_id, status, http_status, response_time_ms, error, note) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(linkId, check.status, check.httpStatus, check.responseTimeMs, check.error, check.note),
    c.env.DB.prepare(`UPDATE links SET last_checked_at = datetime('now'), consecutive_fails = ? WHERE id = ?`).bind(check.status === 'up' ? 0 : 1, linkId),
  ])

  return c.json({ id: linkId, name: linkName, url, first_check: check })
})

app.put('/api/links/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const { name, url, interval_minutes, method, timeout_ms, headers_json, enabled, keyword } = body

  const existing = await c.env.DB.prepare(`SELECT * FROM links WHERE id = ?`).bind(id).first()
  if (!existing) return c.json({ error: 'الرابط غير موجود' }, 404)

  let newUrl = url !== undefined ? String(url).trim() : (existing as any).url
  if (newUrl && !/^https?:\/\//i.test(newUrl)) newUrl = 'https://' + newUrl

  await c.env.DB.prepare(
    `UPDATE links SET
       name = ?, url = ?, interval_minutes = ?, method = ?, timeout_ms = ?, headers_json = ?, enabled = ?, keyword = ?
     WHERE id = ?`
  )
    .bind(
      name !== undefined ? name : (existing as any).name,
      newUrl,
      interval_minutes !== undefined ? Math.max(1, Math.min(parseInt(interval_minutes) || 5, 1440)) : (existing as any).interval_minutes,
      method !== undefined ? method : (existing as any).method,
      timeout_ms !== undefined ? parseInt(timeout_ms) || 15000 : (existing as any).timeout_ms,
      headers_json !== undefined ? headers_json : (existing as any).headers_json,
      enabled !== undefined ? (enabled ? 1 : 0) : (existing as any).enabled,
      keyword !== undefined ? (String(keyword).trim() || null) : (existing as any).keyword,
      id
    )
    .run()

  return c.json({ success: true })
})

app.delete('/api/links/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM checks WHERE link_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM links WHERE id = ?`).bind(id),
  ])
  return c.json({ success: true })
})

app.get('/api/links/:id/checks', async (c) => {
  const id = c.req.param('id')
  const limit = Math.min(parseInt(c.req.query('limit') || '30'), 100)
  const { results } = await c.env.DB.prepare(
    `SELECT status, http_status, response_time_ms, error, note, checked_at FROM checks WHERE link_id = ? ORDER BY id DESC LIMIT ?`
  )
    .bind(id, limit)
    .all()
  return c.json({ checks: results || [] })
})

app.post('/api/links/:id/check', async (c) => {
  const id = c.req.param('id')
  const link: any = await c.env.DB.prepare(`SELECT * FROM links WHERE id = ?`).bind(id).first()
  if (!link) return c.json({ error: 'الرابط غير موجود' }, 404)

  const result = await pingUrl(link.url, link.method, link.timeout_ms, link.headers_json, link.keyword || null)
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO checks (link_id, status, http_status, response_time_ms, error, note) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, result.status, result.httpStatus, result.responseTimeMs, result.error, result.note),
    c.env.DB.prepare(`UPDATE links SET last_checked_at = datetime('now'), consecutive_fails = ? WHERE id = ?`).bind(result.status === 'up' ? 0 : (link.consecutive_fails || 0) + 1, id),
  ])

  return c.json(result)
})

app.get('/api/tick', async (c) => {
  const results = await runChecks(c.env, false)
  return c.json({ ran: results.length, results })
})

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

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runChecks(env, false))
  },
}
