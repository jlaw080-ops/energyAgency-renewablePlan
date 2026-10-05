// 확장 프로그램을 실제 Chromium에 로드하여 mock 로그인 페이지에서 동작을 검증한다.
// 실행: node test/run.mjs   (전역 playwright 사용)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright');
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = path.join(root, 'test/output'); fs.mkdirSync(outDir, { recursive: true });
const extSrc = path.join(root, 'extension');
const extDir = path.join(outDir, 'ext-test'); fs.rmSync(extDir, { recursive: true, force: true });
fs.cpSync(extSrc, extDir, { recursive: true });
// 테스트용: 적용 대상 주소를 localhost 로 바꾼다
const mf = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
mf.content_scripts[0].matches = ['http://127.0.0.1/*'];
mf.host_permissions.push('http://127.0.0.1/*');
mf.web_accessible_resources[0].matches = ['http://127.0.0.1/*'];
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(mf, null, 2));

// mock 페이지 서버
const mock = path.join(root, 'test/mock');
const server = http.createServer((req, res) => {
  const f = path.join(mock, req.url.split('?')[0].replace(/^\//, '') || 'login.do.html');
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

fs.rmSync(path.join(outDir, 'profile'), { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(path.join(outDir, 'profile'), {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const extId = sw.url().split('/')[2];
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) failed++; };

// 1) 설정 페이지에서 사용자 등록
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/options.html`);
await opt.fill('#u-name', '홍길동'); await opt.fill('#u-phone', '01012345678'); await opt.click('#u-add');
await opt.fill('#u-name', '김철수'); await opt.fill('#u-phone', '010-9876-5432'); await opt.click('#u-add');
await opt.waitForFunction(() => document.querySelectorAll('#u-table tbody tr').length === 2);
check('options: 사용자 2명 등록', (await opt.textContent('#u-table')).includes('010-1234-5678'));
check('options: 내장 기관 수 표시', /현재 \d+곳/.test(await opt.textContent('#org-info')), await opt.textContent('#org-info'));
await opt.screenshot({ path: path.join(outDir, 'options.png'), fullPage: true });

// 2) 로그인 mock 페이지
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${port}/login.do.html`);
await page.waitForSelector('#nrfill-panel');
check('panel: 패널 표시됨', true);
await page.fill('#nrfill-q', '강원대학교');
await page.waitForSelector('#nrfill-list li');
const first = await page.textContent('#nrfill-list li');
check('panel: 검색 결과', first.includes('강원대학교'), first);
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
const biz = await page.evaluate(() => [document.querySelector('#bizNo1').value, document.querySelector('#bizNo2').value, document.querySelector('#bizNo3').value]);
check('fill: 사업자번호 3칸 분할 입력', biz.join('-') === '221-83-01195', biz.join('-'));
const frame = page.frames().find((f) => f.url().endsWith('frame.html'));
const entr = await frame.evaluate(() => document.querySelector('#entrNo').value);
check('fill: iframe 안 사업자번호(하이픈, maxlength 12)', entr === '221-83-01195', entr);

await page.selectOption('#nrfill-user', '0');
await page.waitForTimeout(600);
const hp = await page.evaluate(() => document.querySelector('#hpNo').value);
check('fill: 휴대폰 단일칸(maxlength 11 → 숫자만)', hp === '01012345678', hp);
const fax = await page.evaluate(() => document.querySelector('#faxNo').value);
check('fill: 팩스칸은 건드리지 않음', fax === '');
const mob = await frame.evaluate(() => document.querySelector('#mobile').value);
check('fill: iframe 휴대전화(maxlength 13 → 하이픈)', mob === '010-1234-5678', mob);
const status = await page.textContent('#nrfill-status');
check('panel: 상태 메시지 성공 (top 1칸 + iframe 1칸 = 2칸)', status.includes('휴대폰 입력 완료(2칸)'), status);
await page.screenshot({ path: path.join(outDir, 'login.png'), fullPage: true });

// 3) 필드 직접 지정: 인증번호칸을 휴대폰칸으로 지정해 본다
await page.click('[data-act="pick-phone"]');
await page.waitForTimeout(300);
await page.click('#authNo');
await page.waitForTimeout(500);
const saved = await sw.evaluate(() => new Promise((r) => chrome.storage.sync.get('phoneSelector', (v) => r(v.phoneSelector))));
check('pick: 셀렉터 저장', saved === '#authNo', saved);
await page.click('[data-act="fill-phone"]');
await page.waitForTimeout(600);
const auth = await page.evaluate(() => document.querySelector('#authNo').value);
check('pick: 지정한 칸에 채움', auth === '010-1234-5678' || auth === '01012345678', auth);

await ctx.close(); server.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
