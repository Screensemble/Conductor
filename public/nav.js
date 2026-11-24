// Shared Control Room header — one nav, same items/order/names on every
// page. A page opts in with <div id="topnav" data-page="KEY"></div> plus
// <script src="/nav.js" defer></script>; KEY is displays|library|groups|
// automations|system (or omitted for no active tab).
//
// The injected stylesheet also carries the shared phone rules: the link
// strip scrolls horizontally instead of wrapping, main padding tightens,
// and every `main table` is auto-wrapped in a scroll container so pages
// stop overflowing sideways. Tables that opt into stacked-card mode
// (class="rstack", td data-l="label") render as cards under 640px.
(() => {
  const PAGES = [
    ["displays", "/", "Displays"],
    ["library", "/library.html", "Library"],
    ["groups", "/groups.html", "Groups"],
    ["automations", "/battons.html", "Automations"],
    ["system", "/system.html", "System"],
  ];
  const css = `
  header.snav { display: flex; align-items: center; gap: 14px;
    padding: 8px 18px; background: var(--card);
    border-bottom: 1px solid var(--edge); }
  .snav-brand { display: flex; align-items: center; gap: 10px;
    text-decoration: none; flex-shrink: 0; }
  .snav-brand .mark { height: 34px; }
  .snav-brand .wordmark { height: 18px; }
  nav.snav-links { display: flex; gap: 4px; margin-left: 8px;
    overflow-x: auto; scrollbar-width: none; flex-shrink: 1; min-width: 0; }
  nav.snav-links::-webkit-scrollbar { display: none; }
  nav.snav-links a { color: var(--dim); font-size: 14px; font-weight: 600;
    padding: 10px 12px; cursor: pointer; text-decoration: none;
    border-radius: 6px 6px 0 0; white-space: nowrap; flex-shrink: 0; }
  nav.snav-links a:hover { color: var(--text); }
  nav.snav-links a.on { color: var(--cyan);
    border-bottom: 2px solid var(--cyan); }
  .snav-spacer { flex: 1; }
  /* Second-row strip for a page's own tabs (fleet panels, display tabs). */
  nav.subnav { display: flex; gap: 4px; border-bottom: 1px solid var(--edge);
    padding: 0 14px; overflow-x: auto; scrollbar-width: none; }
  nav.subnav::-webkit-scrollbar { display: none; }
  nav.subnav button, nav.subnav a { background: none; border: 0;
    border-radius: 6px 6px 0 0; color: var(--dim); font-size: 13px;
    font-weight: 600; padding: 8px 12px; cursor: pointer;
    text-decoration: none; white-space: nowrap; flex-shrink: 0; }
  nav.subnav button:hover, nav.subnav a:hover { color: var(--text); }
  nav.subnav .on { color: var(--cyan);
    border-bottom: 2px solid var(--cyan); }
  /* Tables never push the page sideways — they scroll inside a box. */
  .tw { overflow-x: auto; margin: 0 -4px; padding: 0 4px; }
  @media (max-width: 700px) {
    header.snav { padding: 8px 10px; gap: 8px; flex-wrap: wrap; }
    nav.snav-links { order: 3; flex-basis: 100%; margin-left: 0;
      -webkit-mask-image: linear-gradient(to right, #000 92%, transparent);
      mask-image: linear-gradient(to right, #000 92%, transparent); }
    nav.subnav {
      -webkit-mask-image: linear-gradient(to right, #000 92%, transparent);
      mask-image: linear-gradient(to right, #000 92%, transparent); }
    nav.snav-links a { padding: 8px 10px; }
    .snav-brand .mark { height: 26px; }
    .snav-brand .wordmark { height: 14px; }
    main { padding: 12px 10px !important; }
    .hide-phone { display: none !important; }
  }
  /* Stacked-card mode for tables that opt in (class="rstack"). */
  @media (max-width: 640px) {
    table.rstack thead { display: none; }
    table.rstack, table.rstack tbody { display: block; width: 100%; }
    table.rstack tr { display: block; padding: 8px 2px;
      border-bottom: 2px solid var(--edge); }
    table.rstack td { display: block; border: 0; padding: 3px 8px; }
    table.rstack td[data-l]::before { content: attr(data-l) ": ";
      color: var(--dim); font-size: 11px; text-transform: uppercase;
      letter-spacing: .5px; }
    table.rstack td.cell-dot, table.rstack td.cell-name {
      display: inline-block; }
    table.rstack td.cell-name { padding-left: 0; font-weight: 600;
      font-size: 15px; }
    table.rstack td.cell-acts { display: flex; flex-wrap: wrap; gap: 6px;
      padding-top: 6px; }
    table.rstack td.cell-acts button { flex: 1; min-width: 56px;
      padding: 10px 6px; }
  }`;
  const el = document.getElementById("topnav");
  if (!el) return;
  const st = document.createElement("style");
  st.textContent = css;
  document.head.appendChild(st);
  const active = el.dataset.page || "";
  el.outerHTML = `<header class="snav">
    <a class="snav-brand" href="/"><img class="mark" src="/logo.png" alt="">
      <img class="wordmark" src="/wordmark.png" alt="Screensemble"></a>
    <nav class="snav-links">${PAGES.map(([k, href, label]) =>
      `<a href="${href}"${k === active ? ' class="on"' : ""}>${label}</a>`,
    ).join("")}</nav>
    <span class="snav-spacer"></span>
    <span id="authchip" class="authchip"></span>
  </header>`;
  // Auto-wrap every main table so nothing can push the page sideways.
  for (const t of document.querySelectorAll("main table")) {
    if (t.parentElement?.classList.contains("tw")) continue;
    const w = document.createElement("div");
    w.className = "tw";
    t.parentNode.insertBefore(w, t);
    w.appendChild(t);
  }
})();
