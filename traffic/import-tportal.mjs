#!/usr/bin/env node
/**
 * tportal-export.json(tportal-fetch.js 또는 collect-tportal.mjs 가 만든 것) → 대시보드 자료 3종
 *
 *   node traffic/import-tportal.mjs tportal-export.json [--baseline 2026-09-28~2026-10-16] [--exclude 2026-10-09,2026-10-03] [--dry]
 *
 *   data/history.json   구간별 시간대 통행속도 (수집 시작 전 날짜를 대시보드가 채우는 데 쓴다)
 *   data/volume.json    VDS 일별 교통량(방향별 합계·시간대별), 통제 전 평일 평균
 *   data/baseline.json  통제 전 기준 — 평일·주말 각각의 시간대 프로필 (--baseline 기간, --exclude 제외). 옵션이 없으면 건드리지 않는다.
 *
 * 같은 기간을 다시 넣으면 날짜별로 덮어쓴다(기존 날짜는 유지). collect-tportal.mjs 가 이 파일의 importExport() 를 가져다 쓴다.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)), DATA = join(HERE, 'data');
const readJson = (p, fb) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb;
const mean = a => { const b = a.filter(v => v != null && v > 0); return b.length ? b.reduce((s, v) => s + v, 0) / b.length : null; };
const r1 = v => v == null ? null : Math.round(v * 10) / 10;
const dow = d => new Date(d + 'T00:00:00+09:00').getDay(), isWe = d => [0, 6].includes(dow(d));

/* 구간 → 그룹 매핑 (상행 3501 = 둔산→연구단지, 하행 3502 = 연구단지→둔산) */
export const MAP = {
  'bridge:toDaedeok':   ['3501', '대덕대교네거리▶과학공원네거리'],
  'bridge:toDunsan':    ['3502', '과학공원네거리▶대덕대교네거리'],
  'approach:toDaedeok': ['3501', '만년상아아파트▶대덕대교네거리'],
  'approach:toDunsan':  ['3502', '북부소방서▶과학공원네거리'],
  'exit:toDaedeok':     ['3501', '과학공원네거리▶북부소방서'],
  'exit:toDunsan':      ['3502', '대덕대교네거리▶만년상아아파트'],
};
const LABEL = { 'approach:toDaedeok': '교량 진입 (만년상아아파트→대덕대교네거리)', 'approach:toDunsan': '교량 진입 (북부소방서→과학공원네거리)', 'exit:toDaedeok': '교량 진출 (과학공원네거리→북부소방서)', 'exit:toDunsan': '교량 진출 (대덕대교네거리→만년상아아파트)' };
export const VDIR = { VDS0016: 'toDaedeok', VDS0015: 'toDunsan' };

/** X: export 객체. opts: {baseline:'s~e', exclude:['...'], dry} → {hist, vol, base, log[]} */
export function importExport(X, opts = {}) {
  const log = [];
  const today = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);

  /* ---------- history.json ---------- */
  const hist = readJson(join(DATA, 'history.json'), { groups: {} });
  hist.source = '대전교통 빅데이터 플랫폼(tportal.daejeon.go.kr) 도로소통정보 · 구간별 통행속도 1시간 평균';
  hist.fetched = X.fetched ?? today; hist.tunit = '1h';
  for (const [grp, [dir, sec]] of Object.entries(MAP)) {
    const days = X.sections?.[dir]?.[sec]; if (!days) { log.push(`구간 없음: ${dir} ${sec}`); continue; }
    const g = hist.groups[grp] ??= { section: sec, dir, days: {} };
    if (LABEL[grp]) g.label = LABEL[grp];
    for (const [d, h] of Object.entries(days)) { if (d >= today) continue; if (h.filter(v => v > 0).length < 20) continue; g.days[d] = h.map(v => v > 0 ? r1(v) : null); }
    g.days = Object.fromEntries(Object.entries(g.days).sort(([a], [b]) => a.localeCompare(b)));
  }
  const hDays = Object.keys(hist.groups['bridge:toDunsan']?.days ?? {});
  log.push(`history: 그룹 ${Object.keys(hist.groups).length}개, 교량 ${hDays.length}일 (${hDays[0]} ~ ${hDays.at(-1)})`);

  /* ---------- volume.json ---------- */
  const vol = readJson(join(DATA, 'volume.json'), { days: {} });
  vol.unit = '대/일';
  vol.source = '대전교통 빅데이터 플랫폼 도로-교통량 VDS(지점별) · VDS0016 만년네거리▶서구보건소네거리(상행=연구단지 방향) · VDS0015 대덕대교네거리▶만년상아아파트(하행=둔산 방향) — 교량 인접 지점';
  vol.imported = today; vol.hours ??= {}; vol.vdsSpeed ??= {};
  for (const [vds, info] of Object.entries(X.vds ?? {})) {
    const k = VDIR[vds]; if (!k) continue;
    for (const [d, o] of Object.entries(info.days ?? {})) {
      if (d >= today) continue;
      const have = o.vol.filter(v => v != null).length; if (have < 20) continue; // 결측 많은 날 제외
      const sum = o.vol.reduce((s, v) => s + (v ?? 0), 0) * (24 / have);
      (vol.days[d] ??= {})[k] = Math.round(sum);
      (vol.hours[d] ??= {})[k] = o.vol.map(v => v == null ? null : Math.round(v));
      (vol.vdsSpeed[d] ??= {})[k] = o.spd.map(v => v > 0 ? r1(v) : null);
    }
  }
  for (const d of Object.keys(vol.days)) { const o = vol.days[d]; if (o.toDaedeok != null && o.toDunsan != null) o.total = o.toDaedeok + o.toDunsan; else delete o.total; }
  vol.days = Object.fromEntries(Object.entries(vol.days).sort(([a], [b]) => a.localeCompare(b)));
  const vDays = Object.keys(vol.days);
  log.push(`volume: ${vDays.length}일 (${vDays[0]} ~ ${vDays.at(-1)}), 마지막 날 ${JSON.stringify(vol.days[vDays.at(-1)])}`);

  /* ---------- baseline.json ---------- */
  let base = null;
  if (opts.baseline) {
    const [s, e] = opts.baseline.split('~'); const ex = new Set(opts.exclude ?? []);
    const pick = we => hDays.filter(d => d >= s && d <= e && !ex.has(d) && isWe(d) === we);
    const prof = (grp, ds) => { const g = hist.groups[grp]; if (!g) return null; const h = Array.from({ length: 24 }, (_, i) => r1(mean(ds.map(d => g.days[d]?.[i])))); return { h, spd: r1(mean(h)), am: r1(mean(h.slice(7, 9))), pm: r1(mean(h.slice(17, 19))), n: ds.length }; };
    const wd = pick(false), we = pick(true);
    base = { period: `${s.slice(5).replace('-', '/')}~${e.slice(5).replace('-', '/')} 평일 ${wd.length}일`, range: [s, e], exclude: [...ex], source: hist.source, groups: {} };
    for (const grp of Object.keys(MAP)) { const p = prof(grp, wd); if (p) base.groups[grp] = { ...p, we: prof(grp, we) }; }
    const vt = wd.map(d => vol.days[d]?.total).filter(Boolean);
    if (vt.length) { vol.before = Math.round(mean(vt)); vol.beforeNote = `통제 전 평일 평균 (${base.period})`; base.volume = { total: vol.before, toDaedeok: Math.round(mean(wd.map(d => vol.days[d]?.toDaedeok))), toDunsan: Math.round(mean(wd.map(d => vol.days[d]?.toDunsan))) }; }
    log.push(`baseline: ${base.period}, 주말 ${we.length}일 — 둔산 방향 ${base.groups['bridge:toDunsan']?.spd} km/h (출근 ${base.groups['bridge:toDunsan']?.am} / 퇴근 ${base.groups['bridge:toDunsan']?.pm}), 연구단지 방향 ${base.groups['bridge:toDaedeok']?.spd} (출근 ${base.groups['bridge:toDaedeok']?.am} / 퇴근 ${base.groups['bridge:toDaedeok']?.pm}), 교통량 ${vol.before ?? '-'} 대/일`);
  }

  if (!opts.dry) {
    writeFileSync(join(DATA, 'history.json'), JSON.stringify(hist) + '\n');
    writeFileSync(join(DATA, 'volume.json'), JSON.stringify(vol) + '\n');
    if (base) writeFileSync(join(DATA, 'baseline.json'), JSON.stringify(base) + '\n');
    log.push(`→ traffic/data/history.json, volume.json${base ? ', baseline.json' : ''}`);
  }
  return { hist, vol, base, log };
}

/* ---------- CLI ---------- */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ARGS = process.argv.slice(2);
  const opt = n => { const i = ARGS.indexOf(n); return i >= 0 ? ARGS[i + 1] : null; };
  const file = ARGS.find((a, i) => !a.startsWith('--') && !['--baseline', '--exclude'].includes(ARGS[i - 1]));
  if (!file || !existsSync(file)) { console.error('사용법: node traffic/import-tportal.mjs tportal-export.json [--baseline 시작~끝] [--exclude 날짜,날짜] [--dry]'); process.exit(2); }
  const { log } = importExport(JSON.parse(readFileSync(file, 'utf8')), { baseline: opt('--baseline'), exclude: (opt('--exclude') ?? '').split(',').filter(Boolean), dry: ARGS.includes('--dry') });
  console.log(log.join('\n'));
}
