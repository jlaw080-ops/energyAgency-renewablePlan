// 설정 페이지 동작
(function () {
  'use strict';
  const DEFAULT_SHEET_ID = '1aIUyHK8FrLSot9zL4Z-j9W0C6KQNDL5dz45tdC40elc';
  const $ = (s) => document.querySelector(s);
  const digits = (s) => String(s || '').replace(/\D/g, '');

  let users = [];
  let orgs = [];       // 현재 사용 중인 기관 목록 (시트 동기화본 또는 내장)
  let bundled = [];    // 내장 데이터

  function msg(sel, text, cls) { const el = $(sel); el.textContent = text; el.className = 'msg ' + (cls || ''); }

  // ---------- 사용자 ----------
  function fmtPhone(p) {
    const d = digits(p);
    if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
    return p.trim();
  }
  function renderUsers() {
    const tb = $('#u-table tbody');
    tb.innerHTML = '';
    if (!users.length) { tb.innerHTML = '<tr><td colspan="4" class="empty">등록된 사용자가 없습니다.</td></tr>'; return; }
    users.forEach((u, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td class="n"></td><td class="p"></td>
        <td style="text-align:right"><button data-act="up" data-i="${i}" title="위로">▲</button> <button data-act="down" data-i="${i}" title="아래로">▼</button> <button data-act="del" data-i="${i}" class="danger">삭제</button></td>`;
      tr.querySelector('.n').textContent = u.name;
      tr.querySelector('.p').textContent = u.phone;
      tb.appendChild(tr);
    });
  }
  function saveUsers(note) {
    chrome.storage.sync.set({ users }, () => { renderUsers(); if (note) msg('#u-msg', note, 'ok'); });
  }
  $('#u-add').addEventListener('click', () => {
    const name = $('#u-name').value.trim();
    const phone = fmtPhone($('#u-phone').value);
    if (!name) return msg('#u-msg', '이름을 입력하세요.', 'err');
    if (digits(phone).length < 10) return msg('#u-msg', '휴대폰 번호를 확인하세요 (숫자 10~11자리).', 'err');
    users.push({ name, phone });
    $('#u-name').value = ''; $('#u-phone').value = '';
    saveUsers(`${name} 님을 추가했습니다.`);
  });
  $('#u-phone').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#u-add').click(); });
  $('#u-table').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const i = Number(b.dataset.i);
    if (b.dataset.act === 'del') { if (!confirm(`${users[i].name} 님을 삭제할까요?`)) return; users.splice(i, 1); }
    if (b.dataset.act === 'up' && i > 0) [users[i - 1], users[i]] = [users[i], users[i - 1]];
    if (b.dataset.act === 'down' && i < users.length - 1) [users[i + 1], users[i]] = [users[i], users[i + 1]];
    saveUsers();
  });

  // ---------- 기관 데이터 ----------
  function parseSheetId(v) {
    v = (v || '').trim();
    const m = v.match(/\/d\/([a-zA-Z0-9-_]+)/);
    return m ? m[1] : v;
  }
  // 간단한 CSV 파서 (따옴표/쉼표/줄바꿈 처리)
  function parseCSV(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  function rowsToOrgs(rows) {
    // 헤더에서 "기관명", "사업자번호" 열 위치를 찾고, 없으면 2·3번째 열 사용
    const header = rows[0] ? rows[0].map((h) => h.trim()) : [];
    let ni = header.findIndex((h) => /기관명|기관|업체명|사업자명|name/i.test(h));
    let bi = header.findIndex((h) => /사업자/.test(h) || /biz|bno/i.test(h));
    if (ni < 0) ni = 1; if (bi < 0) bi = 2;
    const seen = new Set(); const out = [];
    for (const r of rows.slice(header.length ? 1 : 0)) {
      const name = (r[ni] || '').trim(); const raw = (r[bi] || '').trim();
      const d = digits(raw);
      if (!name || d.length !== 10) continue;
      const bno = `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
      const k = name + bno; if (seen.has(k)) continue; seen.add(k);
      out.push({ name, bno });
    }
    return out;
  }
  function renderOrgInfo() {
    chrome.storage.local.get({ orgsUpdatedAt: '' }, ({ orgsUpdatedAt }) => {
      $('#org-info').textContent = `현재 ${orgs.length}곳 · ` + (orgsUpdatedAt ? `시트 동기화 ${orgsUpdatedAt}` : '내장 데이터 사용 중');
    });
    renderOrgTable($('#org-q').value);
  }
  function renderOrgTable(q) {
    const tb = $('#org-table tbody'); tb.innerHTML = '';
    const nq = (q || '').replace(/\s+/g, '').toLowerCase();
    if (!nq) return;
    const hits = orgs.filter((o) => o.name.replace(/\s+/g, '').toLowerCase().includes(nq)).slice(0, 20);
    if (!hits.length) { tb.innerHTML = '<tr><td class="empty">검색 결과 없음</td></tr>'; return; }
    for (const o of hits) {
      const tr = document.createElement('tr'); tr.innerHTML = '<td></td><td style="width:140px"></td>';
      tr.children[0].textContent = o.name; tr.children[1].textContent = o.bno; tb.appendChild(tr);
    }
  }
  $('#org-q').addEventListener('input', (e) => renderOrgTable(e.target.value));

  $('#org-sync').addEventListener('click', async () => {
    const id = parseSheetId($('#sheet-id').value) || DEFAULT_SHEET_ID;
    const gid = $('#sheet-gid').value.trim();
    const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${encodeURIComponent(gid)}` : ''}`;
    msg('#org-msg', '시트에서 불러오는 중...');
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (/<html/i.test(text.slice(0, 200))) throw new Error('CSV 대신 웹페이지가 반환되었습니다. 시트 공유 설정(링크가 있는 모든 사용자)을 확인하세요.');
      const list = rowsToOrgs(parseCSV(text));
      if (!list.length) throw new Error('기관명/사업자번호 열을 찾지 못했습니다. 시트의 열 제목을 확인하세요.');
      const when = new Date().toLocaleString('ko-KR', { hour12: false });
      chrome.storage.local.set({ orgsOverride: list, orgsUpdatedAt: when }, () => {
        chrome.storage.sync.set({ sheetId: id, sheetGid: gid });
        orgs = list; renderOrgInfo();
        msg('#org-msg', `${list.length}곳을 불러왔습니다.`, 'ok');
      });
    } catch (e) {
      msg('#org-msg', '불러오기 실패: ' + e.message, 'err');
    }
  });
  $('#org-reset').addEventListener('click', () => {
    chrome.storage.local.remove(['orgsOverride', 'orgsUpdatedAt'], () => { orgs = bundled; renderOrgInfo(); msg('#org-msg', '내장 데이터로 되돌렸습니다.', 'ok'); });
  });

  // ---------- 고급 ----------
  $('#adv-save').addEventListener('click', () => {
    chrome.storage.sync.set({
      bizSelector: $('#biz-sel').value.trim(),
      phoneSelector: $('#phone-sel').value.trim(),
      bizFormat: $('#biz-fmt').value,
      phoneFormat: $('#phone-fmt').value,
      showOnlyLogin: $('#only-login').value === '1',
    }, () => msg('#adv-msg', '저장했습니다.', 'ok'));
  });

  // ---------- 초기화 ----------
  async function init() {
    const j = await (await fetch(chrome.runtime.getURL('data/orgs.json'))).json();
    bundled = j.orgs || [];
    chrome.storage.sync.get({ users: [], sheetId: DEFAULT_SHEET_ID, sheetGid: '', bizSelector: '', phoneSelector: '', bizFormat: 'auto', phoneFormat: 'auto', showOnlyLogin: true }, (s) => {
      users = s.users; renderUsers();
      $('#sheet-id').value = s.sheetId; $('#sheet-gid').value = s.sheetGid;
      $('#biz-sel').value = s.bizSelector; $('#phone-sel').value = s.phoneSelector;
      $('#biz-fmt').value = s.bizFormat; $('#phone-fmt').value = s.phoneFormat;
      $('#only-login').value = s.showOnlyLogin ? '1' : '0';
    });
    chrome.storage.local.get({ orgsOverride: null }, ({ orgsOverride }) => {
      orgs = orgsOverride && orgsOverride.length ? orgsOverride : bundled;
      renderOrgInfo();
    });
    // 로그인 화면에서 "입력칸 지정"으로 저장된 값이 바뀌면 즉시 반영
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'sync') return;
      if (ch.bizSelector) $('#biz-sel').value = ch.bizSelector.newValue || '';
      if (ch.phoneSelector) $('#phone-sel').value = ch.phoneSelector.newValue || '';
    });
  }
  init();

  // ---------- 4. 크롤링 → 구글 시트 ----------
  const STATUS_KO = { written: '시트 작성', exists: '시트에 이미 있음', past: '준공 경과 제외', nodate: '일정 없음 제외(다음에 다시 확인)', collected: '수집(시트 미연결)' };
  const COLS = 'ABCDEFGHIJKLMNOPQR'.split('');
  function randomToken() {
    const a = new Uint8Array(12); crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function renderScript() {
    const tpl = await (await fetch(chrome.runtime.getURL('apps-script/Code.gs'))).text();
    const sheet = $('#gs-sheet').value.trim() || '설치계획';
    $('#gs-code').value = tpl.replace('__TOKEN__', $('#gs-token').value).replace('__SHEET__', sheet.replace(/'/g, "\\'"));
  }
  $('#gs-sheet').addEventListener('input', renderScript);
  $('#gs-copy').addEventListener('click', async () => {
    await renderScript();
    await navigator.clipboard.writeText($('#gs-code').value);
    msg('#gs-msg', '코드를 복사했습니다. Apps Script 편집기에 붙여넣으세요.', 'ok');
  });
  $('#gs-save').addEventListener('click', async () => {
    const url = $('#gs-url').value.trim();
    const sheetName = $('#gs-sheet').value.trim() || '설치계획';
    const delay = Math.max(0, Number($('#cr-delay').value) || 1);
    if (url && !/^https:\/\/script\.google(usercontent)?\.com\//.test(url) && !/^http:\/\/127\.0\.0\.1/.test(url)) {
      return msg('#gs-msg', '웹 앱 URL은 https://script.google.com/macros/s/…/exec 형태여야 합니다.', 'err');
    }
    await chrome.storage.sync.set({ sheetUrl: url, sheetName, crawlDelay: delay * 1000 });
    renderScript();
    if (!url) return msg('#gs-msg', '저장했습니다. (URL이 비어 있어 시트에는 쓰지 않고 수집만 합니다)', 'ok');
    msg('#gs-msg', '연결 확인 중...');
    const r = await chrome.runtime.sendMessage({ type: 'sheet-ping' });
    if (r && r.ok) msg('#gs-msg', `연결 성공: "${r.sheet}" 탭, 마지막 기록 행 ${r.lastRow}행. 다음 기록은 ${r.lastRow + 1}행부터입니다.`, 'ok');
    else msg('#gs-msg', '연결 실패: ' + ((r && r.error) || '응답 없음'), 'err');
  });

  // ---------- 나라 앱으로 보내기 ----------
  // 권한 요청은 클릭 직후(사용자 동작 안)에 해야 크롬이 창을 띄운다 — await보다 먼저 부른다.
  $('#nara-save').addEventListener('click', () => {
    const raw = $('#nara-url').value.trim().replace(/\/+$/, '');
    const token = $('#nara-token').value.trim();
    let origin = '';
    if (raw) {
      try {
        const u = new URL(raw);
        if (!/^https?:$/.test(u.protocol)) throw new Error('scheme');
        origin = `${u.protocol}//${u.hostname}/*`;
      } catch (e) {
        return msg('#nara-msg', '나라 앱 주소는 http://127.0.0.1:8000 처럼 적으세요.', 'err');
      }
    }
    const ask = origin ? chrome.permissions.request({ origins: [origin] }) : Promise.resolve(true);
    ask.then(async (granted) => {
      await chrome.storage.sync.set({ naraUrl: raw });
      await chrome.storage.local.set({ naraToken: token });
      if (!raw) return msg('#nara-msg', '저장했습니다. (주소가 비어 있어 나라 앱으로 보내지 않습니다)', 'ok');
      if (!granted) return msg('#nara-msg', '주소에 접근할 권한이 없어 보낼 수 없습니다. 다시 저장하고 허용을 누르세요.', 'err');
      if (!token) return msg('#nara-msg', '토큰을 넣으세요. 나라 앱 .env의 NARA_IMPORT_TOKEN 값입니다.', 'err');
      msg('#nara-msg', '연결 확인 중...');
      const r = await chrome.runtime.sendMessage({ type: 'nara-ping' });
      if (r && r.ok) msg('#nara-msg', '연결 성공: 크롤링한 설치계획서를 나라 앱으로도 보냅니다.', 'ok');
      else msg('#nara-msg', '연결 실패: ' + ((r && r.error) || '응답 없음'), 'err');
    });
  });

  async function renderLog() {
    const { crawlLog = {}, crawlResults = [] } = await chrome.storage.local.get({ crawlLog: {}, crawlResults: [] });
    const entries = Object.entries(crawlLog).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
    const cnt = {}; entries.forEach(([, v]) => { cnt[v.status] = (cnt[v.status] || 0) + 1; });
    const sent = entries.filter(([, v]) => v.nara).length;
    $('#cr-info').textContent = `기록 ${entries.length}건 · ` + Object.entries(cnt).map(([k, v]) => `${STATUS_KO[k] || k} ${v}`).join(' · ') + ` · 수집 결과 ${crawlResults.length}행` + (sent ? ` · 나라 앱 전송 ${sent}` : '');
    const tb = $('#cr-table tbody'); tb.innerHTML = '';
    if (!entries.length) { tb.innerHTML = '<tr><td colspan="4" class="empty">아직 기록이 없습니다.</td></tr>'; return; }
    for (const [, v] of entries.slice(0, 50)) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td><td></td><td></td>';
      // 전체 받기로 받은 건은 상태 뒤에 그 사실을 붙인다
      const flags = (v.past ? ' (준공 경과)' : '') + (v.nodate ? ' (일정 없음)' : '');
      [(STATUS_KO[v.status] || v.status) + flags, v.org, v.name, v.end].forEach((t, i) => { tr.children[i].textContent = t || ''; });
      tb.appendChild(tr);
    }
  }
  $('#cr-copy').addEventListener('click', async () => {
    const { crawlResults = [] } = await chrome.storage.local.get({ crawlResults: [] });
    if (!crawlResults.length) return msg('#cr-msg', '복사할 수집 결과가 없습니다.', 'err');
    const cell = (v) => { v = String(v || ''); return /[\t\n"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const tsv = crawlResults.map((r) => COLS.map((c) => cell(r[c])).join('\t')).join('\n');
    await navigator.clipboard.writeText(tsv);
    msg('#cr-msg', `${crawlResults.length}행을 복사했습니다. 시트의 A열 빈 칸을 선택하고 붙여넣으세요.`, 'ok');
  });
  $('#cr-reset').addEventListener('click', async () => {
    if (!confirm('작업 기록과 수집 결과를 모두 지울까요? 다음 크롤링 때 모든 건을 다시 엽니다.')) return;
    await chrome.storage.local.remove(['crawlLog', 'crawlResults', 'crawlState', 'crawlInbox']);
    renderLog(); msg('#cr-msg', '초기화했습니다.', 'ok');
  });
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.crawlLog || ch.crawlResults)) renderLog(); });

  async function initCrawl() {
    let s = await chrome.storage.sync.get({ sheetUrl: '', sheetName: '설치계획', sheetToken: '', crawlDelay: 1000 });
    if (!s.sheetToken) { s.sheetToken = randomToken(); await chrome.storage.sync.set({ sheetToken: s.sheetToken }); }
    $('#gs-url').value = s.sheetUrl; $('#gs-sheet').value = s.sheetName; $('#gs-token').value = s.sheetToken;
    $('#cr-delay').value = String(Number(s.crawlDelay) / 1000);
    if (!s.sheetUrl) $('#gs-guide').open = true;
    $('#nara-url').value = (await chrome.storage.sync.get({ naraUrl: '' })).naraUrl;
    $('#nara-token').value = (await chrome.storage.local.get({ naraToken: '' })).naraToken;
    renderScript(); renderLog();
  }
  initCrawl();
})();
