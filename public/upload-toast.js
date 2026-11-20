// Upload queue toast — polls /api/uploads and shows aggregate progress
// for every in-flight transfer across all displays. Include on any
// server page: it injects its own styles + DOM and self-starts.
(() => {
  const css = document.createElement('style');
  css.textContent = `
    #upToast { position: fixed; left: 18px; bottom: 18px; width: 340px;
      background: #10203c; border: 1px solid #1d3a63; border-radius: 10px;
      z-index: 100; box-shadow: 0 8px 32px #000c; overflow: hidden;
      font: 13px/1.45 system-ui, sans-serif; color: #dde6f2;
      transition: opacity .25s, transform .25s; }
    #upToast.off { opacity: 0; transform: translateY(10px);
      pointer-events: none; }
    #upToast .accent { height: 3px;
      background: linear-gradient(90deg,#1e9be8,#3ec1f3); }
    #upToast .body { padding: 13px 16px 14px; }
    #upToast .head { display: flex; align-items: center; gap: 10px;
      margin-bottom: 9px; }
    #upToast .icon { width: 26px; height: 26px; border-radius: 7px;
      background: linear-gradient(180deg,#1e9be8,#0d6ba8);
      display: flex; align-items: center; justify-content: center;
      flex: none; }
    #upToast .icon svg { width: 15px; height: 15px; }
    #upToast .t { font-weight: 600; font-size: 13.5px; }
    #upToast .sub { color: #7a9bb8; font-size: 12px; margin-top: 7px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #upToast .bar { height: 6px; background: #0a1428; border-radius: 3px;
      overflow: hidden; margin-top: 9px; }
    #upToast .bar i { display: block; height: 100%; border-radius: 3px;
      background: linear-gradient(90deg,#1e9be8,#3ec1f3);
      transition: width .4s ease; }
    #upToast .pct { color: #7a9bb8; font-size: 12px;
      font-variant-numeric: tabular-nums; margin-left: auto; }
    #upToast .err { color: #f08a8a; font-size: 12px; margin-top: 6px; }
  `;
  document.head.appendChild(css);

  const el = document.createElement('div');
  el.id = 'upToast';
  el.className = 'off';
  document.body.appendChild(el);

  const ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 19V6"/><path d="m6 12 6-6 6 6"/></svg>';
  const ICON_ERR =
    '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" ' +
    'stroke-linecap="round"><path d="M12 8v6"/><circle cx="12" cy="17.5" ' +
    'r=".5" fill="#fff"/></svg>';

  const fmt = (b) =>
    b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB'
                 : Math.max(1, Math.round(b / 1024)) + ' KB';

  async function poll() {
    let jobs = [];
    try {
      const r = await fetch('/api/uploads');
      jobs = (await r.json()).jobs || [];
    } catch { /* server hiccup — keep polling */ }

    const active = jobs.filter(
      (j) => j.state === 'queued' || j.state === 'sending',
    );
    const errors = jobs.filter((j) => j.state === 'error');

    if (!active.length && !errors.length) {
      el.className = 'off';
      return;
    }

    let body;
    if (active.length) {
      const players = new Set(active.map((j) => j.player)).size;
      const got = active.reduce((s, j) => s + (j.received || 0), 0);
      const tot = active.reduce((s, j) => s + (j.total || 0), 0);
      const pct = tot ? Math.min(100, Math.round((got / tot) * 100)) : 0;
      const title = players > 1
        ? `Uploading to ${players} displays…`
        : 'Uploading to display…';
      body =
        `<div class="head"><div class="icon">${ICON}</div>` +
        `<div class="t">${title}</div><div class="pct">${pct}%</div></div>` +
        `<div>${active.length} file${active.length > 1 ? 's' : ''} — ` +
        `${fmt(got)} of ${fmt(tot)}</div>` +
        `<div class="bar"><i style="width:${pct}%"></i></div>` +
        `<div class="sub">${active.map((j) => j.name).join(' · ')}</div>` +
        (errors.length
          ? `<div class="err">${errors.length} transfer(s) failed</div>`
          : '');
    } else {
      body =
        `<div class="head"><div class="icon" ` +
        `style="background:linear-gradient(180deg,#c0392b,#8c2f39)">` +
        `${ICON_ERR}</div><div class="t">Upload failed</div></div>` +
        errors
          .map((j) => `<div class="err">${j.name}: ${j.error}</div>`)
          .join('');
    }
    el.innerHTML = `<div class="accent"></div><div class="body">${body}</div>`;
    el.className = '';
  }

  poll();
  setInterval(poll, 1500);
})();
