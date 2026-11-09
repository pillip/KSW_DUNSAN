#!/usr/bin/env node
/**
 * 대덕대교 통제 효과를 "계절·추세 요인을 걷어내고" 보기 위한 대조 자료 수집.
 * collect-tportal.mjs 가 교량 6개 구간만 받는 데 비해, 이쪽은 비교에 필요한 세 가지를 더 받는다.
 *
 *   1) 전년 동기 — 같은 구간의 작년 같은 날짜. 계절·나들이철 반론을 가른다.
 *   2) 같은 도로 원거리 구간 — 대덕대로 중 교량에서 먼 구간. 통제와 무관하므로 대조군이 된다.
 *   3) 우회도로 — 둔산대로·엑스포로·천변도시고속화도로(갑천). 통제 전 자료가 없던 공백을 메운다.
 *   4) 시 트램 모니터링(/api/v1/tram/getRoadSpeed) — 집행부가 쓰는 도심 도로 평균. 시 전체 대조군.
 *
 *   node traffic/collect-compare.mjs                      # 2025·2026 의 09-01~11-04 (이어받기)
 *   node traffic/collect-compare.mjs --years 2026         # 올해만
 *   node traffic/collect-compare.mjs --from 09-01 --to 11-04
 *   node traffic/collect-compare.mjs --skip-tram          # 트램 모니터링 건너뛰기(날짜당 1회 호출이라 느리다)
 *   node traffic/collect-compare.mjs --fresh              # 기존 compare.json 무시하고 새로
 *
 * 전체 수집은 30분쯤 걸리고 tportal 이 간간이 504 를 낸다. 그래서 청크마다 compare.json 에 바로 쓰고,
 * 다시 돌리면 이미 받은 날짜는 건너뛴다(이어받기가 기본). 중간에 끊겨도 다시 실행하면 된다.
 *
 * tportal 은 공개 API 가 아니라 화면이 쓰는 내부 API 다. 해외·클라우드 IP 는 막히므로 국내 망에서 돌린다.
 * 결과는 traffic/data/compare.json. 기존 history.json·volume.json 은 건드리지 않는다.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync, openSync, closeSync, unlinkSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'data', 'compare.json');
const BASE = 'https://tportal.daejeon.go.kr';
const DAYS = ['1502', '1503', '1504', '1505', '1506', '1507', '1501'];

const ARGS = process.argv.slice(2);
const opt = (n, d = null) => { const i = ARGS.indexOf(n); return i >= 0 ? ARGS[i + 1] : d; };
const has = n => ARGS.includes(n);

const YEARS = (opt('--years', '2025,2026')).split(',').map(s => s.trim());
const MD_FROM = opt('--from', '09-01');
const MD_TO = opt('--to', '11-04');

/** 교량에 붙은 6개 구간 — 통제의 직접 영향권. 대조군에서는 뺀다. */
const BRIDGE_RE = /대덕대교|과학공원|만년상아|북부소방서/;
/** 교량 구간 정식 이름 → 키 (import-tportal.mjs 와 같은 체계) */
const BRIDGE_SECTIONS = {
  '3501|대덕대교네거리▶과학공원네거리': 'bridge:toDaedeok',
  '3502|과학공원네거리▶대덕대교네거리': 'bridge:toDunsan',
  '3501|만년상아아파트▶대덕대교네거리': 'approach:toDaedeok',
  '3502|북부소방서▶과학공원네거리': 'approach:toDunsan',
  '3501|과학공원네거리▶북부소방서': 'exit:toDaedeok',
  '3502|대덕대교네거리▶만년상아아파트': 'exit:toDunsan',
};
/** 우회도로 — tportal 에 실제로 있는 이름만. 대학로·만년로·유등로는 tportal 구간속도에 없다(2026-11 확인). */
const DETOURS = [
  { key: 'dunsan', road: '둔산대로', label: '둔산대로' },
  { key: 'expo', road: '엑스포로', label: '엑스포로' },
  { key: 'gapcheon', road: '천변도시고속화도로', label: '갑천도시고속도로 (tportal 명칭 천변도시고속화도로)' },
];
const VDS = [['VDS0016', '3501'], ['VDS0015', '3502']];
/** 갑천을 건너는 대체 경로의 VDS. "줄어든 차가 어디로 갔나"를 대수로 추적하는 용도. */
const VDS_ALT = [
  ['천변도시고속화도로', 'VDS0013', '3501'], ['천변도시고속화도로', 'VDS0014', '3502'], ['천변도시고속화도로', 'VDS0088', '3501'],
  ['엑스포로', 'VDS0089', '3501'], ['엑스포로', 'VDS0089', '3502'], ['엑스포로', 'VDS0142', '3501'], ['엑스포로', 'VDS0143', '3502'],
  ['둔산대로', 'VDS0018', '3501'], ['둔산대로', 'VDS0019', '3502'],
  // 대학로는 구간속도 통계에는 없지만 VDS 는 있다 — 통제 전 교통량·지점속도 비교가 가능한 유일한 경로.
  ['대학로(1)', 'VDS0017', '3501'], ['대학로(1)', 'VDS0017', '3502'],
  ['대학로(1)', 'VDS0136', '3501'], ['대학로(1)', 'VDS0136', '3502'],
  // 한밭대로는 유성대교로 갑천을 건넌다 — 둔산↔유성 통행의 또 다른 대체 건넘목.
  ['한밭대로', 'VDS0022', '3502'], ['한밭대로', 'VDS0023', '3501'],   // 봉명동, 유성대교 바로 옆
  ['한밭대로', 'VDS0026', '3501'], ['한밭대로', 'VDS0027', '3502'],   // 둔산동 정부청사광장
];
/** 트램 공사 공구 중 대덕대교를 품은 구간. 시 「트램구간 일간보고서」가 쓰는 지표. */
const TRAM_SECTION = '5공구';

const pad = n => String(n).padStart(2, '0');
const fmt = s => s.replace(/-/g, '');
const chunks = (a, b, n) => {
  const out = []; let s = new Date(a + 'T00:00:00Z'); const e = new Date(b + 'T00:00:00Z');
  while (s <= e) { const t = new Date(Math.min(+e, +s + (n - 1) * 864e5)); out.push([fmt(s.toISOString().slice(0, 10)), fmt(t.toISOString().slice(0, 10))]); s = new Date(+t + 864e5); }
  return out;
};
const dateList = (a, b) => { const out = []; let s = new Date(a + 'T00:00:00Z'); const e = new Date(b + 'T00:00:00Z'); while (s <= e) { out.push(s.toISOString().slice(0, 10)); s = new Date(+s + 864e5); } return out; };
const avg = a => { const v = a.filter(x => x != null && x > 0); return v.length ? Math.round(v.reduce((x, y) => x + y, 0) / v.length * 10) / 10 : null; };

async function api(path, body, ms = 90e3) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-type': 'application/json;charset=UTF-8', 'X-Site-Id': '1' }, body: JSON.stringify(body), signal: ctl.signal });
    const t = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${t.slice(0, 80)}`);
    return JSON.parse(t);
  } finally { clearTimeout(tm); }
}
async function retry(fn, n = 3) {
  let err;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) { err = e; console.log(`    재시도 ${i + 1}/${n}: ${e.message}`); await new Promise(r => setTimeout(r, 4000)); }
  }
  throw err;
}
const speedBySection = (road, dir, a, b) => retry(() => api('/web-service/api/v1/road/getTrafficSpeedBySection',
  { chodate: 'up', tunit: '1h', sdate: a, edate: b, direction: dir, stime: '00', etime: '23', days: 'allDay', dayArr: DAYS, road }));
const ymdOf = s => { const m = s.match(/(\d{4})년 (\d{1,2})월 (\d{1,2})일/); return `${m[1]}-${pad(m[2])}-${pad(m[3])}`; };

/* 두 개를 동시에 돌리면 각자 메모리에 든 내용으로 compare.json 을 통째로 덮어써서
   먼저 끝난 쪽의 수집분이 날아간다. 락으로 막는다. */
const LOCK = OUT + '.lock';
try { closeSync(openSync(LOCK, 'wx')); }
catch { console.error(`이미 수집이 돌고 있다 (${LOCK}). 끝난 뒤 다시 실행한다.\n강제로 풀려면 그 파일을 지운다.`); process.exit(3); }
const unlock = () => { try { rmSync(LOCK, { force: true }); } catch {} };
process.on('exit', unlock);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { unlock(); process.exit(130); });

const FRESH = { bridge: {}, control: {}, detour: {}, vds: {}, cityTram: {}, sectionsSeen: {} };
let X = { ...FRESH };
if (!has('--fresh') && existsSync(OUT)) {
  try { X = { ...FRESH, ...JSON.parse(readFileSync(OUT, 'utf8')) }; console.log(`이어받기: 기존 compare.json 에서 control ${Object.keys(X.control).length}일 · cityTram ${Object.keys(X.cityTram).length}일`); }
  catch { console.log('기존 compare.json 을 읽지 못해 새로 시작한다.'); }
}
X.fetched = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);
X.window = { from: MD_FROM, to: MD_TO };
X.years = [...new Set([...(X.years ?? []), ...YEARS])].sort();
X.note = '대덕대교 통제 효과의 대조 자료. bridge=교량 6개 구간, control=대덕대로 중 교량에서 먼 구간 평균, detour=우회도로 도로별 평균(양방향), vds=교량 인접 교통량, cityTram=시 트램 모니터링 도심 도로 평균.';

mkdirSync(dirname(OUT), { recursive: true });
const save = () => writeFileSync(OUT, JSON.stringify(X));
/** 청크(YYYYMMDD 두 개)의 모든 날짜가 이미 있으면 true */
const covered = (a, b, hasDate) => {
  const iso = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return dateList(iso(a), iso(b)).every(hasDate);
};

for (const Y of YEARS) {
  const FROM = `${Y}-${MD_FROM}`, TO = `${Y}-${MD_TO}`;
  console.log(`\n■ ${Y}년 ${FROM} ~ ${TO}`);

  // ── 1·2) 대덕대로 전 구간 → 교량 구간은 그대로, 나머지는 대조군으로
  //   방향별로 따로 쌓는다(byDir). 이어받기 때 한쪽 방향만 다시 받아도 평균이 틀어지지 않게 하려는 것.
  for (const dir of ['3501', '3502']) {
    for (const [a, b] of chunks(FROM, TO, 5)) {
      if (covered(a, b, d => X.controlByDir?.[dir]?.[d])) { console.log(`  대덕대로 ${dir} ${a}~${b}: 건너뜀(이미 있음)`); continue; }
      let rows;
      try { rows = await speedBySection('대덕대로', dir, a, b); }
      catch (e) { console.log(`  대덕대로 ${dir} ${a}~${b}: 실패 ${e.message}`); continue; }
      const ctl = {};
      for (const x of rows) {
        const ymd = ymdOf(x.ymdNm), h = +x.hhId, v = x.speed;
        (X.sectionsSeen[dir] ??= {})[x.nodeNm] = (X.sectionsSeen[dir][x.nodeNm] ?? 0) + 1;
        const key = BRIDGE_SECTIONS[`${dir}|${x.nodeNm}`];
        if (key) { ((X.bridge[key] ??= {})[ymd] ??= Array(24).fill(null))[h] = v; continue; }
        if (BRIDGE_RE.test(x.nodeNm)) continue;               // 교량 인접이지만 대상 구간이 아닌 것 → 양쪽 모두에서 제외
        ((ctl[ymd] ??= Array.from({ length: 24 }, () => []))[h]).push(v);
      }
      const bucket = ((X.controlByDir ??= {})[dir] ??= {});
      for (const ymd of Object.keys(ctl)) bucket[ymd] = ctl[ymd].map(avg);
      save();
      console.log(`  대덕대로 ${dir} ${a}~${b}: ${rows.length}행`);
    }
  }

  // ── 3) 우회도로 — 도로별·양방향 전 구간 평균
  for (const d of DETOURS) {
    for (const dir of ['3501', '3502']) {
      for (const [a, b] of chunks(FROM, TO, 10)) {
        if (covered(a, b, x => X.detourByDir?.[d.key]?.[dir]?.[x])) { console.log(`  ${d.road} ${dir} ${a}~${b}: 건너뜀`); continue; }
        let rows;
        try { rows = await speedBySection(d.road, dir, a, b); }
        catch (e) { console.log(`  ${d.road} ${dir} ${a}~${b}: 실패 ${e.message}`); continue; }
        const acc = {};
        for (const x of rows) {
          const ymd = ymdOf(x.ymdNm);
          ((acc[ymd] ??= Array.from({ length: 24 }, () => []))[+x.hhId]).push(x.speed);
        }
        const bucket = (((X.detourByDir ??= {})[d.key] ??= {})[dir] ??= {});
        for (const ymd of Object.keys(acc)) bucket[ymd] = acc[ymd].map(avg);
        save();
        console.log(`  ${d.road} ${dir} ${a}~${b}: ${rows.length}행`);
      }
    }
  }

  // ── 4) VDS 교통량 (교량 인접)
  for (const [vds, dir] of VDS) {
    for (const [a, b] of chunks(FROM, TO, 3)) {
      if (covered(a, b, d => X.vds?.[vds]?.days?.[d])) continue;
      let rows;
      try {
        rows = await retry(() => api('/web-service/api/v1/road/getVDSByLocationDetail',
          { chodate: 'up', tunit: '1h', sdate: a, edate: b, direction: dir, stime: '00', etime: '23', days: 'allDay', dayArr: DAYS, road: '대덕대로', vdsid: vds }));
      } catch (e) { console.log(`  VDS ${vds} ${a}~${b}: 실패 ${e.message}`); continue; }
      for (const x of rows) {
        const y = x.ymdId, ymd = `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;
        const g = ((X.vds[vds] ??= { dir, loc: rows[0]?.instLocat, node: rows[0]?.nodeNm, days: {} }).days[ymd] ??= { spd: Array(24).fill(null), vol: Array(24).fill(null) });
        g.spd[+x.hhId] = x.vdsTrvlSpdYmdh; g.vol[+x.hhId] = x.vdsTrVolYmdhTot;
      }
      save();
    }
    console.log(`  VDS ${vds}: ${Object.keys(X.vds[vds]?.days ?? {}).length}일`);
  }

  // ── 4b) 대체 경로 VDS — 교량에서 빠진 차가 어디로 갔는지 대수로 본다
  if (!has('--skip-alt')) {
    for (const [road, vds, dir] of VDS_ALT) {
      const key = `${vds}|${dir}`;
      // 지점에 따라 응답이 매우 느려 10일 청크는 504 가 잦다. 3일로 잘라 받는다.
      for (const [a, b] of chunks(FROM, TO, 3)) {
        if (covered(a, b, d => X.vdsAlt?.[key]?.days?.[d])) continue;
        let rows;
        try {
          rows = await retry(() => api('/web-service/api/v1/road/getVDSByLocationDetail',
            { chodate: 'up', tunit: '1h', sdate: a, edate: b, direction: dir, stime: '00', etime: '23', days: 'allDay', dayArr: DAYS, road, vdsid: vds }), 3);
        } catch (e) { console.log(`  ALT ${vds} ${dir} ${a}~${b}: 실패 ${e.message}`); continue; }
        if (!rows.length) continue;
        const g = ((X.vdsAlt ??= {})[key] ??= { road, vds, dir, loc: rows[0]?.instLocat, node: rows[0]?.nodeNm, days: {} });
        for (const x of rows) {
          const y = x.ymdId, ymd = `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;
          const d = (g.days[ymd] ??= { spd: Array(24).fill(null), vol: Array(24).fill(null) });
          d.spd[+x.hhId] = x.vdsTrvlSpdYmdh; d.vol[+x.hhId] = x.vdsTrVolYmdhTot;
        }
        save();
      }
      const g = X.vdsAlt?.[key];
      console.log(`  ALT ${vds} ${dir} ${road}: ${Object.keys(g?.days ?? {}).length}일 — ${g?.node ?? '자료 없음'}`);
    }
  }
}

// ── 4c) 시 트램 공구별 모니터링 — 5공구(정부청사역↔국립중앙과학관)가 대덕대교를 품는다.
//   집행부가 일간보고서에 쓰는 지표라, 같은 숫자로 대조하려면 반드시 받아 둬야 한다.
if (!has('--skip-tram')) {
  for (const Y of YEARS) {
    const dates = dateList(`${Y}-${MD_FROM}`, `${Y}-${MD_TO}`).filter(d => !X.tramSection?.[d]);
    if (!dates.length) { console.log(`\n■ 트램 ${TRAM_SECTION} ${Y}: 이미 있음`); continue; }
    console.log(`\n■ 트램 ${TRAM_SECTION} ${Y} — ${dates.length}일 남음`);
    let ok = 0;
    for (const d of dates) {
      let s, v;
      try {
        s = await api('/web-service/api/v1/tram/getConsecSpeed', { date: fmt(d) }, 30e3);
        v = await api('/web-service/api/v1/tram/getConsecTraffic', { date: fmt(d) }, 30e3);
      } catch (e) { console.log(`  ${d}: 실패 ${e.message}`); continue; }
      const sp = (Array.isArray(s) ? s : []).filter(x => x.trConsecNm === TRAM_SECTION);
      const vl = (Array.isArray(v) ? v : []).filter(x => x.trConsecNm === TRAM_SECTION);
      if (!sp.length) continue;
      const rec = ((X.tramSection ??= {})[d] = { spd: {}, vol: {} });
      for (const x of sp) (rec.spd[x.routeDirNm] ??= {})[x.hhId] = { v: x.trvlSpd, yr: x.bf1yrTrvlSpd, sctn: x.trSctn };
      for (const x of vl) (rec.vol[x.routeDirNm] ??= {})[x.hhId] = { v: x.trVol, yr: x.bf1yrTrVol };
      ok++; if (ok % 10 === 0) save();
    }
    save();
    console.log(`  ${TRAM_SECTION} ${ok}일 수집`);
  }
}

// ── 5) 시 트램 모니터링 — 날짜당 1회. 도심 도로 평균과 대덕대로가 같이 온다.
if (!has('--skip-tram')) {
  for (const Y of YEARS) {
    const dates = dateList(`${Y}-${MD_FROM}`, `${Y}-${MD_TO}`).filter(d => !X.cityTram[d]);
    if (!dates.length) { console.log(`\n■ 시 트램 모니터링 ${Y}: 이미 있음`); continue; }
    console.log(`\n■ 시 트램 모니터링 ${Y} — ${dates.length}일 남음`);
    let ok = 0;
    for (const d of dates) {
      let r;
      try { r = await api('/web-service/api/v1/tram/getRoadSpeed', { date: fmt(d) }, 40e3); }
      catch (e) { console.log(`  ${d}: 실패 ${e.message}`); continue; }
      const rows = r?.mainRoadSpeed ?? [];
      if (!rows.length) continue;
      const pick = {};
      for (const x of rows) {
        if (x.roadNm !== '평균') continue;
        pick[x.hhId] = { spd: x.trvlSpd, yr: x.bf1yrTrvlSpd, yrRt: x.bf1yrRt };
      }
      if (Object.keys(pick).length) { X.cityTram[d] = pick; ok++; if (ok % 10 === 0) save(); }
    }
    save();
    console.log(`  도심 도로 평균 ${ok}일 수집`);
  }
}

// ── 방향별로 쌓은 것을 합쳐 최종 형태로. (이어받기 때 평균이 틀어지지 않도록 마지막에 한 번만 한다)
const merge2 = byDir => {
  const out = {};
  const ds = new Set([...Object.keys(byDir['3501'] ?? {}), ...Object.keys(byDir['3502'] ?? {})]);
  for (const d of ds) {
    out[d] = Array.from({ length: 24 }, (_, h) => avg([byDir['3501']?.[d]?.[h], byDir['3502']?.[d]?.[h]]));
  }
  return out;
};
X.control = merge2(X.controlByDir ?? {});
for (const d of DETOURS) {
  const byDir = X.detourByDir?.[d.key];
  if (!byDir) continue;
  X.detour[d.key] = { label: d.label, road: d.road, days: merge2(byDir) };
}
save();

const n = o => Object.keys(o ?? {}).length;
const yrs = o => [...new Set(Object.keys(o ?? {}).map(d => d.slice(0, 4)))].sort().join('·');
console.log(`\n저장: ${OUT}`);
console.log(`  bridge ${n(X.bridge)}구간 · ${n(X.bridge['bridge:toDunsan'])}일 (${yrs(X.bridge['bridge:toDunsan'])})`);
console.log(`  control ${n(X.control)}일 (${yrs(X.control)})  detour ${n(X.detour)}개  vds ${n(X.vds)}개  cityTram ${n(X.cityTram)}일 (${yrs(X.cityTram)})`);
console.log(`  vdsAlt ${n(X.vdsAlt)}개 지점  tramSection(${TRAM_SECTION}) ${n(X.tramSection)}일 (${yrs(X.tramSection)})`);
