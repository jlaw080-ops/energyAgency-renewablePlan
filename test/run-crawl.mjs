// 설치계획 크롤링 E2E 테스트
// - 가짜 목록 페이지(2페이지, 페이지 이동 시 새로고침), 가짜 설치계획서 팝업, 가짜 구글 시트(Apps Script) 서버를 띄우고
//   실제 Chromium 에 확장 프로그램을 올려 크롤링 전 과정을 검증한다.
// 실행: node test/run-crawl.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright');
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = path.join(root, 'test/output'); fs.mkdirSync(outDir, { recursive: true });
const extDir = path.join(outDir, 'ext-crawl'); fs.rmSync(extDir, { recursive: true, force: true });
fs.cpSync(path.join(root, 'extension'), extDir, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
mf.content_scripts[0].matches = ['http://127.0.0.1/*'];
mf.host_permissions.push('http://127.0.0.1/*');
mf.web_accessible_resources[0].matches = ['http://127.0.0.1/*'];
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(mf, null, 2));

// ---------- 가짜 데이터 ----------
const P = [
  { no: '2603040001', org: '서울특별시', dept: '미래공간담당관', name: '노들섬 하늘예술정원 조성사업', zip: '04427', addr: '서울특별시 용산구 양녕로 445 446 일대 (이촌동)', start: '20260701', end: '20280331',
    energy: [['지열', '수직밀폐형', '336.060'], ['태양광', 'BIPV', '17.544']] },
  { no: '2608280007', org: '서울특별시', dept: '공공개발과', name: '홍릉 연구개발(R&D) 지원센터 신축공사', zip: '02455', addr: '서울특별시 동대문구 회기로 1', start: '20250301', end: '20271231',
    energy: [['태양광', '건물부착형', '45.200']] },
  { no: '2512260024', org: '서울특별시', dept: '건강정책과', name: '홍릉 첨단의료기기개발센터', zip: '02456', addr: '서울특별시 동대문구 회기로 2', start: '20220101', end: '20231231', // 준공 경과 → 제외
    energy: [['태양광', 'BIPV', '10.000']] },
  { no: '-', org: '서울특별시', dept: '동물보호과', name: '서울 반려동물 테마파크 조성', zip: '01234', addr: '서울특별시 마포구 1', start: '20270101', end: '20290630', kind: '설치계획', first: '',
    energy: [['연료전지', 'PEMFC', '30.000']] },
  { no: '2310180004', org: '서울특별시', dept: '농수산과', name: '양곡도매시장', zip: '06789', addr: '서울특별시 양천구 1', start: '20230101', end: '20200101', // 경과
    energy: [] },
];
// 착공예정일 또는 준공예정일이 비어 있는 건 → 제외, 다음 실행 때 다시 확인
P.push(
  { no: '2401010001', org: '서울특별시', dept: '체육정책과', name: '잠실 체육시설 리모델링', zip: '05500', addr: '서울특별시 송파구 1', start: '', end: '20290101',
    energy: [['태양광', '건물부착형', '12.000']] },
  { no: '2401010002', org: '서울특별시', dept: '문화정책과', name: '마포 문화센터 신축', zip: '04000', addr: '서울특별시 마포구 2', start: '20270101', end: '',
    energy: [['지열', '수직밀폐형', '50.000']] },
);
const pages = [P.slice(0, 3), P.slice(3)];
const byId = Object.fromEntries(P.map((p, i) => [p.no === '-' ? 'draft' + i : p.no, p]));
const idOf = (p) => Object.keys(byId).find((k) => byId[k] === p);

// 목록 화면 변형
//  A: 머리글+본문 한 표, 페이지 이동 시 새로고침, javascript: 링크
//  B: 머리글 표와 본문 표가 따로(본문 표에 숨은 머리글 줄), 새로고침 없는 페이지 이동, onclick 링크,
//     건물명 말줄임(…), 2페이지에서 시작, 팝업 내용이 iframe 안에 있음
//  C: A와 같지만 사람이 직접 누른 클릭에만 팝업이 열림 → 직접 클릭 모드 검증
function rowsHtml(page, v) {
  return pages[page - 1].map((p) => {
    const nm = v === 'B' && p.name.length > 12 ? p.name.slice(0, 10) + '…' : p.name;
    const link = v === 'B' ? `<a href="#" onclick="fn_view('${idOf(p)}');return false;">${nm}</a>`
      : v === 'C' ? `<a href="#" onclick="if(event.isTrusted) fn_view('${idOf(p)}');return false;">${nm}</a>`
      : `<a href="javascript:fn_view('${idOf(p)}')">${nm}</a>`;
    return `<tr><td>${p.no}</td><td>${p.org}</td><td>${link}</td><td>${p.kind || '설치계획'}</td><td>2026-03-04</td><td>보완요청</td></tr>`;
  }).join('');
}
function pagerHtml(page, v) {
  return [1, 2].map((n) => v === 'B'
    ? `<a href="#" class="${n === page ? 'on' : ''}" onclick="go(${n});return false;">${n}</a>`
    : (n === page ? `<strong class="on">${n}</strong>` : `<a href="?v=${v}&page=${n}">${n}</a>`)).join(' ');
}
// D: 실제 사이트(SBGrid) 구조 흉내 — 본문 표가 먼저, 머리글 표가 뒤에. 신청번호 칸이 2개(두 번째는 숨은 내부 번호),
//    모든 칸에 data-colindex(E는 본문 칸에 열 번호 없음), 빈 채움 줄, 링크 없이 그리드 영역 클릭 감지, ul>li>a.active 페이지 번호, 2페이지에서 시작
const iidOf = (p) => '20191119' + String(P.indexOf(p) + 10).padStart(4, '0');
function sbRows(page, noCol) {
  const td = (ci, v, hide) => `<td class="sbgrid_cell"${noCol ? '' : ` data-colindex="${ci}"`}${hide ? ' style="display:none"' : ''}><span class="sbgrid_common">${v}</span></td>`;
  const rows = pages[page - 1].map((p, ri) => `<tr data-rowindex="${ri + 1}" class="sbgrid_common">${td(0, p.no)}${td(1, iidOf(p), true)}${td(2, p.org)}${td(3, p.name)}${td(4, p.kind || '설치계획')}${td(5, '2019-11-19')}${td(6, '작성중')}</tr>`);
  while (rows.length < 6) rows.push(`<tr data-rowindex="${rows.length + 1}">${[0, 1, 2, 3, 4, 5, 6].map((c) => td(c, '', c === 1)).join('')}</tr>`);
  const fixed = rows.map((_, ri) => `<tr data-rowindex="${ri + 1}"><td data-colindex="0"></td></tr>`).join('');
  return `<table class="fixed">${fixed}</table><table class="main">${rows.join('')}</table>`;
}
function sbPager(page) {
  return `<ul class="sbgrid_PUI_PN sbgrid_PUI_PN_st">${[1, 2].map((n) => `<li class="sbgrid_PUI_NLI"><a${n === page ? ' class="active"' : ''} data-page="${n}">${n}</a></li>`).join('')}</ul>`;
}
const SB_HEAD = '<table class="head"><tr data-rowindex="0" class="sbgrid_common"><td data-colindex="0" colspan="2"><span>신청번호</span></td><td data-colindex="1" style="display:none"><span>신청번호</span></td><td data-colindex="2"><span>기관명</span></td><td data-colindex="3"><span>건물명</span></td><td data-colindex="4"><span>신청서구분</span></td><td data-colindex="5"><span>최초신청일자</span></td><td data-colindex="6"><span>진행상태</span></td></tr></table>';

const HEAD = '<tr><th>신청번호</th><th>기관명</th><th>건물명</th><th>신청서구분</th><th>최초신청일자</th><th>진행상태</th></tr>';
function listHtml(page, v) {
  if (v === 'D' || v === 'E') {
    const nc = v === 'E';
    const data = JSON.stringify([1, 2].map((n) => ({ body: sbRows(n, nc), pager: sbPager(n) })));
    const map = JSON.stringify(Object.fromEntries(P.map((p) => [iidOf(p), idOf(p)])));
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>목록</title></head><body>
    <div id="SBGridArea"><div id="sbBody">${sbRows(2, nc)}</div>${SB_HEAD}<div id="sbPage">${sbPager(2)}</div></div>
    <script>var D=${data}, M=${map};
      function fn_view(iid){ window.open('/C0/C0_02/C0_02_01_010_cstpop.do?sb=1&id='+M[iid],'cstpop','width=1200,height=900'); }
      document.getElementById('SBGridArea').addEventListener('click', function(e){
        var a = e.target.closest('a[data-page]');
        if (a) { var n=+a.dataset.page; setTimeout(function(){ document.getElementById('sbBody').innerHTML=D[n-1].body; document.getElementById('sbPage').innerHTML=D[n-1].pager; }, 300); return; }
        var td = e.target.closest('table.main td');
        if (td && td.cellIndex === 3 && td.textContent.trim()) fn_view(td.parentElement.cells[1].textContent.trim());
      });
    </script></body></html>`;
  }
  const popupPath = v === 'B' ? '/C0/C0_02/C0_02_01_010_cstpop.do?frame=1&id=' : '/C0/C0_02/C0_02_01_010_cstpop.do?id=';
  if (v === 'B') {
    const data = JSON.stringify([1, 2].map((n) => ({ rows: rowsHtml(n, v), pager: pagerHtml(n, v) })));
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>목록</title>
    <script>var D=${data};function fn_view(id){ window.open('${popupPath}'+id,'cstpop','width=1200,height=900'); }
    function go(n){ setTimeout(function(){ document.getElementById('body').innerHTML=D[n-1].rows; document.getElementById('pg').innerHTML=D[n-1].pager; }, 400); }</script></head>
    <body><div class="grid-head"><table border="1"><thead>${HEAD}</thead></table></div>
    <div class="grid-body" style="height:300px;overflow:auto"><table border="1"><thead style="display:none">${HEAD}</thead><tbody id="body">${rowsHtml(2, v)}</tbody></table></div>
    <div class="paging" id="pg">${pagerHtml(2, v)}</div></body></html>`;
  }
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>목록</title>
  <script>function fn_view(id){ window.open('${popupPath}'+id,'cstpop','width=1200,height=900'); }</script></head>
  <body><table border="1"><thead>${HEAD}</thead>
  <tbody>${rowsHtml(page, v)}</tbody></table><div class="paging">${pagerHtml(page, v)}</div></body></html>`;
}

// SBGrid 흉내 에너지원 표: 본문 표가 먼저, 머리글 표가 뒤. 숨은 열 포함, 빈 채움 줄, 늦게 그려짐
function sbEnergy(p) {
  const td = (ci, v, hide) => `<td data-colindex="${ci}"${hide ? ' style="display:none"' : ''}><span>${v}</span></td>`;
  const rows = p.energy.map((e, i) => `<tr data-rowindex="${i + 1}">${td(0, i + 1)}${td(1, 'X' + i, true)}${td(2, `<a href="#">${e[0]}</a>`)}${td(3, e[1])}${td(4, e[2])}${td(5, '864')}${td(6, '1.26')}${td(7, '365,848.36')}</tr>`);
  while (rows.length < 4) rows.push(`<tr data-rowindex="${rows.length + 1}">${[0, 1, 2, 3, 4, 5, 6, 7].map((c) => td(c, '', c === 1)).join('')}</tr>`);
  const head = `<tr data-rowindex="0">${td(0, '순번')}${td(1, '숨김', true)}${td(2, '에너지원')}${td(3, '에너지원형태')}${td(4, '설치의무용량')}${td(5, '단위에너지생산량')}${td(6, '보정계수')}${td(7, '신재생에너지 생산량(kwh/yr)')}</tr>`;
  return `<div class="sbgrid_area"><div class="sb_body"><table>${rows.join('')}</table></div><div class="sb_head"><table>${head}</table></div></div>`;
}
// 그 아래 두 번째 그리드(건축용도) — 이 숫자가 에너지원으로 섞이면 안 됨
function sbUse() {
  const td = (ci, v) => `<td data-colindex="${ci}"><span>${v}</span></td>`;
  return `<div class="sbgrid_area"><div class="sb_body"><table><tr data-rowindex="1">${td(0, 1)}${td(1, '문화시설')}${td(2, '2748.42')}${td(3, '999')}</tr></table></div>` +
    `<div class="sb_head"><table><tr data-rowindex="0">${td(0, '순번')}${td(1, '건축용도')}${td(2, '건축 연면적')}${td(3, '단위에너지사용량')}</tr></table></div></div>`;
}

function popupHtml(id, sb) {
  const p = byId[id];
  const en = p.energy.map((e, i) => `<tr><td>${i + 1}</td><td><a href="#">${e[0]}</a></td><td>${e[1]}</td><td>${e[2]}</td><td>864</td><td>1.26</td><td>1</td><td><button>수정</button></td></tr>`).join('');
  // 실제 화면처럼 값은 페이지가 뜬 뒤 스크립트로 채운다
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>설치계획서</title></head><body>
  <h3>기관개요</h3>
  <table border="1">
   <tr><th>신청번호</th><td>${p.no}</td><th>신청구분</th><td><select><option>설치계획</option></select></td><th><span>*</span>대표자명</th><td><input id="rep" value=""></td></tr>
   <tr><th><span style="color:red">*</span>기관명</th><td><input id="orgNm"></td><th>사업자 등록번호</th><td><input value="104-83-00469"></td></tr>
   <tr><th rowspan="2">*의무기관</th><th>*담당자 이름</th><td><input value="이상봉"></td><th>*담당자 전화</th><td><input value="02-2133-7642"></td></tr>
   <tr><th>*담당자 부서</th><td><input id="dept"></td><th>*담당자 이동전화</th><td><input value="010-6404-1250"></td></tr>
   <tr><th rowspan="2">대행업체</th><th>*담당자 이름</th><td><input value="이승훈"></td></tr>
   <tr><th>*담당자 부서</th><td><input value="설계부"></td></tr>
  </table>
  <h3>건축물 개요</h3>
  <table border="1">
   <tr><th>*건물명</th><td><input id="bldNm" size="60"></td><th>*건축물 용도</th><td><select><option>문화 및 집회시설</option></select></td></tr>
   <tr><th>*건물 주소</th><td><button type="button">우편번호</button><input id="zip"><input id="addr" size="50"></td>
       <th>*건물 형태</th><td><input type="radio" name="t">신축 <input type="radio" name="t" checked>증축</td></tr>
   <tr><th>*허가연면적</th><td>*지 상 중 : <input value="2748.42">㎡</td></tr>
   <tr><th>*진행 일정</th><td>*허가 예정일 : <input value="20260131"><img alt="달력">
       *착공예정일 : <input id="st"><img alt="달력"> *준공예정일 : <input id="ed"><img alt="달력"></td></tr>
   <tr><th>설치될 신·재생 에너지 설비의 개요</th><td>${sb ? '<div id="enGrid"></div><div id="useGrid"></div>' : `
     <table border="1"><tr><th>순번</th><th>에너지원</th><th>에너지원형태</th><th>설치의무용량</th><th>단위에너지생산량</th><th>보정계수</th><th>신재생에너지 생산량(kwh/yr)</th><th>수정</th></tr>${en}</table>`}
   </td></tr>
  </table>
  <script>
   setTimeout(function(){
     document.getElementById('orgNm').value=${JSON.stringify(p.org)};
     document.getElementById('dept').value=${JSON.stringify(p.dept)};
     document.getElementById('bldNm').value=${JSON.stringify(p.name)};
     document.getElementById('zip').value=${JSON.stringify(p.zip)};
     document.getElementById('addr').value=${JSON.stringify(p.addr)};
     document.getElementById('st').value=${JSON.stringify(p.start)};
     document.getElementById('ed').value=${JSON.stringify(p.end)};
   }, 300);
   ${sb ? `setTimeout(function(){ document.getElementById('enGrid').innerHTML=${JSON.stringify(sbEnergy(p))}; document.getElementById('useGrid').innerHTML=${JSON.stringify(sbUse())}; }, 1500);` : ''}
  </script></body></html>`;
}

// ---------- 가짜 구글 시트 (Apps Script 동작 흉내) ----------
const SHEET0 = [{ A: '수요기관', B: '공고명' }, { A: '서울특별시', B: '홍릉 연구개발(R&D) 지원센터 신축공사' }]; // 2행에 이미 있는 건 하나
let sheet = SHEET0.map((r) => ({ ...r }));
const tokens = new Set();
let popupsOpened = 0;
// ---------- 가짜 나라 앱 (POST /api/nr-plans, GET /api/nr-plans/ping, Bearer 토큰) ----------
const NARA_TOKEN = 'test-import-token';
let naraRows = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/nara/api/nr-plans')) {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${NARA_TOKEN}`) { res.statusCode = 401; return res.end('{"ok":false}'); }
    if (u.pathname.endsWith('/ping')) return res.end('{"ok":true}');
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const body = JSON.parse(b);
      naraRows.push(...body.rows);
      res.end(JSON.stringify({ ok: true, results: body.rows.map((r) => ({ key: r.key, saved: 'created', match: 'linked', project_id: 1, error: null })) }));
    });
    return;
  }
  if (u.pathname === '/sheet' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const body = JSON.parse(b); tokens.add(body.token);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (body.action === 'ping') return res.end(JSON.stringify({ ok: true, sheet: body.sheet, lastRow: sheet.length }));
      const k = (r) => String(r.A).replace(/\s/g, '') + '|' + String(r.B).replace(/\s/g, '');
      const results = body.rows.map((r) => {
        if (sheet.some((s) => k(s) === k(r))) return { key: r._key, status: 'exists' };
        sheet.push(r); return { key: r._key, status: 'written', row: sheet.length };
      });
      res.end(JSON.stringify({ ok: true, results }));
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (u.pathname.endsWith('cstpop.do') && u.searchParams.get('frame')) {
    popupsOpened++;
    return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>설치계획서</title></head><body style="margin:0"><iframe src="/C0/C0_02/cstpop_body.do?id=${u.searchParams.get('id')}" style="width:100%;height:900px;border:0"></iframe></body></html>`);
  }
  if (u.pathname.endsWith('cstpop.do')) { popupsOpened++; return res.end(popupHtml(u.searchParams.get('id'), u.searchParams.get('sb'))); }
  if (u.pathname.endsWith('cstpop_body.do')) return res.end(popupHtml(u.searchParams.get('id')));
  if (u.pathname.endsWith('list.do')) return res.end(listHtml(Number(u.searchParams.get('page') || 1), u.searchParams.get('v') || 'A'));
  res.end('');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function runVariant(v) {
console.log(`\n===== 변형 ${v} =====`);
sheet = SHEET0.map((r) => ({ ...r })); popupsOpened = 0; tokens.clear(); naraRows = [];
const prof = path.join(outDir, 'profile-crawl-' + v);
fs.rmSync(prof, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(prof, {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const extId = sw.url().split('/')[2];
const storage = (k) => sw.evaluate((k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k]))), k);

// 1) 설정: 시트 연결
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/options.html`);
await opt.waitForFunction(() => document.querySelector('#gs-token').value.length > 10);
const token = await opt.inputValue('#gs-token');
const code = await opt.inputValue('#gs-code');
check('settings: Apps Script 코드에 토큰·시트명 반영', code.includes(`const TOKEN = '${token}'`) && code.includes("const DEFAULT_SHEET = '설치계획'"));
await opt.fill('#gs-url', `${base}/sheet`);
await opt.fill('#cr-delay', '0.1');
await opt.click('#gs-save');
await opt.waitForFunction(() => /연결/.test(document.querySelector('#gs-msg').textContent) && !/확인 중/.test(document.querySelector('#gs-msg').textContent));
const pingMsg = await opt.textContent('#gs-msg');
check('settings: 연결 테스트 성공', pingMsg.includes('연결 성공') && pingMsg.includes('3행부터'), pingMsg);
check('settings: 토큰이 시트로 전달됨', tokens.has(token));
await opt.fill('#nara-url', `${base}/nara/`);
await opt.fill('#nara-token', 'wrong');
await opt.click('#nara-save');
await opt.waitForFunction(() => !/확인 중/.test(document.querySelector('#nara-msg').textContent) && document.querySelector('#nara-msg').textContent);
const naraBad = await opt.textContent('#nara-msg');
check('settings: 나라 앱 토큰이 틀리면 알려 줌', naraBad.includes('토큰'), naraBad);
await opt.fill('#nara-token', NARA_TOKEN);
await opt.click('#nara-save');
await opt.waitForFunction(() => /연결 성공/.test(document.querySelector('#nara-msg').textContent));
check('settings: 나라 앱 연결 테스트 성공', true, await opt.textContent('#nara-msg'));

// 2) 목록 페이지에서 크롤링 시작
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
await page.goto(`${base}/C0/list.do?v=${v}&page=1`);
await page.waitForSelector('#nrcrawl-panel');
check('list: 크롤링 패널 표시', true);
await page.click('#nrcrawl-panel [data-act="start"]');
// 크롤링이 끝날 때까지 기다림. 변형 C(직접 클릭 모드)는 노란 표시를 사람처럼 눌러 준다
async function waitDone(after) {
let manualClicks = 0;
const t0 = Date.now();
while (Date.now() - t0 < 150000) {
  const st = await storage('crawlState');
  if (process.env.CRAWL_DEBUG) { const j = JSON.stringify(st); if (j !== waitDone.last) { waitDone.last = j; console.log('[state]', new Date().toISOString(), j); } }
  if (st && !st.running && st.endedAt && (!after || st.startedAt > after)) break;
  if (v === 'C') {
    const lp = ctx.pages().find((p) => p.url().includes('list.do'));
    const target = lp && await lp.$('.nrcrawl-target');
    if (target) {
      await target.click().catch(() => {}); manualClicks++;
      // 사람처럼: 팝업이 처리되어 표시가 다음 건물로 옮겨질 때까지 기다린 뒤 다시 누름
      const before = await target.evaluate((e) => e.textContent).catch(() => '');
      const w0 = Date.now();
      while (Date.now() - w0 < 15000) {
        await new Promise((r) => setTimeout(r, 500));
        const now = await lp.$eval('.nrcrawl-target', (e) => e.textContent).catch(() => null);
        if (now !== before) break;
      }
      continue;
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}
return manualClicks;
}
const manualClicks = await waitDone(null);
const st = await storage('crawlState');
check('crawl: 정상 종료', st && !st.running && /모든 페이지/.test(st.lastMessage || ''), st && st.lastMessage);
const listPage = ctx.pages().find((p) => p.url().includes('list.do'));
const pagerNow = listPage && await listPage.evaluate(() => (document.querySelector('.paging .on, .sbgrid_PUI_PN a.active') || {}).textContent);
check('crawl: 2페이지까지 이동', pagerNow === '2', `현재 페이지=${pagerNow}`);
if (v === 'C') {
  const st2 = await storage('crawlState');
  check('assist: 직접 클릭 모드로 전환되어 사람이 누른 클릭으로 진행', st2.assist === true && manualClicks >= 7, `clicks=${manualClicks}`);
}
if (v === 'B') {
  const shot = path.join(outDir, 'crawl-list-B.png'); await listPage.screenshot({ path: shot });
}

const written = sheet.slice(2);
check('sheet: 새로 기록된 행 수 = 2 (준공 경과 2건 제외, 이미 있는 1건 제외)', written.length === 2, JSON.stringify(written.map((r) => r.B)));
const r1 = written.find((r) => r._key === '2603040001') || {};
check('sheet: A 기관명', r1.A === '서울특별시', r1.A);
check('sheet: B 건물명', r1.B === '노들섬 하늘예술정원 조성사업', r1.B);
check('sheet: C 건물주소 (우편번호 제외)', r1.C === '서울특별시 용산구 양녕로 445 446 일대 (이촌동)', r1.C);
check('sheet: H 착공예정일', r1.H === '2026-07-01', r1.H);
check('sheet: I 준공예정일', r1.I === '2028-03-31', r1.I);
check('sheet: J 담당부서 (의무기관)', r1.J === '미래공간담당관', r1.J);
check('sheet: R 에너지원 개요', r1.R === '지열 수직밀폐형: 336.060 kW\n태양광 BIPV: 17.544 kW', JSON.stringify(r1.R));
const draft = written.find((r) => r.B === '서울 반려동물 테마파크 조성');
check('sheet: 신청번호 없는(작성중) 건도 기록', !!draft && draft.R === '연료전지 PEMFC: 30.000 kW', draft && draft.R);

check('nara: 일정 있고 준공 전인 3건을 보냄 (시트에 이미 있는 건 포함)', naraRows.length === 3, JSON.stringify(naraRows.map((r) => r.name)));
const n1 = naraRows.find((r) => r.key === '2603040001') || {};
check('nara: 기관·건물·주소·부서', n1.org === '서울특별시' && n1.name === '노들섬 하늘예술정원 조성사업' && n1.addr === '서울특별시 용산구 양녕로 445 446 일대 (이촌동)' && n1.dept === '미래공간담당관', JSON.stringify(n1));
check('nara: 날짜는 YYYY-MM-DD', n1.start === '2026-07-01' && n1.end === '2028-03-31', `${n1.start} ${n1.end}`);
check('nara: 에너지원은 구조화된 배열',
  JSON.stringify(n1.energy) === JSON.stringify([{ source: '지열', form: '수직밀폐형', capacity_kw: 336.06 }, { source: '태양광', form: 'BIPV', capacity_kw: 17.544 }]),
  JSON.stringify(n1.energy));
const log = await storage('crawlLog');
check('log: 나라 앱 결과 기록', log['2603040001'] && log['2603040001'].nara === 'linked', JSON.stringify(log['2603040001']));
const statuses = Object.values(log).map((v) => v.status).sort().join(',');
check('log: 7건 기록 (written 2, exists 1, past 2, nodate 2)', statuses === 'exists,nodate,nodate,past,past,written,written', statuses);
check('sheet: 착공·준공예정일 빈 건은 시트에 없음', !sheet.some((r) => r.B === '잠실 체육시설 리모델링' || r.B === '마포 문화센터 신축'));
check('log: 준공 경과 건 상태 past', log['2512260024'] && log['2512260024'].status === 'past');
const openedFirst = popupsOpened;
for (let i = 0; i < 10 && ctx.pages().some((p) => p.url().includes('cstpop')); i++) await new Promise((r) => setTimeout(r, 500));
check('popup: 7건 모두 열고 닫힘', openedFirst === 7 && ctx.pages().filter((p) => p.url().includes('cstpop')).length === 0, `opened=${openedFirst}`);
await listPage.screenshot({ path: path.join(outDir, `crawl-list-${v}.png`) });

// 3) 다시 실행 → 기록된 건은 열지 않음
await listPage.goto(`${base}/C0/list.do?v=${v}&page=1`);
await listPage.waitForSelector('#nrcrawl-panel');
await listPage.click('#nrcrawl-panel [data-act="start"]');
await waitDone(st.startedAt);
check('rerun: 기록된 건은 열지 않고, 일정 없음 2건만 다시 확인', popupsOpened === openedFirst + 2, `opened=${popupsOpened}`);
const log2 = await storage('crawlLog');
check('rerun: 일정 없음 건은 여전히 제외', Object.values(log2).filter((x) => x.status === 'nodate').length === 2);
check('rerun: 시트에 중복 기록 없음', sheet.length === 4, String(sheet.length));
check('rerun: 나라 앱에 다시 보내지 않음', naraRows.length === 3, String(naraRows.length));

// 4) 설정 페이지 작업 기록 표시
await opt.reload();
await opt.waitForFunction(() => /기록 7건/.test(document.querySelector('#cr-info').textContent));
check('settings: 작업 기록 표시', true, await opt.textContent('#cr-info'));

// 5) 전체 받기: 준공 경과·일정 없음으로 제외했던 4건을 다시 열어 시트와 나라 앱에 보낸다
const openedBefore = popupsOpened;
const st3 = await storage('crawlState');
await listPage.check('#nrcrawl-all');
await listPage.click('#nrcrawl-panel [data-act="start"]');
await waitDone(st3.startedAt);
check('all: 제외했던 4건만 다시 열림', popupsOpened === openedBefore + 4, `opened=${popupsOpened - openedBefore}`);
check('all: 시트에 4행 추가 (총 8행)', sheet.length === 8, String(sheet.length));
check('all: 나라 앱에 4건 추가 전송 (총 7건)', naraRows.length === 7, String(naraRows.length));
check('all: 날짜 없는 건은 빈 날짜로 보냄', naraRows.some((r) => r.key === '2401010001' && r.start === '' && r.end === '2029-01-01'), JSON.stringify(naraRows.find((r) => r.key === '2401010001')));
const log3 = await storage('crawlLog');
const flagged = Object.values(log3);
check('all: 제외 상태가 남지 않음', !flagged.some((x) => x.status === 'past' || x.status === 'nodate'), flagged.map((x) => x.status).join(','));
check('all: 준공 경과 2건·일정 없음 2건 표시', flagged.filter((x) => x.past).length === 2 && flagged.filter((x) => x.nodate).length === 2);
const stAll = await storage('crawlState');
check('all: 패널 통계는 포함으로 셈', stAll.all === true && stAll.stats.past === 2 && stAll.stats.nodate === 2, JSON.stringify(stAll.stats));
await opt.reload();
await opt.waitForFunction(() => /\(준공 경과\)/.test(document.querySelector('#cr-table').textContent));
check('settings: 작업 기록에 (준공 경과) 표시', true);
// 켠 채로 다시 실행하면 더 열지 않는다 — 모두 보냈기 때문
await listPage.click('#nrcrawl-panel [data-act="start"]');
await waitDone(stAll.startedAt);
check('all: 다시 실행해도 여는 건 없음', popupsOpened === openedBefore + 4, `opened=${popupsOpened - openedBefore}`);
await listPage.uncheck('#nrcrawl-all');
await opt.screenshot({ path: path.join(outDir, `crawl-options-${v}.png`), fullPage: true });

await ctx.close();
}

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) failed++; };
const only = process.argv[2];
for (const v of ['A', 'B', 'C', 'D', 'E']) if (!only || only === v) await runVariant(v);
server.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
