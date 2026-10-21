// 설치계획서 크롤링 (로그인 후 신청서 목록 페이지에서 동작)
//
// 흐름
//   목록 페이지: 각 행의 건물명을 클릭 → 팝업이 열림
//   팝업 페이지: 기관명·담당부서·건물명·주소·착공/준공예정일·에너지원 표를 읽어 저장소(crawlInbox)에 넣고 닫힘
//   목록 페이지: 준공예정일이 오늘보다 이전이면 제외, 아니면 구글 시트에 한 행 추가
//   '준공일 조건 없이 전체 받기'(crawlAll)를 켜면 준공 경과·일정 없음 건도 모두 받는다
//              (나라 앱 주소가 설정돼 있으면 나라 앱에도 보냄)
//   작업 기록(crawlLog)에 남긴 건은 다음 실행 때 건너뜀
//   한 페이지가 끝나면 다음 페이지 번호를 눌러 계속 진행
//
// 팝업이 자동으로 열리지 않는 환경(팝업 차단 등)에서는 "직접 클릭 모드"로 바뀐다:
//   다음 대상 건물명을 노란색으로 표시하고, 사용자가 누르면 그 팝업을 읽어 기록한다.

(function () {
  'use strict';
  if (window.__nrCrawlLoaded) return;
  window.__nrCrawlLoaded = true;

  const VERSION = '1.5.0';
  const isTop = window.top === window;
  const STATE = 'crawlState';     // { running, awaiting, assist, page, stats, startedAt, all }
  const ALL = 'crawlAll';         // (sync) 준공일 조건 없이 전체 받기 — 패널 체크박스
  const LOG = 'crawlLog';         // { [key]: { status, org, name, at } }
  const RESULTS = 'crawlResults'; // 수집한 시트 행 목록 (복사용 백업)
  const INBOX = 'crawlInbox';     // 팝업 → 목록 페이지 전달용
  const POPUP_SEEN = 'crawlPopupSeen';  // 백그라운드가 새 팝업 창을 감지하면 기록
  const POPUP_DIAG = 'crawlPopupDiag';  // 팝업에서 값을 못 읽었을 때 화면 정보

  const norm = (s) => String(s || '').replace(/[\s*:：]/g, '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = (k, d) => new Promise((r) => chrome.storage.local.get({ [k]: d }, (v) => r(v[k])));
  const set = (o) => new Promise((r) => chrome.storage.local.set(o, r));
  const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (resp) => { void chrome.runtime.lastError; r(resp); }));
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…(생략)' : s; };
  const OWN = '#nrfill-panel, #nrcrawl-panel';

  async function getState() { return (await get(STATE, null)) || { running: false }; }
  async function patchState(p) { const s = await getState(); const n = { ...s, ...p }; await set({ [STATE]: n }); return n; }

  // =====================================================================
  // 1) 팝업(설치계획서 상세)에서 값 읽기
  // =====================================================================
  const FIELD_SEL = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=image]):not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea';

  function fieldValue(el) {
    if (el.tagName === 'SELECT') return (el.selectedOptions[0]?.textContent || '').trim();
    return String(el.value || '').trim();
  }

  // 화면 글자 중 label 과 같은 것(공백·*·: 무시)을 문서 순서대로 찾는다
  function findLabels(label) {
    const want = norm(label);
    const out = [];
    if (!document.body) return out;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (norm(n.nodeValue) === want && !n.parentElement.closest(OWN)) out.push(n);
    }
    if (!out.length) {
      // 글자가 여러 조각으로 나뉜 경우: 요소 전체 글자로 다시 찾기
      for (const el of document.querySelectorAll('th, td, label, span, dt, div, strong, b')) {
        if (el.children.length < 4 && norm(el.textContent) === want && !el.closest(OWN)) out.push(el);
      }
    }
    return out;
  }

  // 라벨 뒤에 오는 입력칸들. 라벨만 있는 표 칸이면 바로 옆 칸 안에서만 찾는다.
  function fieldsAfter(node) {
    const cell = (node.nodeType === 3 ? node.parentElement : node).closest('th, td');
    if (cell && norm(cell.textContent) === norm(node.textContent) && cell.nextElementSibling) {
      const inNext = [...cell.nextElementSibling.querySelectorAll(FIELD_SEL)];
      if (inNext.length) return inNext;
      // 입력칸 없이 글자로만 보여 주는 화면 대비
      const t = cell.nextElementSibling.textContent.replace(/\s+/g, ' ').trim();
      if (t) return [{ value: t, tagName: 'TEXT' }];
    }
    return [...document.querySelectorAll(FIELD_SEL)].filter(
      (e) => node.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING
    );
  }

  function getField(label, nth = 0) {
    const n = findLabels(label)[nth];
    if (!n) return '';
    const f = fieldsAfter(n)[0];
    return f ? fieldValue(f) : '';
  }

  function getAddress() {
    const n = findLabels('건물주소')[0];
    if (!n) return '';
    const parts = fieldsAfter(n).slice(0, 4).map(fieldValue)
      .filter((v) => v && !/^\d{5,6}$/.test(v)); // 우편번호 제외
    // 다음 라벨(건물형태 등) 값이 섞이지 않도록 앞쪽 주소 칸 2개까지만 사용
    return parts.slice(0, 2).join(' ').trim();
  }

  function cellText(td) {
    const f = td.querySelector(FIELD_SEL);
    return (f ? fieldValue(f) : td.textContent).replace(/\s+/g, ' ').trim();
  }

  // 머리글 줄(headerTr) 아래의 데이터 줄들을 읽는다.
  //  - 일반 표: 같은 표의 아래 줄
  //  - 그리드 부품(SBGrid 등): 머리글 표와 본문 표가 나뉘어 있어, 둘을 감싸는 영역에서 줄 번호/열 번호로 모은다
  function rowsUnderHeader(headerTr) {
    const table = headerTr.closest('table');
    const hasCi = !!headerTr.querySelector('[data-colindex]');
    const idx = {};
    if (hasCi) {
      for (const c of headerTr.cells) {
        const ci = c.getAttribute('data-colindex'); const t = norm(c.textContent);
        if (ci != null && t && !(t in idx)) idx[t] = Number(ci);
      }
    } else {
      visualCells(headerTr).forEach((c, i) => { const t = norm(c.textContent); if (t && !(t in idx)) idx[t] = i; });
    }
    const visual = (r) => ({ cell: (i) => visualCells(r)[i] });
    const same = [...table.rows].filter((r) => r !== headerTr && !r.querySelector('th') &&
      (headerTr.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (same.length) return { idx, rows: same.map(visual) };
    // 머리글 표를 감싸는 가장 가까운 영역 중 다른 줄이 들어 있는 곳 (= 이 그리드 하나)
    let scope = table.parentElement;
    for (let i = 0; i < 8 && scope && scope !== document.body; i++) {
      if ([...scope.querySelectorAll('tr')].some((r) => !table.contains(r) && r.cells.length > 1)) break;
      scope = scope.parentElement;
    }
    if (!scope) return { idx, rows: [] };
    const trs = [...scope.querySelectorAll('tr')].filter((r) => !table.contains(r) && !r.closest(OWN));
    if (hasCi && trs.some((r) => r.querySelector('td[data-colindex]'))) {
      const byRow = new Map(); let n = 0;
      for (const tr of trs) {
        const tds = tr.querySelectorAll('td[data-colindex]');
        if (!tds.length) continue;
        const ri = tr.getAttribute('data-rowindex') ?? `n${n++}`;
        if (!byRow.has(ri)) byRow.set(ri, {});
        const rec = byRow.get(ri);
        for (const td of tds) {
          const ci = Number(td.getAttribute('data-colindex'));
          if (!rec[ci] || (!rec[ci].textContent.trim() && td.textContent.trim())) rec[ci] = td;
        }
      }
      return { idx, rows: [...byRow.values()].map((rec) => ({ cell: (i) => rec[i] })) };
    }
    return { idx, rows: trs.filter((r) => !r.querySelector('th')).map(visual) };
  }

  function energyHeader() {
    for (const tr of document.querySelectorAll('tr')) {
      if (tr.closest(OWN)) continue;
      const tx = [...tr.cells].map((c) => norm(c.textContent));
      if (tx.includes('에너지원') && tx.some((x) => x.startsWith('설치의무용량'))) return tr;
    }
    return null;
  }

  // "설치될 신·재생 에너지 설비의 개요" 표: 에너지원 / 에너지원형태 / 설치의무용량
  function getEnergy() {
    const h = energyHeader();
    if (!h) return [];
    const { idx, rows } = rowsUnderHeader(h);
    const key = (pre) => Object.keys(idx).find((k) => k.startsWith(pre));
    const iSrc = idx['에너지원'];
    const iForm = key('에너지원형태') != null ? idx[key('에너지원형태')] : -1;
    const iCap = idx[key('설치의무용량')];
    const out = [];
    for (const r of rows) {
      const c = (i) => { const td = i == null || i < 0 ? null : r.cell(i); return td ? cellText(td) : ''; };
      const src = c(iSrc);
      const cap = c(iCap);
      if (!src || !/\d/.test(cap) || norm(src) === '에너지원') continue; // 빈 줄·"데이터 없음" 줄 제외
      out.push({ source: src, form: c(iForm), cap });
    }
    return out;
  }

  // 에너지원 표를 못 읽었을 때 구조를 남겨 둔다 (진단 정보 복사에 포함)
  function energyDiag() {
    const h = energyHeader();
    if (!h) return { energy: '에너지원 머리글을 찾지 못함' };
    const t = h.closest('table');
    const near = [];
    let p = t.parentElement;
    for (let i = 0; i < 3 && p; i++) p = p.parentElement;
    if (p) [...p.querySelectorAll('table')].slice(0, 8).forEach((x, i) =>
      near.push(`${i}: rows=${x.rows.length} | ${clip(x.rows[0] ? x.rows[0].outerHTML : '', 500)}`));
    return { energy: '표는 찾았으나 줄을 읽지 못함', header: clip(h.outerHTML, 1200), near };
  }

  function extract() {
    return {
      org: getField('기관명'),
      dept: getField('담당자부서', 0), // 첫 번째 = 의무기관 담당자 부서 (두 번째는 대행업체)
      name: getField('건물명'),
      addr: getAddress(),
      start: getField('착공예정일'),
      end: getField('준공예정일'),
      energy: getEnergy(),
    };
  }

  function popupDiag() {
    const labels = [...document.querySelectorAll('th, label, dt')].slice(0, 60)
      .map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return {
      url: location.href,
      title: document.title,
      frame: isTop ? 'top' : 'iframe',
      iframes: [...document.querySelectorAll('iframe, frame')].map((f) => f.src).slice(0, 5),
      inputs: document.querySelectorAll(FIELD_SEL).length,
      labels, // 항목 이름만 (담당자 연락처 같은 입력값은 담지 않음)
    };
  }

  function topLooksPopup() {
    try {
      return !!window.top.opener || /pop\.do/i.test(window.top.location.pathname);
    } catch (e) { return false; }
  }

  async function popupMode() {
    const st = await getState();
    if (!st.running || !st.awaiting) return false;
    if (!topLooksPopup()) return false;
    if (findHeader()) return false; // 목록 페이지 자신은 팝업이 아님
    const key = st.awaiting;
    // 화면이 다 그려질 때까지 최대 15초 기다림 (값이 늦게 채워지는 화면 대비)
    // 건물명이 보이면, 날짜가 비어 있는 건일 수 있으므로 날짜는 최대 3초만 더 기다린다
    const t0 = Date.now();
    let data = null;
    let nameAt = 0;
    while (Date.now() - t0 < 15000) {
      if (findLabels('준공예정일').length) {
        data = extract();
        if (data.name && data.start && data.end) break;
        if (data.name && !nameAt) nameAt = Date.now();
        if (nameAt && Date.now() - nameAt > 3000) break;
      }
      await sleep(400);
    }
    // 에너지원 표는 다른 칸보다 늦게 그려질 수 있어 최대 6초 더 기다림
    if (data && data.name && !data.energy.length) {
      const t1 = Date.now();
      while (Date.now() - t1 < 6000 && !data.energy.length) { await sleep(400); data.energy = getEnergy(); }
      if (!data.energy.length) await set({ [POPUP_DIAG]: { url: location.href, ...energyDiag() } });
    }
    if (data && (data.name || data.end)) {
      data.url = location.href;
      await set({ [INBOX]: { key, data, at: Date.now() } });
      await sleep(200);
      send({ type: 'close-me' });
      return true;
    }
    // 이 프레임에서는 못 찾음. 다른 프레임(iframe)이 읽었는지 잠시 확인 후, 최상위 창만 실패를 알린다.
    if (!isTop) return true;
    if (!/pop\.do/i.test(location.pathname) && !window.opener) return true;
    await sleep(3000);
    const box = await get(INBOX, null);
    if (box && box.key === key) return true;
    await set({
      [POPUP_DIAG]: popupDiag(),
      [INBOX]: { key, error: '팝업에서 설치계획서 항목(준공예정일 등)을 찾지 못했습니다', at: Date.now() },
    });
    return true; // 사용자가 화면을 볼 수 있게 팝업은 닫지 않음
  }

  // =====================================================================
  // 2) 목록 페이지: 표 읽기, 페이지 넘기기
  // =====================================================================
  // 칸 합치기(colspan)를 펼쳐서 "눈에 보이는 열 번호" 기준 칸 배열을 만든다
  function visualCells(row) {
    const out = [];
    for (const c of row.cells) { const n = Math.max(1, c.colSpan || 1); for (let i = 0; i < n; i++) out.push(c); }
    return out;
  }

  function findHeader() {
    for (const tr of document.querySelectorAll('tr')) {
      if (tr.closest(OWN)) continue;
      const vc = visualCells(tr);
      const tx = vc.map((c) => norm(c.textContent));
      const name = tx.indexOf('건물명');
      const no = tx.indexOf('신청번호');
      if (name < 0 || no < 0) continue;
      // SBGrid 등 그리드 부품: 칸마다 data-colindex(열 번호)가 붙어 있으면 그것을 기준으로 한다
      let colMap = null;
      if (tr.querySelector('[data-colindex]')) {
        colMap = {};
        for (const c of tr.cells) {
          const ci = c.getAttribute('data-colindex');
          const t = norm(c.textContent);
          if (ci == null || !t) continue;
          if (!(t in colMap)) colMap[t] = Number(ci);
          else if (!((t + '#2') in colMap)) colMap[t + '#2'] = Number(ci); // 숨은 두 번째 칸 (내부 번호)
        }
      }
      const I = colMap
        ? { no: colMap['신청번호'], noHidden: colMap['신청번호#2'], name: colMap['건물명'], org: colMap['기관명'], kind: colMap['신청서구분'], first: colMap['최초신청일자'] }
        : { no, name, org: tx.indexOf('기관명'), kind: tx.indexOf('신청서구분'), first: tx.indexOf('최초신청일자') };
      return { tr, table: tr.closest('table'), cols: vc.length, I, grid: !!colMap };
    }
    return null;
  }

  const cleanText = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  // 일반 표: 머리글과 같은 표의 아래 줄, 없으면 다른 표(앞뒤 어디든)의 줄
  function bodyRows(h) {
    if (h.grid) {
      const g = gridRows(h);
      if (g.rows.length) return g;
      // 본문 칸에 열 번호가 없으면 일반 표 방식으로 (본문 칸은 합치기가 없어 열 번호 = 칸 순서)
    }
    const need = h.I.name + 1;
    const ok = (r) => {
      if (r === h.tr || r.closest(OWN)) return false;
      if (r.cells.length < 3 || visualCells(r).length < need) return false;
      if (r.querySelector('th')) return false;
      const vc = visualCells(r);
      if (norm(vc[h.I.name].textContent) === '건물명') return false; // 숨은 머리글 줄
      return r.offsetParent !== null || r.getClientRects().length > 0; // 보이는 줄만
    };
    const wrap = (rs) => rs.map((r) => ({ tr: r, cell: (i) => (i == null || i < 0 ? null : visualCells(r)[i]) }));
    const same = [...h.table.rows].filter((r) => (h.tr.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) && ok(r));
    if (same.length) return { rows: wrap(same), tables: [h.table] };
    for (const t of document.querySelectorAll('table')) {
      if (t === h.table || t.contains(h.table) || h.table.contains(t) || t.closest(OWN)) continue;
      const rs = [...t.rows].filter(ok);
      if (rs.length && Math.abs(visualCells(rs[0]).length - h.cols) <= 2) return { rows: wrap(rs), tables: [t] };
    }
    return { rows: [], tables: [] };
  }

  // 그리드 부품(SBGrid 등): 고정 열/본문 표가 나뉘어 있을 수 있어 줄 번호(data-rowindex)로 칸을 모은다
  function gridRows(h) {
    // 머리글 표와 본문 표를 함께 감싸는 영역 찾기
    let scope = h.table.parentElement;
    for (let i = 0; i < 10 && scope && scope !== document.body; i++) {
      const others = [...scope.querySelectorAll('tr')].filter((r) => !h.table.contains(r) && r.querySelector('td[data-colindex]'));
      if (others.length) break;
      scope = scope.parentElement;
    }
    scope = scope || document;
    const byRow = new Map();
    const tables = new Set();
    let n = 0;
    for (const tr of scope.querySelectorAll('tr')) {
      if (h.table.contains(tr) || tr.closest(OWN)) continue;
      const tds = tr.querySelectorAll('td[data-colindex]');
      if (!tds.length) continue;
      const ri = tr.getAttribute('data-rowindex') ?? `n${n++}`;
      if (!byRow.has(ri)) byRow.set(ri, { cells: {}, tr: null });
      const rec = byRow.get(ri);
      for (const td of tds) {
        const ci = Number(td.getAttribute('data-colindex'));
        if (!rec.cells[ci] || (!cleanText(rec.cells[ci]) && cleanText(td))) rec.cells[ci] = td;
        if (ci === h.I.name && cleanText(td)) rec.tr = tr;
      }
      tables.add(tr.closest('table'));
    }
    const rows = [];
    for (const [, rec] of byRow) {
      const nameCell = rec.cells[h.I.name];
      if (!nameCell || !cleanText(nameCell) || norm(nameCell.textContent) === '건물명') continue;
      rows.push({ tr: rec.tr || nameCell.closest('tr'), cell: (i) => (i == null || i < 0 ? null : rec.cells[i]) });
    }
    return { rows, tables: [...tables] };
  }

  function findList() {
    const h = findHeader();
    if (!h) return null;
    const body = bodyRows(h);
    const I = h.I;
    const items = [];
    for (const r of body.rows) {
      const txt = (i) => cleanText(r.cell(i));
      const cell = r.cell(I.name);
      if (!cell || !txt(I.name)) continue;
      const link = cell.querySelector('a, [onclick], button') || cell.querySelector('span') || cell;
      const no = txt(I.no);
      const hidden = I.noHidden != null ? txt(I.noHidden) : '';
      const name = (link.getAttribute && link.getAttribute('title')) || txt(I.name);
      const key = /^\d{6,}$/.test(no) ? no
        : /^\d{6,}$/.test(hidden) ? `ID${hidden}` // 작성중(신청번호 없음) 건은 그리드 내부 번호 사용
          : `${txt(I.org)}|${txt(I.name)}|${txt(I.kind)}|${txt(I.first)}`;
      items.push({ key, no, org: txt(I.org), name: name.trim(), kind: txt(I.kind), link, row: r.tr || cell.closest('tr') });
    }
    return { header: h, tables: [h.table, ...body.tables].filter(Boolean), items };
  }

  // 페이지 번호 묶음(1 2 3 …)을 찾는다
  function findPager(tables) {
    const inTables = (e) => tables.some((t) => t.contains(e));
    const nums = [...document.querySelectorAll('a, span, strong, em, b, button, li')].filter((e) => {
      if (inTables(e) || e.closest(OWN)) return false;
      return /^\d{1,3}$/.test(e.textContent.trim()) && e.children.length === 0;
    });
    const groups = new Map();
    for (const e of nums) {
      const box = e.closest('div, p, ul, nav, td') || e.parentElement;
      if (!groups.has(box)) groups.set(box, []);
      groups.get(box).push(e);
    }
    let best = null;
    for (const [box, list] of groups) if (!best || list.length > best.list.length) best = { box, list };
    if (!best) return null;
    const curRe = /(^|\s)(on|active|current|sel|selected|now|this)(\s|$)/i;
    const isCur = (e) => (e.tagName !== 'A' && e.tagName !== 'BUTTON' && !e.closest('a, button'))
      || curRe.test(e.className + ' ' + (e.parentElement?.className || ''))
      || e.getAttribute('aria-current') || e.getAttribute('title') === '현재페이지';
    const curEl = best.list.find(isCur);
    const cur = curEl ? Number(curEl.textContent.trim()) : 1;
    const clickable = (e) => e.closest('a, button') || e;
    const byNum = (n) => { const e = best.list.find((x) => Number(x.textContent.trim()) === n); return e ? clickable(e) : null; };
    let next = byNum(cur + 1);
    if (!next) {
      next = [...best.box.querySelectorAll('a, button')].find((a) => {
        const t = (a.textContent + ' ' + (a.title || '') + ' ' + (a.getAttribute('aria-label') || '') + ' ' + a.className + ' ' +
          [...a.querySelectorAll('img')].map((i) => i.alt).join(' ')).toLowerCase();
        return /다음|next|›|»|>/.test(t) && !/마지막|last|끝|end/.test(t);
      }) || null;
    }
    return { cur, next, first: cur > 1 ? byNum(1) : null, box: best.box };
  }

  function signature() {
    const l = findList();
    if (!l) return '';
    const p = findPager(l.tables);
    return l.items.map((x) => x.key).join(',') + '#' + (p ? p.cur : '');
  }

  async function waitChange(sig, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      await sleep(500);
      if (signature() !== sig) { await sleep(800); return true; }
    }
    return false;
  }

  // =====================================================================
  // 3) 크롤링 실행
  // =====================================================================
  const ymd = (s) => {
    const d = String(s || '').replace(/\D/g, '');
    if (d.length !== 8) return null;
    return new Date(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)));
  };
  const fmtDate = (s) => {
    const d = String(s || '').replace(/\D/g, '');
    return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : String(s || '');
  };
  const todayStart = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };

  function toSheetRow(d, key) {
    return {
      _key: key,
      A: d.org,
      B: d.name,
      C: d.addr,
      H: fmtDate(d.start),
      I: fmtDate(d.end),
      J: d.dept,
      R: (d.energy || []).map(energyText).join('\n'),
    };
  }

  const energyText = (e) => `${e.source}${e.form ? ' ' + e.form : ''}: ${e.cap} kW`;

  // 나라 앱 받는 주소(POST /api/nr-plans)의 한 행
  function toNaraRow(d, key) {
    return {
      key,
      org: d.org,
      name: d.name,
      addr: d.addr,
      start: fmtDate(d.start),
      end: fmtDate(d.end),
      dept: d.dept,
      energy: (d.energy || []).map((e) => ({
        source: e.source, form: e.form, capacity_kw: Number(String(e.cap).replace(/,/g, '')),
      })).filter((e) => e.capacity_kw > 0),
    };
  }

  // 목록의 건물명(말줄임 … 가능)과 팝업 건물명이 같은 건물인지
  function sameBuilding(listName, popupName) {
    const a = norm(listName).replace(/(\.\.\.|…)+$/, '');
    const b = norm(popupName);
    if (!a || !b) return true;
    return b.startsWith(a) || a.startsWith(b);
  }

  async function waitInbox(key, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const box = await get(INBOX, null);
      if (box && box.key === key) return box;
      const st = await getState();
      if (!st.running) return null;
      await sleep(300);
    }
    return null;
  }

  // 사이트 링크를 페이지 자신의 실행 환경에서 누른다 (javascript: 링크 대응)
  async function pageClick(el) {
    const tok = Math.random().toString(36).slice(2);
    el.setAttribute('data-nrcrawl-click', tok);
    const r = await send({ type: 'main-click', token: tok });
    if (!r || !r.ok) { el.removeAttribute('data-nrcrawl-click'); el.click(); }
  }

  function highlight(it, on) {
    for (const el of document.querySelectorAll('.nrcrawl-target, .nrcrawl-row')) el.classList.remove('nrcrawl-target', 'nrcrawl-row');
    if (on && it) {
      it.row.classList.add('nrcrawl-row');
      it.link.classList.add('nrcrawl-target');
      it.row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  // 한 건 처리: 팝업 열기 → 값 받기. 성공하면 { data }, 실패하면 { error }
  async function openOne(it) {
    await set({ [INBOX]: null });
    let st = await patchState({ awaiting: it.key });
    let box = null;

    if (!st.assist) {
      const clickAt = Date.now();
      ui(`여는 중: ${it.name}`);
      await pageClick(it.link);
      box = await waitInbox(it.key, 8000);
      if (!box) {
        const seen = await get(POPUP_SEEN, null);
        if (seen && seen.at >= clickAt - 500) {
          ui(`팝업이 열려 내용을 기다리는 중: ${it.name}`);
          box = await waitInbox(it.key, 20000);
        } else {
          st = await patchState({ assist: true });
        }
      }
    }
    if (!box && st.assist && st.running) {
      highlight(it, true);
      ui(`팝업이 자동으로 열리지 않아 직접 클릭 모드로 바꿨습니다. 노란색으로 표시된 "${it.name}"을(를) 직접 눌러 주세요.`);
      while (!box) {
        box = await waitInbox(it.key, 600000);
        if (!box) break;
        if (box.data && !sameBuilding(it.name, box.data.name)) {
          ui(`다른 건물(${box.data.name})이 열렸습니다. 노란색으로 표시된 "${it.name}"을(를) 눌러 주세요.`);
          await set({ [INBOX]: null });
          box = null;
        }
      }
      highlight(it, false);
    }
    await patchState({ awaiting: null });
    if (!box) return { error: `팝업 응답 없음: ${it.name}` };
    if (box.error) return { error: box.error };
    if (!sameBuilding(it.name, box.data.name)) return { error: `다른 건물이 열렸습니다: ${box.data.name}` };
    return { data: box.data };
  }

  let running = false;
  async function runCrawl() {
    if (running) return;
    running = true;
    let failStreak = 0;
    try {
      while (true) {
        const list = findList();
        if (!list) { await finish('신청서 목록 표를 찾지 못했습니다. "진단 정보 복사"를 눌러 보내 주세요.'); return; }
        const settings = await new Promise((r) => chrome.storage.sync.get({ sheetUrl: '', naraUrl: '', crawlDelay: 1000 }, r));
        const pg = findPager(list.tables);
        ui(`${pg ? pg.cur : 1}페이지: 목록 ${list.items.length}건`);
        if (!list.items.length) await sleep(1000);

        for (const it of list.items) {
          let st = await getState();
          if (!st.running) { ui(); return; }
          const log = await get(LOG, {});
          const all = !!st.all;
          // 이미 처리한 건은 건너뜀. 단, 일정이 비어 제외했던 건은 그 사이 입력됐을 수 있어 다시 확인.
          // 전체 받기면 준공 경과로 제외했던 건도 다시 열어 받는다
          const prev = log[it.key] && log[it.key].status;
          if (prev && prev !== 'nodate' && !(all && prev === 'past')) continue;

          const res = await openOne(it);
          st = await getState();
          if (!st.running) { ui(); return; }
          const stats = st.stats || {};

          if (res.error) {
            stats.error = (stats.error || 0) + 1;
            failStreak++;
            await patchState({ stats, lastError: res.error });
            if (failStreak >= 2) { await finish(`${res.error} — 연속 실패로 멈췄습니다. "진단 정보 복사"를 눌러 보내 주세요.`); return; }
            ui(res.error);
            await sleep(500);
            continue;
          }
          failStreak = 0;
          const d = res.data;
          const end = ymd(d.end);
          const noDate = !ymd(d.start) || !end;
          const past = !!end && end < todayStart();
          const entry = { org: d.org || it.org, name: d.name || it.name, end: fmtDate(d.end), at: new Date().toISOString() };
          // 전체 받기면 날짜 조건으로 빼지 않고 기록에 표시만 남긴다 (설정 페이지 작업 기록에 보임)
          if (all && noDate) entry.nodate = true;
          if (all && past) entry.past = true;

          if (!all && noDate) {
            // 착공예정일 또는 준공예정일이 비어 있으면 시트에 쓰지 않음
            log[it.key] = { ...entry, status: 'nodate', start: fmtDate(d.start) };
            stats.nodate = (stats.nodate || 0) + 1;
          } else if (!all && past) {
            log[it.key] = { ...entry, status: 'past' };
            stats.past = (stats.past || 0) + 1;
          } else {
            if (noDate) stats.nodate = (stats.nodate || 0) + 1;
            if (past) stats.past = (stats.past || 0) + 1;
            const row = toSheetRow(d, it.key);
            const results = await get(RESULTS, []);
            results.push(row);
            await set({ [RESULTS]: results });
            if (settings.sheetUrl) {
              const resp = await send({ type: 'sheet-append', rows: [row] });
              const r = resp && resp.ok && resp.results && resp.results[0];
              if (r && (r.status === 'written' || r.status === 'exists')) {
                log[it.key] = { ...entry, status: r.status, row: r.row };
                stats[r.status] = (stats[r.status] || 0) + 1;
              } else {
                stats.error = (stats.error || 0) + 1;
                const msg = `시트 저장 실패: ${(resp && resp.error) || '응답 없음'}`;
                await patchState({ stats, lastError: msg });
                await finish(`${msg} — 설정 4번에서 연결 테스트를 해 보세요.`);
                return;
              }
            } else {
              log[it.key] = { ...entry, status: 'collected' };
              stats.collected = (stats.collected || 0) + 1;
            }
            if (settings.naraUrl) {
              const resp = await send({ type: 'nara-send', rows: [toNaraRow(d, it.key)] });
              const r = resp && resp.ok && resp.results && resp.results[0];
              if (!r || r.saved === 'invalid') {
                // 기록하지 않고 멈춘다 — 다음 실행 때 이 건부터 다시 보낸다
                delete log[it.key];
                stats.error = (stats.error || 0) + 1;
                const msg = `나라 앱 전송 실패: ${(r && r.error) || (resp && resp.error) || '응답 없음'}`;
                await patchState({ stats, lastError: msg });
                await finish(`${msg} — 설정 5번에서 연결 테스트를 해 보세요.`);
                return;
              }
              log[it.key].nara = r.match;
              stats.nara = (stats.nara || 0) + 1;
            }
          }
          await set({ [LOG]: log });
          await patchState({ stats });
          ui();
          await sleep(Number(settings.crawlDelay) || 1000);
        }

        // 다음 페이지
        const pager = findPager(list.tables);
        if (!pager || !pager.next) { await finish('모든 페이지를 처리했습니다.'); return; }
        const sig = signature();
        await patchState({ page: pager.cur + 1 });
        ui(`${pager.cur + 1}페이지로 이동`);
        await pageClick(pager.next);
        if (!(await waitChange(sig, 20000))) { await finish('다음 페이지로 넘어가지 않아 종료했습니다. "진단 정보 복사"를 눌러 보내 주세요.'); return; }
      }
    } finally {
      running = false;
    }
  }

  async function finish(msg) {
    highlight(null, false);
    await patchState({ running: false, awaiting: null, endedAt: new Date().toISOString(), lastMessage: msg });
    try { sessionStorage.removeItem('nrcrawl'); } catch (e) { /* ignore */ }
    ui(msg);
  }

  // =====================================================================
  // 4) 진단 정보 (실제 사이트 구조가 예상과 다를 때 보내 받기 위한 요약)
  // =====================================================================
  async function diagnostics() {
    const out = [];
    const line = (k, v) => out.push(`## ${k}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 1)}`);
    line('버전/주소', `${VERSION} | ${location.href} | ${isTop ? 'top' : 'iframe'} | ${new Date().toISOString()}`);
    const h = findHeader();
    line('머리글', h ? { cols: h.cols, I: h.I, headerHtml: clip(h.tr.outerHTML, 1200) } : '찾지 못함');
    if (h) {
      const b = bodyRows(h);
      line('본문 줄 수', `${b.rows.length} (그리드: ${h.grid ? '예' : '아니오'}, 본문 표 ${b.tables.length}개)`);
      b.rows.slice(0, 2).forEach((r, i) => line(`본문 ${i + 1}번째 줄 HTML`, clip(r.tr && r.tr.outerHTML, 1500)));
      const l = findList();
      line('읽은 항목(앞 3건)', l.items.slice(0, 3).map((x) => ({ key: x.key, name: x.name, link: clip(x.link.outerHTML, 300) })));
      const p = findPager(l.tables);
      line('페이지 번호', p ? { cur: p.cur, next: p.next ? clip(p.next.outerHTML, 300) : null, box: clip(p.box.outerHTML, 1200) } : '찾지 못함');
    }
    line('표 목록', [...document.querySelectorAll('table')].slice(0, 15).map((t, i) =>
      `${i}: rows=${t.rows.length} | ${clip((t.rows[0]?.textContent || '').replace(/\s+/g, ' ').trim(), 120)}`).join('\n'));
    line('iframe', [...document.querySelectorAll('iframe, frame')].map((f) => f.src).join('\n') || '없음');
    line('상태', await getState());
    line('팝업 감지', await get(POPUP_SEEN, null));
    line('팝업 진단', await get(POPUP_DIAG, null));
    return out.join('\n\n');
  }

  // =====================================================================
  // 5) 목록 페이지 위 작은 패널
  // =====================================================================
  let panel = null;
  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'nrcrawl-panel';
    panel.innerHTML = `
      <div class="nrcrawl-head"><strong>설치계획 크롤링</strong><button type="button" data-act="settings">설정</button></div>
      <div class="nrcrawl-body">
        <div class="nrcrawl-actions">
          <button type="button" class="nrcrawl-btn" data-act="start">크롤링 시작</button>
          <button type="button" class="nrcrawl-btn secondary" data-act="stop">중지</button>
        </div>
        <label class="nrcrawl-opt" title="준공예정일이 지났거나 착공·준공일이 비어 있는 건도 모두 받습니다. 전에 그 이유로 제외한 건도 다시 엽니다"><input type="checkbox" id="nrcrawl-all"> 준공일 조건 없이 전체 받기</label>
        <div class="nrcrawl-stats" id="nrcrawl-stats"></div>
        <div class="nrcrawl-msg" id="nrcrawl-msg"></div>
        <div class="nrcrawl-foot"><span id="nrcrawl-foot"></span><a data-act="diag">진단 정보 복사</a></div>
      </div>`;
    document.documentElement.appendChild(panel);
    placePanel();
    setTimeout(placePanel, 2000);
    chrome.storage.sync.get({ [ALL]: false }, (s) => { panel.querySelector('#nrcrawl-all').checked = !!s[ALL]; });
    panel.querySelector('#nrcrawl-all').addEventListener('change', (e) => {
      chrome.storage.sync.set({ [ALL]: e.target.checked });
      ui(e.target.checked ? '다음 시작부터 준공일 조건 없이 전체 받습니다.' : '다음 시작부터 준공일이 지난 건을 제외합니다.');
    });
    panel.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'settings') send({ type: 'open-options' });
      if (act === 'start') start();
      if (act === 'stop') {
        highlight(null, false);
        await patchState({ running: false, awaiting: null, lastMessage: '사용자가 중지했습니다.' });
        try { sessionStorage.removeItem('nrcrawl'); } catch (er) { /* */ }
        ui('중지했습니다.');
      }
      if (act === 'diag') {
        e.preventDefault();
        const text = await diagnostics();
        try { await navigator.clipboard.writeText(text); ui('진단 정보를 복사했습니다. 채팅에 붙여넣어 보내 주세요.'); }
        catch (er) { console.log(text); ui('복사에 실패했습니다. F12 → Console 탭의 내용을 보내 주세요.'); }
      }
    });
    ui();
  }

  // 로그인 자동입력 패널이 오른쪽 아래에 있으면 그 왼쪽에 둔다
  function placePanel() {
    if (!panel) return;
    const other = document.getElementById('nrfill-panel');
    panel.style.right = other ? `${16 + other.getBoundingClientRect().width + 12}px` : '16px';
  }

  async function start() {
    const { sheetUrl, naraUrl, [ALL]: all } = await new Promise((r) => chrome.storage.sync.get({ sheetUrl: '', naraUrl: '', [ALL]: false }, r));
    if (!sheetUrl && !naraUrl && !confirm('구글 시트 연결(설정 4번)이 아직 없습니다.\n시트에 쓰지 않고 수집만 할까요? (설정 페이지에서 결과를 복사할 수 있습니다)')) return;
    try { sessionStorage.setItem('nrcrawl', '1'); } catch (e) { /* ignore */ }
    await set({ [STATE]: { running: true, awaiting: null, assist: false, page: 1, stats: {}, startedAt: new Date().toISOString(), all: !!all }, [POPUP_DIAG]: null });
    ui(all ? '시작합니다 — 준공일 조건 없이 전체 받습니다.' : '시작합니다.');
    // 2페이지 이후에서 시작했다면 1페이지로 먼저 이동
    const l = findList();
    const p = l && findPager(l.tables);
    if (p && p.first) {
      ui('1페이지로 이동합니다.');
      const sig = signature();
      await pageClick(p.first);
      await waitChange(sig, 15000); // 새로고침되는 사이트면 새 화면에서 이어서 진행
    }
    runCrawl();
  }

  // 상태를 비동기로 읽는 사이 더 새 호출이 들어오면 옛 호출은 그리지 않는다.
  // 끝나는 순간 두 호출이 겹치면 '실행 중'을 읽은 옛 쪽이 나중에 그려 버튼이 잠긴 채 남았다.
  let uiSeq = 0;
  async function ui(msg) {
    if (!panel) return;
    const seq = ++uiSeq;
    const st = await getState();
    const s = st.stats || {};
    const log = await get(LOG, {});
    if (seq !== uiSeq) return;
    panel.querySelector('[data-act="start"]').disabled = !!st.running;
    panel.querySelector('[data-act="stop"]').disabled = !st.running;
    panel.querySelector('#nrcrawl-all').disabled = !!st.running;
    const how = st.all ? '포함' : '제외';
    panel.querySelector('#nrcrawl-stats').innerHTML =
      `<span>시트 작성 <b>${s.written || 0}</b></span><span>수집 <b>${s.collected || 0}</b></span><span>나라 앱 <b>${s.nara || 0}</b></span>` +
      `<span>준공 경과 ${how} <b>${s.past || 0}</b></span><span>시트에 이미 있음 <b>${s.exists || 0}</b></span><span>일정 없음 ${how} <b>${s.nodate || 0}</b></span><span>오류 <b>${s.error || 0}</b></span>` +
      (st.running && st.assist ? '<span class="assist">직접 클릭 모드</span>' : '');
    const m = panel.querySelector('#nrcrawl-msg');
    m.textContent = msg || st.lastMessage || (st.running ? '진행 중…' : '대기 중');
    panel.querySelector('#nrcrawl-foot').textContent = `작업 기록 ${Object.keys(log).length}건`;
  }

  // =====================================================================
  // 시작점
  // =====================================================================
  (async function init() {
    // 팝업이면 값 읽고 끝
    if (await popupMode()) return;
    if (!isTop) return;
    // 목록 페이지가 늦게 그려질 수 있어 잠시 기다림
    let h = null;
    for (let i = 0; i < 20 && !(h = findHeader()); i++) await sleep(300);
    if (!h) return;
    buildPanel();
    const st = await getState();
    let mine = false;
    try { mine = sessionStorage.getItem('nrcrawl') === '1'; } catch (e) { /* ignore */ }
    if (st.running && mine) { ui('이어서 진행합니다.'); await sleep(800); runCrawl(); }
    else if (st.running && !mine) { ui('다른 탭에서 진행 중입니다.'); }
  })();

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && panel && (ch[STATE] || ch[LOG])) ui();
  });

  // 테스트·디버그용
  window.__nrCrawl = { extract, findList, findPager, diagnostics };
})();
