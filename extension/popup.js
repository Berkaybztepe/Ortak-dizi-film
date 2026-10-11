const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const FIELDS = ['serverUrl', 'name', 'room'];
let enabled = false;

function render(st) {
  enabled = st.settings.enabled;
  $('toggle').textContent = enabled ? 'Bağlantıyı kes' : 'Bağlan';
  $('toggle').classList.toggle('off', enabled);
  $('dot').className = 'dot' + (st.wsState === 'bağlı' ? ' on' : st.wsState === 'bağlanıyor' ? ' wait' : '');
  const s = $('status');
  s.className = 'status' + (st.wsState === 'hata' ? ' err' : '');
  s.textContent =
    st.wsState === 'bağlı' ? `Bağlı · oda: ${st.room.name}` :
    st.wsState === 'bağlanıyor' ? 'Bağlanıyor…' :
    st.wsState === 'hata' ? (st.lastError || 'Bağlanamadı') + ' Tekrar deneniyor…' :
    'Bağlı değil';
  if (st.wsState === 'hata' && !enabled) s.textContent = st.lastError || 'Bağlı değil';

  const box = $('roomBox');
  box.hidden = st.wsState !== 'bağlı';
  const ul = $('members');
  ul.textContent = '';
  for (const m of st.room.members || []) {
    const li = document.createElement('li');
    li.textContent = m.name + (m.id === st.room.me?.id ? ' (sen)' : '') + (m.kind === 'web' ? ' · panel' : '');
    const sm = document.createElement('small');
    if (m.url) {
      const a = document.createElement('a');
      a.href = m.url;
      a.textContent = (m.platform ? m.platform + ': ' : '') + (m.title || 'açık sayfa');
      a.onclick = (e) => { e.preventDefault(); api.tabs.create({ url: m.url }); };
      sm.appendChild(a);
    } else sm.textContent = m.kind === 'web' ? 'web panelinde' : 'henüz bir şey açmadı';
    li.appendChild(sm);
    ul.appendChild(li);
  }
}

async function load() {
  const st = await api.runtime.sendMessage({ t: 'getStatus' });
  for (const f of FIELDS) $(f).value = st.settings[f] || '';
  if (!$('room').value) $('room').value = 'salon';
  $('autoFollow').checked = !!st.settings.autoFollow;
  render(st);
}

$('toggle').onclick = async () => {
  const settings = { enabled: !enabled, autoFollow: $('autoFollow').checked };
  for (const f of FIELDS) settings[f] = $(f).value.trim();
  if ($('password').value) settings.password = $('password').value;
  if (settings.enabled && !settings.serverUrl) {
    $('status').textContent = 'Önce sunucu adresini yaz.';
    $('status').className = 'status err';
    return;
  }
  render(await api.runtime.sendMessage({ t: 'saveSettings', settings }));
};

$('autoFollow').onchange = () => api.runtime.sendMessage({ t: 'saveSettings', settings: { autoFollow: $('autoFollow').checked } });

load();
setInterval(async () => render(await api.runtime.sendMessage({ t: 'getStatus' })), 1000);
