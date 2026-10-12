const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const FIELDS = ['serverUrl', 'name', 'room'];
let enabled = false;
let filled = false;

function render(st) {
  if (!st) return;
  enabled = !!st.settings.enabled;
  if (!filled) {
    filled = true;
    for (const f of FIELDS) $(f).value = st.settings[f] || '';
    $('room').value = st.settings.room || 'salon';
    $('autoFollow').checked = !!st.settings.autoFollow;
  }
  const ok = st.wsState === 'bağlı' && st.room.me;
  $('toggle').textContent = enabled ? 'Bağlantıyı kes' : 'Bağlan';
  $('toggle').classList.toggle('off', enabled);
  const chip = $('chip');
  chip.className = 'chip ' + (ok ? 'ok' : enabled ? 'warn' : st.lastError ? 'bad' : '');
  chip.textContent = ok ? `Bağlı · ${st.room.members.length} kişi` : enabled ? 'Bağlanıyor…' : 'Bağlı değil';
  $('err').hidden = !st.lastError || ok;
  $('err').textContent = st.lastError || '';

  $('roomBox').hidden = !ok;
  const others = st.room.members.filter((m) => m.id !== st.room.me?.id);
  $('members').replaceChildren(
    ...st.room.members.map((m) => {
      const mine = m.id === st.room.me?.id;
      const i = others.findIndex((x) => x.id === m.id);
      const row = document.createElement('div');
      row.className = 'm';
      const av = document.createElement('span');
      av.className = 'av';
      av.style.setProperty('--pc', mine ? 'var(--p0)' : `var(--p${(i % 3) + 1})`);
      av.textContent = (m.name || '?').charAt(0).toLocaleUpperCase('tr-TR');
      const t = document.createElement('div');
      t.className = 't';
      const b = document.createElement('b');
      b.textContent = mine ? `${m.name} (sen)` : m.name;
      t.append(b);
      if (m.url && !mine) {
        const a = document.createElement('a');
        a.textContent = `${m.platform ? m.platform + ': ' : ''}${m.title || 'açık sayfa'}`;
        a.onclick = () => api.tabs.create({ url: m.url });
        t.append(a);
      } else {
        const w = document.createElement('span');
        w.className = 'w';
        w.textContent = m.buffering ? 'yükleniyor' : m.title || (m.kind === 'web' ? 'web panelinde' : m.kind === 'app' ? 'uygulamada' : 'odada');
        t.append(w);
      }
      row.append(av, t);
      return row;
    })
  );
}

async function refresh() {
  try {
    render(await api.runtime.sendMessage({ t: 'getStatus' }));
  } catch {}
}

$('toggle').onclick = async () => {
  const settings = { enabled: !enabled, autoFollow: $('autoFollow').checked };
  for (const f of FIELDS) settings[f] = $(f).value.trim();
  if ($('password').value) settings.password = $('password').value;
  if (settings.enabled && !settings.serverUrl) {
    $('err').hidden = false;
    $('err').textContent = 'Önce oda kodunu yaz.';
    $('serverUrl').focus();
    return;
  }
  if (settings.enabled && !settings.name) {
    $('err').hidden = false;
    $('err').textContent = 'Adını yaz ki kardeşin kim olduğunu görsün.';
    $('name').focus();
    return;
  }
  render(await api.runtime.sendMessage({ t: 'saveSettings', settings }));
};
$('autoFollow').onchange = () => api.runtime.sendMessage({ t: 'saveSettings', settings: { autoFollow: $('autoFollow').checked } });

refresh();
setInterval(refresh, 1000);
