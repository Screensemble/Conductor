// Renders the signed-in user chip into #authchip (present on Control Room pages):
// username, link to user management, and sign-out.
(async () => {
  const host = document.getElementById('authchip');
  if (!host) return;
  const st = document.createElement('style');
  st.textContent = `
    .authchip { margin-left: auto; display: flex; align-items: center;
                gap: 12px; font: 600 13px system-ui; }
    .authchip .who { color: var(--dim, #7a9bb8); }
    .authchip a { color: var(--dim, #7a9bb8); text-decoration: none; }
    .authchip a:hover { color: var(--text, #dde3e8); }
  `;
  document.head.appendChild(st);
  let me = null;
  try {
    const r = await fetch('/api/me');
    if (r.ok) me = await r.json();
  } catch { /* offline */ }
  if (!me) return;
  host.innerHTML =
    `<span class="who"></span>` +
    (me.role === 'admin' ? ` · <a href="/users.html">Users</a>` : '') +
    ` · <a href="#" id="signout">Sign out</a>`;
  host.querySelector('.who').textContent = me.username || me.name;
  host.querySelector('#signout').onclick = async (e) => {
    e.preventDefault();
    await fetch('/api/auth/sign-out', { method: 'POST' });
    location.href = '/login.html';
  };
})();
