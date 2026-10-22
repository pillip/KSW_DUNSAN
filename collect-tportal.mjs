#!/usr/bin/env node
/**
 * 대전교통 빅데이터 플랫폼(tportal.daejeon.go.kr)에서 최근 며칠치를 받아 history.json · volume.json 을 갱신한다.
 * tportal-fetch.js(브라우저 콘솔용)와 같은 내부 API를 Node 에서 호출한다. 로그인·키 없음.
 *
 *   node traffic/collect-tportal.mjs            # 최근 7일 (어제까지)
 *   node traffic/collect-tportal.mjs --days 30
 *   node traffic/collect-tportal.mjs --from 2026-09-01 --to 2026-10-21
 *   node traffic/collect-tportal.mjs --baseline 2026-09-28~2026-10-16 --exclude 2026-10-09   # 기준까지 다시 계산
 *
 * GitHub Actions(traffic-tportal.yml)가 매일 아침 돌린다. 정부 사이트가 해외 IP 를 막으면 러너에서는 실패하므로
 * 그때는 tportal-fetch.js 로 브라우저에서 받아 import-tportal.mjs 로 넣는다.
 */
import { importExport } from './import-tportal.mjs';

const ARGS = process.argv.slice(2);
const opt = n => { const i = ARGS.indexOf(n); return i >= 0 ? ARGS[i + 1] : null; };
const BASE = 'https://tportal.daejeon.go.kr';
const DAYS = ['1502', '1503', '1504', '1505', '1506', '1507', '1501'];
const KEEP = /대덕대교|과학공원|만년상아|북부소방서/;
const VDS = [['VDS0016', '3501'], ['VDS0015', '3502']];

const kst = new Date(Date.now() + 9 * 36e5);
const yday = new Date(kst); yday.setUTCDate(yday.getUTCDate() - 1);
const TO = opt('--to') ?? yday.toISOString().slice(0, 10);
const FROM = opt('--from') ?? (() => { const d = new Date(TO); d.setUTCDate(d.getUTCDate() - (+(opt('--days') ?? 7) - 1)); return d.toISOString().slice(0, 10); })();
const fmt = d => d.replace(/-/g, '');
const chunks = (a, b, n) => { const out = []; let s = new Date(a); const e = new Date(b); while (s <= e) { const t = new Date(Math.min(e, s.getTime() + (n - 1) * 864e5)); out.push([fmt(s.toISOString().slice(0, 10)), fmt(t.toISOString().slice(0, 10))]); s = new Date(t.getTime() + 864e5); } return out; };

async function api(path, body) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 90e3);
  try {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-type': 'application/json;charset=UTF-8', 'X-Site-Id': '1' }, body: JSON.stringify(body), signal: ctl.signal });
    const t = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${t.slice(0, 80)}`);
    return JSON.parse(t);
  } finally { clearTimeout(tm); }
}
async function retry(fn, n = 3) { let err; for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { err = e; console.log(`  재시도 ${i + 1}: ${e.message}`); await new Promise(r => setTimeout(r, 4000)); } } throw err; }

const X = { fetched: kst.toISOString().slice(0, 10), range: [FROM, TO], sections: {}, vds: {} };
console.log(`tportal ${FROM} ~ ${TO}`);
for (const dir of ['3501', '3502']) for (const [a, b] of chunks(FROM, TO, 10)) {
  const r = await retry(() => api('/web-service/api/v1/road/getTrafficSpeedBySection', { chodate: 'up', tunit: '1h', sdate: a, edate: b, direction: dir, stime: '00', etime: '23', days: 'allDay', dayArr: DAYS, road: '대덕대로' }));
  for (const x of r) {
    if (!KEEP.test(x.nodeNm)) continue;
    const m = x.ymdNm.match(/(\d{4})년 (\d{1,2})월 (\d{1,2})일/); const ymd = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    (((X.sections[dir] ??= {})[x.nodeNm] ??= {})[ymd] ??= Array(24).fill(null))[+x.hhId] = x.speed;
  }
  console.log(`  구간속도 ${dir} ${a}~${b}: ${r.length}행`);
}
for (const [vds, dir] of VDS) for (const [a, b] of chunks(FROM, TO, 3)) {
  const r = await retry(() => api('/web-service/api/v1/road/getVDSByLocationDetail', { chodate: 'up', tunit: '1h', sdate: a, edate: b, direction: dir, stime: '00', etime: '23', days: 'allDay', dayArr: DAYS, road: '대덕대로', vdsid: vds }));
  for (const x of r) {
    const y = x.ymdId; const ymd = `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;
    const d = ((X.vds[vds] ??= { dir, loc: x.instLocat, node: x.nodeNm, days: {} }).days[ymd] ??= { spd: Array(24).fill(null), vol: Array(24).fill(null) });
    d.spd[+x.hhId] = x.vdsTrvlSpdYmdh; d.vol[+x.hhId] = x.vdsTrVolYmdhTot;
  }
  console.log(`  VDS ${vds} ${a}~${b}: ${r.length}행`);
}
const nSec = Object.keys(X.sections['3501']?.['대덕대교네거리▶과학공원네거리'] ?? {}).length;
if (!nSec) { console.error('받은 자료가 없습니다 (포털 응답 형식이 바뀌었거나 기간에 자료가 없음).'); process.exit(3); }
const { log } = importExport(X, { baseline: opt('--baseline'), exclude: (opt('--exclude') ?? '').split(',').filter(Boolean), dry: ARGS.includes('--dry') });
console.log(log.join('\n'));
