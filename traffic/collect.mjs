#!/usr/bin/env node
/**
 * 대덕대교 통행 모니터 — 수집 스크립트
 *
 * 공공데이터포털 「대전광역시_대전교통정보 서비스」(15157924) 의 getTrafficInfoAll 을 호출해
 * 대덕대교 구간과 우회도로의 링크별 통행속도·통행시간·소통등급을 받아 traffic/data/ 에 쌓는다.
 * GitHub Actions 가 10분마다 실행하고 결과를 커밋한다 (.github/workflows/traffic.yml).
 *
 *   DATA_GO_KR_KEY=... node traffic/collect.mjs              # 수집 1회
 *   DATA_GO_KR_KEY=... node traffic/collect.mjs --discover   # 링크 목록만 확인 → data/discover.json
 *   node traffic/collect.mjs --rebuild                       # raw 로 daily.json 다시 계산 (API 호출 없음)
 *   node traffic/collect.mjs --from-file resp.xml            # 저장된 응답으로 수집 (테스트)
 *
 * 출력 파일
 *   data/latest.json          마지막 수집 시점의 링크·그룹별 현재값 (대시보드 "지금" 섹션)
 *   data/raw/YYYY-MM-DD.json  하루치 원자료 [분, 링크번호, 속도, 통행시간, 소통등급] (35일 보관)
 *   data/daily.json           일별·시간대별 집계 (영구 보관, 대시보드 본체)
 *   data/discover.json        --discover 결과
 *
 * 외부 의존성 없음 (Node 20+).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const RAW = join(DATA, 'raw');
const CFG = JSON.parse(readFileSync(join(HERE, 'links.json'), 'utf8'));
const ARGS = process.argv.slice(2);
const flag = n => ARGS.includes(n);
const opt = n => { const i = ARGS.indexOf(n); return i >= 0 ? ARGS[i + 1] : null; };

const API = 'https://apis.data.go.kr/6300000/rest/getTrafficInfoAll';
const PAGE = 1000;           // numOfRows (상한을 모르므로 totalCnt 로 페이지를 돌린다)
const MAX_PAGES = 40;
const RAW_KEEP_DAYS = 35;
const PEAK = { am: [7, 9], pm: [17, 19] }; // [시작시, 끝시) — 07:00~08:59, 17:00~18:59

mkdirSync(RAW, { recursive: true });

/* ---------- 시간 (Asia/Seoul, DST 없음) ---------- */
function kstNow() {
  const d = new Date(Date.now() + 9 * 3600e3);
  return {
    date: d.toISOString().slice(0, 10),
    minute: d.getUTCHours() * 60 + d.getUTCMinutes(),
    iso: d.toISOString().replace(/\.\d{3}Z$/, '+09:00'),
  };
}

/* ---------- API ---------- */
async function fetchAll(key) {
  const rows = [];
  let total = Infinity;
  for (let page = 1; page <= MAX_PAGES && rows.length < total; page++) {
    const url = `${API}?serviceKey=${encodeURIComponent(key)}&pageNo=${page}&numOfRows=${PAGE}`;
    const r = await fetch(url, { headers: { Accept: 'application/xml, application/json;q=0.9, */*;q=0.5' } });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    const { items, totalCnt, error } = parseResponse(text);
    if (error) throw new Error(error);
    if (Number.isFinite(totalCnt)) total = totalCnt;
    rows.push(...items);
    if (!items.length) break;
    if (items.length < PAGE && !Number.isFinite(totalCnt)) break;
  }
  return rows;
}

/** XML(기본) 또는 JSON 응답 → 링크 배열. 공공데이터포털 공통 오류(OpenAPI_ServiceResponse)도 잡는다. */
function parseResponse(text) {
  const t = text.trim();
  if (t.startsWith('{')) {
    const j = JSON.parse(t);
    const list = j?.body?.['TRAFFIC-LIST']?.TRAFFIC ?? j?.response?.body?.items?.item ?? [];
    return { items: (Array.isArray(list) ? list : [list]).map(norm), totalCnt: +(j?.header?.totalCnt ?? j?.response?.body?.totalCount) };
  }
  if (/<OpenAPI_ServiceResponse>/.test(t)) {
    const code = tag(t, 'returnReasonCode'), msg = tag(t, 'returnAuthMsg') || tag(t, 'errMsg');
    return { items: [], error: `공공데이터포털 오류 ${code}: ${msg} (키 미등록·승인 전·트래픽 초과 여부를 확인)` };
  }
  const rc = tag(t, 'resultCode');
  if (rc && rc !== '00' && rc !== '0' && rc !== '200') return { items: [], error: `API 오류 resultCode=${rc} ${tag(t, 'resultMsg')}` };
  const items = [];
  for (const m of t.matchAll(/<TRAFFIC>([\s\S]*?)<\/TRAFFIC>/g)) {
    const b = m[1], o = {};
    for (const f of b.matchAll(/<([A-Za-z_]+)>([\s\S]*?)<\/\1>/g)) o[f[1]] = f[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim();
    items.push(norm(o));
  }
  return { items, totalCnt: +tag(t, 'totalCnt') };
}
const tag = (s, n) => { const m = s.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`)); return m ? m[1].trim() : ''; };
const norm = o => ({
  id: String(o.linkID ?? o.linkId ?? o.LINK_ID ?? ''),
  road: o.roadName ?? '', s: o.startNodeName ?? '', e: o.endNodeName ?? '',
  ud: String(o.udType ?? ''), len: +o.linkLength || 0,
  spd: +o.speed, tt: +o.travelT, cg: +o.congestion,
  sqc: +o.linkSqc || 0,
});

/* ---------- 링크 분류 ---------- */
const rx = p => p ? new RegExp(p) : null;
const B = CFG.bridge, DIRS = B.directions;
const bridgeRx = rx(B.match), roadRx = rx(B.road);
const detours = CFG.detours.map(d => ({ ...d, rx: rx(d.match) }));

function classify(l) {
  // 교량 구간: 링크 ID를 직접 적었으면 그것만. 아니면 도로명이 대덕대로이고 양쪽 노드가 모두 교량 노드(대덕대교·과학공원)인 링크.
  const isBridge = B.linkIds?.length ? B.linkIds.includes(l.id)
    : ((!roadRx || roadRx.test(l.road)) && bridgeRx.test(l.s) && bridgeRx.test(l.e));
  if (isBridge) {
    for (const [k, d] of Object.entries(DIRS)) if (rx(d.endMatch)?.test(l.e) && !rx(d.endMatch)?.test(l.s)) return `bridge:${k}`;
    for (const [k, d] of Object.entries(DIRS)) if (d.ud && d.ud === l.ud) return `bridge:${k}`;
    return 'bridge:unknown';
  }
  for (const d of detours) if (d.rx.test(l.road)) return `detour:${d.key}`;
  return null;
}

/* ---------- 파일 유틸 ---------- */
const readJson = (p, fb) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb;
const writeJson = (p, o, pretty = false) => writeFileSync(p, JSON.stringify(o, null, pretty ? 1 : 0) + '\n');
const r1 = x => Math.round(x * 10) / 10;
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;

/* ---------- 집계 ---------- */
function groupsMeta() {
  const g = {};
  for (const [k, d] of Object.entries(DIRS)) g[`bridge:${k}`] = { label: `${B.label} ${d.label}`, kind: 'bridge' };
  g['bridge:unknown'] = { label: `${B.label} 방향 미확정`, kind: 'bridge' };
  for (const d of detours) g[`detour:${d.key}`] = { label: d.label, kind: 'detour' };
  return g;
}

/** 하루 raw → 그룹별 {n,spd,min,tt,am,pm,cg,h[24],tth[24]} */
function aggregateDay(raw) {
  const out = {};
  const byGroup = {};
  raw.rows.forEach(([min, idx, spd, tt, cg]) => {
    const grp = raw.links[raw.ids[idx]]?.grp;
    if (!grp || !(spd > 0)) return;
    const g = byGroup[grp] ??= { byMin: {} };
    (g.byMin[min] ??= []).push({ spd, tt, cg });
  });
  for (const [grp, g] of Object.entries(byGroup)) {
    const hours = Array.from({ length: 24 }, () => []), hoursTt = Array.from({ length: 24 }, () => []), hoursCg = Array.from({ length: 24 }, () => []);
    const all = [], allTt = [], cgs = [];
    const isBridge = grp.startsWith('bridge:');
    for (const [min, samples] of Object.entries(g.byMin)) {
      // 같은 시각의 링크들을 한 표본으로: 속도는 평균, 통행시간은 합(교량 구간은 링크가 이어져 있음 — 우회도로는 링크가 띄어져 있어 합이 의미 없으므로 생략)
      const spd = mean(samples.map(s => s.spd));
      const tt = isBridge && samples.every(s => s.tt > 0) ? samples.reduce((a, s) => a + s.tt, 0) : null;
      const h = Math.floor(+min / 60);
      hours[h].push(spd); all.push(spd);
      if (tt != null) { hoursTt[h].push(tt); allTt.push(tt); }
      for (const s of samples) { cgs.push(s.cg); hoursCg[h].push(s.cg >= 2 ? 1 : 0); }
    }
    const slice = (a, b) => hours.slice(a, b).flat();
    out[grp] = {
      n: all.length,
      spd: r1(mean(all)),
      min: r1(Math.min(...all)),
      tt: allTt.length ? Math.round(mean(allTt)) : null,
      am: slice(...PEAK.am).length ? r1(mean(slice(...PEAK.am))) : null,
      pm: slice(...PEAK.pm).length ? r1(mean(slice(...PEAK.pm))) : null,
      cg: cgs.length ? Math.round(cgs.filter(c => c >= 2).length / cgs.length * 1000) / 1000 : null,
      h: hours.map(a => a.length ? r1(mean(a)) : null),
      tth: hoursTt.some(a => a.length) ? hoursTt.map(a => a.length ? Math.round(mean(a)) : null) : undefined,
      cgh: hoursCg.map(a => a.length ? Math.round(mean(a) * 100) / 100 : null),
    };
  }
  return out;
}

function rebuildDaily(touchDates) {
  const daily = readJson(join(DATA, 'daily.json'), { days: {} });
  daily.groups = groupsMeta();
  daily.closure = CFG.closure;
  daily.tz = 'Asia/Seoul';
  daily.peak = PEAK;
  daily.source = { name: '대전광역시_대전교통정보 서비스 (공공데이터포털 15157924)', url: 'https://www.data.go.kr/data/15157924/openapi.do', interval: '10분' };
  const dates = touchDates ?? readdirSync(RAW).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10));
  for (const d of dates) {
    const raw = readJson(join(RAW, `${d}.json`), null);
    if (!raw) continue;
    daily.days[d] = aggregateDay(raw);
  }
  daily.days = Object.fromEntries(Object.entries(daily.days).sort(([a], [b]) => a.localeCompare(b)));
  daily.updated = kstNow().iso;
  daily.firstDate = Object.keys(daily.days)[0] ?? null;
  writeJson(join(DATA, 'daily.json'), daily);
  return daily;
}

function pruneRaw(today) {
  const cutoff = new Date(today); cutoff.setUTCDate(cutoff.getUTCDate() - RAW_KEEP_DAYS);
  const c = cutoff.toISOString().slice(0, 10);
  for (const f of readdirSync(RAW)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < c) unlinkSync(join(RAW, f));
}

/* ---------- 실행 ---------- */
async function main() {
  if (flag('--rebuild')) { const d = rebuildDaily(); console.log(`daily.json 재계산: ${Object.keys(d.days).length}일`); return; }

  const key = process.env.DATA_GO_KR_KEY;
  let all;
  if (opt('--from-file')) all = parseResponse(readFileSync(opt('--from-file'), 'utf8')).items;
  else {
    if (!key) { console.error('DATA_GO_KR_KEY 환경변수가 없습니다. 공공데이터포털에서 「대전광역시_대전교통정보 서비스」 활용신청(자동승인) 후 인증키를 넣어 주세요.'); process.exit(2); }
    all = await fetchAll(key);
  }
  const now = kstNow();
  console.log(`${now.iso} 링크 ${all.length}개 수신`);

  if (flag('--discover')) {
    const drx = rx(CFG.discoverMatch);
    const cand = all.filter(l => drx.test(`${l.road} ${l.s} ${l.e}`)).map(l => ({ ...l, grp: classify(l) }))
      .sort((a, b) => (a.grp ?? 'z').localeCompare(b.grp ?? 'z') || a.road.localeCompare(b.road) || a.sqc - b.sqc);
    writeJson(join(DATA, 'discover.json'), { at: now.iso, total: all.length, candidates: cand }, true);
    for (const l of cand) console.log(`${(l.grp ?? '-').padEnd(18)} ${l.id.padEnd(12)} ${l.road.padEnd(10)} ${l.s} → ${l.e}  ud=${l.ud} len=${l.len} spd=${l.spd}`);
    console.log(`\n후보 ${cand.length}개 → traffic/data/discover.json. 교량 링크가 맞게 bridge:* 로 분류됐는지, 방향(ud)이 실제와 맞는지 확인하세요.`);
    return;
  }

  const picked = all.map(l => ({ ...l, grp: classify(l) })).filter(l => l.grp);
  if (!picked.length) { console.error('조건에 맞는 링크가 없습니다. --discover 로 노드 이름을 확인하고 links.json 을 고쳐 주세요.'); process.exit(3); }
  const bridgeN = picked.filter(l => l.grp.startsWith('bridge:')).length;
  console.log(`선택 ${picked.length}개 (교량 ${bridgeN}, 우회도로 ${picked.length - bridgeN})`);

  // raw 누적
  const rawPath = join(RAW, `${now.date}.json`);
  const raw = readJson(rawPath, { date: now.date, ids: [], links: {}, rows: [] });
  for (const l of picked) {
    if (!raw.links[l.id]) { raw.links[l.id] = { road: l.road, s: l.s, e: l.e, ud: l.ud, len: l.len, grp: l.grp }; raw.ids.push(l.id); }
    const idx = raw.ids.indexOf(l.id);
    // 같은 분(minute)에 중복 실행되면 덮어쓴다
    const dup = raw.rows.findIndex(r => r[0] === now.minute && r[1] === idx);
    const row = [now.minute, idx, r1(l.spd), Math.round(l.tt) || 0, l.cg | 0];
    if (dup >= 0) raw.rows[dup] = row; else raw.rows.push(row);
  }
  writeJson(rawPath, raw);

  // latest
  const groups = {};
  for (const l of picked) {
    const g = groups[l.grp] ??= { spd: [], tt: 0, ttOk: true, cg: [], n: 0 };
    if (l.spd > 0) { g.spd.push(l.spd); g.cg.push(l.cg); g.n++; }
    if (l.tt > 0) g.tt += l.tt; else g.ttOk = false;
  }
  const latest = {
    t: now.iso,
    links: picked.map(l => ({ id: l.id, grp: l.grp, road: l.road, s: l.s, e: l.e, ud: l.ud, len: l.len, spd: r1(l.spd), tt: Math.round(l.tt) || null, cg: l.cg | 0, sqc: l.sqc })),
    groups: Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, {
      n: g.n, spd: g.spd.length ? r1(mean(g.spd)) : null,
      tt: k.startsWith('bridge:') && g.ttOk && g.n ? Math.round(g.tt) : null,
      cg: g.cg.length ? Math.round(g.cg.filter(c => c >= 2).length / g.cg.length * 1000) / 1000 : null,
    }])),
  };
  writeJson(join(DATA, 'latest.json'), latest);

  // 오늘(+전날: 자정 직후 실행이 전날 집계를 마무리) 다시 집계
  const y = new Date(now.date); y.setUTCDate(y.getUTCDate() - 1);
  rebuildDaily([y.toISOString().slice(0, 10), now.date]);
  pruneRaw(now.date);

  for (const [k, g] of Object.entries(latest.groups)) console.log(`  ${k.padEnd(18)} 속도 ${g.spd ?? '-'} km/h  통행시간 ${g.tt ?? '-'} s  혼잡 ${g.cg == null ? '-' : Math.round(g.cg * 100) + '%'}  (링크 ${g.n})`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
