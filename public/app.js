// ============ Keep-Alive Monitor - Mobile Dashboard ============
let linksCache = [];
let expandedId = null; // which card has history open
let previewId = null;  // which card has live preview open

const $ = (id) => document.getElementById(id);

function toast(msg, ok = true) {
  const t = $('toast');
  t.innerHTML = `<i class="fas ${ok ? 'fa-check-circle text-emerald-400' : 'fa-triangle-exclamation text-red-400'} ml-1"></i> ${msg}`;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2500);
}

function timeAgo(iso) {
  if (!iso) return 'لم يُفحص بعد';
  const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 5) return 'الآن';
  if (s < 60) return `منذ ${s} ثانية`;
  const m = Math.floor(s / 60);
  if (m < 60) return `منذ ${m} دقيقة`;
  const h = Math.floor(m / 60);
  if (h < 24) return `منذ ${h} ساعة`;
  return `منذ ${Math.floor(h / 24)} يوم`;
}

function speedColor(ms) {
  if (ms == null) return 'text-slate-500';
  if (ms < 500) return 'text-emerald-400';
  if (ms < 1500) return 'text-yellow-400';
  return 'text-orange-400';
}

// ============ Rendering ============

function renderLinks() {
  const container = $('links-container');
  if (!linksCache.length) {
    container.innerHTML = `
      <div class="text-center py-14 text-slate-500 slide-in">
        <i class="fas fa-satellite-dish text-4xl mb-3 text-slate-600"></i>
        <p class="font-bold text-slate-400">مفيش روابط لسه</p>
        <p class="text-xs mt-1">اضغط "أضف رابط" وهنخلي موقعك صاحي 24/7 ⚡</p>
      </div>`;
    return;
  }

  container.innerHTML = linksCache.map((l) => {
    const lc = l.latest_check;
    const isUp = lc && lc.status === 'up';
    const isDown = lc && lc.status === 'down';
    const disabled = !l.enabled;
    const statusDot = disabled
      ? '<span class="w-3 h-3 rounded-full bg-slate-500 inline-block"></span>'
      : isUp
      ? '<span class="w-3 h-3 rounded-full bg-emerald-500 inline-block pulse-up"></span>'
      : isDown
      ? '<span class="w-3 h-3 rounded-full bg-red-500 inline-block pulse-down"></span>'
      : '<span class="w-3 h-3 rounded-full bg-slate-500 inline-block"></span>';

    const statusText = disabled
      ? '<span class="text-slate-400 font-bold text-xs">موقوف مؤقتاً</span>'
      : isUp
      ? '<span class="text-emerald-400 font-bold text-xs">شغال ✅</span>'
      : isDown
      ? `<span class="text-red-400 font-bold text-xs">واقع ❌ ${lc.error ? '· ' + lc.error : ''}</span>`
      : '<span class="text-slate-400 font-bold text-xs">في انتظار الفحص...</span>';

    return `
    <article class="glass rounded-2xl p-4 slide-in" id="card-${l.id}">
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-2.5 min-w-0">
          ${statusDot}
          <div class="min-w-0">
            <h3 class="font-black text-sm truncate">${escapeHtml(l.name)}</h3>
            <p class="text-[10px] text-slate-500 truncate" dir="ltr">${escapeHtml(l.url)}</p>
          </div>
        </div>
        <div class="flex gap-1 shrink-0">
          <button onclick="checkNow(${l.id})" title="افحص الآن" class="w-8 h-8 rounded-lg bg-slate-700/60 flex items-center justify-center active:scale-90 transition">
            <i class="fas fa-bolt text-yellow-400 text-xs" id="bolt-${l.id}"></i>
          </button>
          <button onclick="openEditModal(${l.id})" class="w-8 h-8 rounded-lg bg-slate-700/60 flex items-center justify-center active:scale-90 transition">
            <i class="fas fa-pen text-slate-300 text-xs"></i>
          </button>
          <button onclick="deleteLink(${l.id})" class="w-8 h-8 rounded-lg bg-slate-700/60 flex items-center justify-center active:scale-90 transition">
            <i class="fas fa-trash text-red-400 text-xs"></i>
          </button>
        </div>
      </div>

      <div class="mt-2.5">${statusText}</div>

      <div class="grid grid-cols-4 gap-2 mt-3 text-center">
        <div class="bg-slate-800/60 rounded-xl py-2">
          <div class="text-xs font-black ${speedColor(lc?.response_time_ms)}">${lc?.response_time_ms != null ? lc.response_time_ms + 'ms' : '–'}</div>
          <div class="text-[9px] text-slate-500">السرعة</div>
        </div>
        <div class="bg-slate-800/60 rounded-xl py-2">
          <div class="text-xs font-black text-cyan-400">${l.uptime_percent != null ? l.uptime_percent + '%' : '–'}</div>
          <div class="text-[9px] text-slate-500">Uptime</div>
        </div>
        <div class="bg-slate-800/60 rounded-xl py-2">
          <div class="text-xs font-black text-slate-200">كل ${l.interval_minutes} د</div>
          <div class="text-[9px] text-slate-500">التكرار</div>
        </div>
        <div class="bg-slate-800/60 rounded-xl py-2">
          <div class="text-xs font-black text-slate-200">${l.total_checks}</div>
          <div class="text-[9px] text-slate-500">الزيارات</div>
        </div>
      </div>

      <div class="flex items-center justify-between mt-3">
        <span class="text-[10px] text-slate-500"><i class="fas fa-clock ml-1"></i>آخر زيارة: ${timeAgo(lc?.checked_at)}</span>
        <div class="flex gap-2">
          <button onclick="toggleHistory(${l.id})" class="text-[11px] font-bold text-cyan-400 active:opacity-60">
            <i class="fas fa-chart-simple ml-0.5"></i> السجل
          </button>
          <button onclick="togglePreview(${l.id})" class="text-[11px] font-bold text-emerald-400 active:opacity-60">
            <i class="fas fa-eye ml-0.5"></i> عرض الموقع
          </button>
        </div>
      </div>

      <div id="history-${l.id}" class="mt-3 hidden"></div>
      <div id="preview-${l.id}" class="mt-3 hidden"></div>
    </article>`;
  }).join('');

  // Restore expanded panels after re-render
  if (expandedId) toggleHistory(expandedId, true);
  if (previewId) togglePreview(previewId, true);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ============ History panel ============

async function toggleHistory(id, forceOpen = false) {
  const panel = $(`history-${id}`);
  if (!panel) return;
  if (!forceOpen && !panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    expandedId = null;
    return;
  }
  expandedId = id;
  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="text-center py-3 text-slate-500 text-xs"><i class="fas fa-circle-notch spin-slow"></i> تحميل السجل...</div>';

  try {
    const { data } = await axios.get(`/api/links/${id}/checks?limit=30`);
    const checks = data.checks || [];
    if (!checks.length) {
      panel.innerHTML = '<p class="text-xs text-slate-500 text-center py-2">مفيش سجل لسه</p>';
      return;
    }

    // Mini bar chart (oldest right in RTL)
    const maxMs = Math.max(...checks.map((c) => c.response_time_ms || 0), 1);
    const bars = checks.slice().reverse().map((c) => {
      const h = Math.max(6, Math.round(((c.response_time_ms || 0) / maxMs) * 36));
      const color = c.status === 'up' ? 'background:#22c55e' : 'background:#ef4444';
      return `<span class="bar" style="height:${h}px;${color}" title="${c.response_time_ms}ms"></span>`;
    }).join('');

    const rows = checks.slice(0, 10).map((c) => `
      <div class="flex items-center justify-between text-[11px] py-1.5 border-b border-slate-700/50 last:border-0">
        <span>${c.status === 'up' ? '✅' : '❌'} <span class="text-slate-400">${c.http_status || (c.error ? 'خطأ' : '–')}</span></span>
        <span class="${speedColor(c.response_time_ms)} font-bold">${c.response_time_ms != null ? c.response_time_ms + 'ms' : '–'}</span>
        <span class="text-slate-500">${timeAgo(c.checked_at)}</span>
      </div>`).join('');

    panel.innerHTML = `
      <div class="bg-slate-800/60 rounded-xl p-3">
        <div class="flex items-end justify-center h-10 mb-2 overflow-hidden" dir="ltr">${bars}</div>
        ${rows}
      </div>`;
  } catch {
    panel.innerHTML = '<p class="text-xs text-red-400 text-center py-2">فشل تحميل السجل</p>';
  }
}

// ============ Live preview (real page open in iframe) ============

function togglePreview(id, forceOpen = false) {
  const panel = $(`preview-${id}`);
  if (!panel) return;
  if (!forceOpen && !panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    panel.innerHTML = ''; // stop the iframe
    previewId = null;
    return;
  }
  const link = linksCache.find((l) => l.id === id);
  if (!link) return;
  previewId = id;
  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="bg-slate-800/60 rounded-xl p-2">
      <div class="flex items-center justify-between px-2 pb-2">
        <span class="text-[10px] text-slate-400"><i class="fas fa-globe ml-1"></i>الصفحة مفتوحة فعلياً — بتساعد الموقع يفضل صاحي</span>
        <a href="${escapeHtml(link.url)}" target="_blank" class="text-[10px] text-cyan-400 font-bold">فتح في تبويب <i class="fas fa-up-right-from-square"></i></a>
      </div>
      <iframe src="${escapeHtml(link.url)}" class="preview-frame" loading="eager"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        onerror="this.outerHTML='<p class=\\'text-xs text-yellow-400 p-3\\'>⚠️ الموقع ده مانع العرض داخل إطار — بس الزيارات التلقائية شغالة عادي</p>'"></iframe>
      <p class="text-[9px] text-slate-500 px-2 pt-1.5">💡 لو ظهر فاضي: الموقع بيمنع iframe، لكن ده مش بيأثر على الزيارات التلقائية من السيرفر</p>
    </div>`;
}

// ============ CRUD ============

function openAddModal() {
  $('modal-title').innerHTML = '<i class="fas fa-link text-cyan-400 ml-1"></i> أضف رابط جديد';
  $('f-id').value = '';
  $('f-url').value = '';
  $('f-name').value = '';
  $('f-interval').value = '5';
  $('f-timeout').value = '15000';
  $('modal').classList.remove('hidden');
}

function openEditModal(id) {
  const l = linksCache.find((x) => x.id === id);
  if (!l) return;
  $('modal-title').innerHTML = '<i class="fas fa-pen text-cyan-400 ml-1"></i> تعديل الرابط';
  $('f-id').value = l.id;
  $('f-url').value = l.url;
  $('f-name').value = l.name;
  $('f-interval').value = String(l.interval_minutes);
  $('f-timeout').value = String(l.timeout_ms);
  $('modal').classList.remove('hidden');
}

function closeModal() {
  $('modal').classList.add('hidden');
}

async function submitLink(e) {
  e.preventDefault();
  const btn = $('submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-circle-notch spin-slow ml-1"></i> جاري الحفظ والفحص...';

  const id = $('f-id').value;
  const payload = {
    url: $('f-url').value.trim(),
    name: $('f-name').value.trim(),
    interval_minutes: parseInt($('f-interval').value),
    timeout_ms: parseInt($('f-timeout').value),
  };

  try {
    if (id) {
      await axios.put(`/api/links/${id}`, payload);
      toast('تم تعديل الرابط ✏️');
    } else {
      const { data } = await axios.post('/api/links', payload);
      toast(data.first_check?.status === 'up' ? 'تمت الإضافة والموقع شغال ✅' : 'تمت الإضافة — الموقع مش بيرد حالياً ⚠️', data.first_check?.status === 'up');
    }
    closeModal();
    await loadAll();
  } catch (err) {
    toast(err.response?.data?.error || 'حصل خطأ', false);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-check ml-1"></i> حفظ وابدأ المراقبة';
  }
}

async function deleteLink(id) {
  if (!confirm('متأكد إنك عايز تحذف الرابط ده؟ هيتوقف عن الزيارات التلقائية.')) return;
  try {
    await axios.delete(`/api/links/${id}`);
    toast('تم الحذف 🗑️');
    if (expandedId === id) expandedId = null;
    if (previewId === id) previewId = null;
    await loadAll();
  } catch {
    toast('فشل الحذف', false);
  }
}

async function checkNow(id) {
  const bolt = $(`bolt-${id}`);
  if (bolt) bolt.classList.add('spin-slow');
  try {
    const { data } = await axios.post(`/api/links/${id}/check`);
    toast(data.status === 'up' ? `شغال ✅ (${data.response_time_ms}ms)` : `واقع ❌ ${data.error || ''}`, data.status === 'up');
    await loadAll();
  } catch {
    toast('فشل الفحص', false);
  }
}

// ============ Data loading + client-side tick ============

async function loadAll(manual = false) {
  const btn = $('refresh-btn').querySelector('i');
  if (manual) btn.classList.add('spin-slow');
  try {
    const [linksRes, sumRes] = await Promise.all([axios.get('/api/links'), axios.get('/api/summary')]);
    linksCache = linksRes.data.links || [];
    $('sum-total').textContent = sumRes.data.total;
    $('sum-up').textContent = sumRes.data.up;
    $('sum-down').textContent = sumRes.data.down;
    renderLinks();
    $('last-refresh').textContent = 'آخر تحديث: ' + new Date().toLocaleTimeString('ar-EG');
  } catch {
    if (manual) toast('فشل تحميل البيانات', false);
  } finally {
    btn.classList.remove('spin-slow');
  }
}

// While the dashboard is open, also trigger server-side due checks every 60s
// (backup for the Cloudflare Cron which runs even when phone is off)
async function tick() {
  try { await axios.get('/api/tick'); } catch {}
  await loadAll();
}

loadAll();
setInterval(tick, 60000);       // every minute: run due checks + refresh UI
setInterval(loadAll, 15000);    // every 15s: light UI refresh
