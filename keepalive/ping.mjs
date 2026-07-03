#!/usr/bin/env node
/**
 * Keep-Alive Pinger — يشتغل على سيرفرات GitHub Actions مجاناً
 * يقرأ الروابط من keepalive/links.json ويزور كل رابط ويسجل النتيجة في keepalive/status.json
 * يشتغل تلقائياً بجدولة GitHub Actions حتى لو موبايلك مقفول.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LINKS_FILE = join(__dirname, 'links.json');
const STATUS_FILE = join(__dirname, 'status.json');
const HISTORY_LIMIT = 50; // آخر 50 فحص لكل رابط

const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 KeepAliveBot/1.0 (GitHub-Actions)';

function loadJson(path, fallback) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`⚠️ فشل قراءة ${path}: ${e.message}`);
  }
  return fallback;
}

async function pingUrl(link) {
  const start = Date.now();
  const timeoutMs = Math.min(link.timeout_ms || 20000, 60000);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(link.url, {
      method: link.method || 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
        'Cache-Control': 'no-cache',
        ...(link.headers || {}),
      },
    });
    clearTimeout(timer);
    // نقرأ جزء من الجسم عشان الزيارة تتحسب زيارة حقيقية (تصحّي التطبيقات النايمة)
    try { await res.arrayBuffer(); } catch {}
    const elapsed = Date.now() - start;
    const ok = res.status >= 200 && res.status < 400;
    return {
      status: ok ? 'up' : 'down',
      http_status: res.status,
      response_time_ms: elapsed,
      error: ok ? null : `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      status: 'down',
      http_status: null,
      response_time_ms: Date.now() - start,
      error: e?.name === 'AbortError' ? 'Timeout' : String(e?.message || e),
    };
  }
}

async function main() {
  const config = loadJson(LINKS_FILE, { links: [] });
  const links = (config.links || []).filter((l) => l && l.url && l.enabled !== false);

  if (links.length === 0) {
    console.log('ℹ️ لا توجد روابط مفعّلة في keepalive/links.json');
    return;
  }

  const prev = loadJson(STATUS_FILE, { links: {} });
  const now = new Date().toISOString();

  console.log(`🚀 فحص ${links.length} رابط...`);

  const results = await Promise.all(
    links.map(async (link) => {
      const r = await pingUrl(link);
      const icon = r.status === 'up' ? '✅' : '❌';
      console.log(`${icon} ${link.name || link.url} → ${r.http_status ?? r.error} (${r.response_time_ms}ms)`);
      return { link, r };
    })
  );

  const out = { last_run: now, links: {} };
  let upCount = 0;

  for (const { link, r } of results) {
    if (r.status === 'up') upCount++;
    const key = link.url;
    const prevEntry = prev.links?.[key] || {};
    const history = Array.isArray(prevEntry.history) ? prevEntry.history : [];
    history.unshift({ at: now, ...r });
    const trimmed = history.slice(0, HISTORY_LIMIT);
    const total = trimmed.length;
    const ups = trimmed.filter((h) => h.status === 'up').length;
    out.links[key] = {
      name: link.name || link.url,
      url: link.url,
      last: { at: now, ...r },
      uptime_pct: total ? Math.round((ups / total) * 100) : 0,
      total_checks: (prevEntry.total_checks || 0) + 1,
      history: trimmed,
    };
  }

  out.summary = { total: links.length, up: upCount, down: links.length - upCount };
  writeFileSync(STATUS_FILE, JSON.stringify(out, null, 2));
  console.log(`\n📊 النتيجة: ${upCount}/${links.length} شغال`);

  // لا نفشل الـ workflow لو موقع واقع — عشان الجدولة تستمر
}

main().catch((e) => {
  console.error('💥 خطأ:', e);
  process.exit(0);
});
