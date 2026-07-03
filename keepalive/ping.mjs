#!/usr/bin/env node
/**
 * Keep-Alive Pinger — يشتغل على سيرفرات GitHub Actions مجاناً 24/7
 * يقرأ الروابط من keepalive/links.json، يزور كل رابط (بإعادة محاولة ذكية)،
 * ويسجل النتيجة في keepalive/status.json. يشتغل تلقائياً بجدولة GitHub Actions
 * حتى لو موبايلك مقفول تماماً — GitHub هو السيرفر.
 *
 * ذكاء إضافي في هذه النسخة:
 *  - تدوير User-Agent (Desktop + Mobile) لتقليل الحظر
 *  - إعادة محاولة (retries) قبل اعتبار الرابط "واقع" — يمنع الإنذارات الكاذبة
 *  - وعي بتسجيل الدخول: التحويل لصفحة تسجيل دخول جوجل = الموقع "صاحٍ" وليس واقع
 *  - تحقق بكلمة مفتاحية اختيارية (keyword) للتأكد إن الصفحة فعلاً حمّلت
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LINKS_FILE = join(__dirname, 'links.json');
const STATUS_FILE = join(__dirname, 'status.json');
const HISTORY_LIMIT = 50; // آخر 50 فحص لكل رابط

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
];

function pickUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function loadJson(path, fallback) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`⚠️ فشل قراءة ${path}: ${e.message}`);
  }
  return fallback;
}

async function pingOnce(link) {
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
        'User-Agent': pickUA(),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        ...(link.headers || {}),
      },
    });
    clearTimeout(timer);

    let bodyText = '';
    try {
      const buf = await res.arrayBuffer();
      const slice = buf.byteLength > 65536 ? buf.slice(0, 65536) : buf;
      bodyText = new TextDecoder('utf-8', { fatal: false }).decode(slice);
    } catch {}

    const elapsed = Date.now() - start;
    const finalUrl = res.url || link.url;
    const isAuthRedirect = /accounts\.google\.com|\/signin|\/login|ServiceLogin|oauth/i.test(finalUrl);

    if (link.keyword && res.status >= 200 && res.status < 400 && !isAuthRedirect) {
      if (!bodyText.toLowerCase().includes(String(link.keyword).toLowerCase())) {
        return { status: 'down', http_status: res.status, response_time_ms: elapsed, error: `keyword "${link.keyword}" not found`, note: 'keyword-missing' };
      }
    }

    if (isAuthRedirect) {
      return { status: 'up', http_status: res.status, response_time_ms: elapsed, error: null, note: 'auth-redirect (الموقع صاحٍ — يطلب تسجيل دخول)' };
    }

    const ok = res.status >= 200 && res.status < 400;
    return { status: ok ? 'up' : 'down', http_status: res.status, response_time_ms: elapsed, error: ok ? null : `HTTP ${res.status}`, note: null };
  } catch (e) {
    return { status: 'down', http_status: null, response_time_ms: Date.now() - start, error: e?.name === 'AbortError' ? 'Timeout' : String(e?.message || e), note: null };
  }
}

async function pingUrl(link) {
  const retries = Math.max(0, Math.min(parseInt(link.retries) || 2, 5));
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await pingOnce(link);
    if (r.status === 'up') return r;
    last = r;
    if (attempt < retries) await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
  }
  return last;
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

  console.log(`🚀 فحص ${links.length} رابط (بإعادة محاولة ذكية)...`);

  const results = await Promise.all(
    links.map(async (link) => {
      const r = await pingUrl(link);
      const icon = r.status === 'up' ? '✅' : '❌';
      const extra = r.note ? ` [${r.note}]` : '';
      console.log(`${icon} ${link.name || link.url} → ${r.http_status ?? r.error} (${r.response_time_ms}ms)${extra}`);
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
}

main().catch((e) => {
  console.error('💥 خطأ:', e);
  process.exit(0);
});
