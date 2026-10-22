#!/usr/bin/env node
/**
 * 대덕대교 통행 모니터 — 교통정보센터 통계 가져오기 (교통량 · 통제 전 기준)
 *
 * 소통정보 API는 차량 대수를 주지 않는다. 대전교통정보센터 「교통데이터 통계분석」(tportal.daejeon.go.kr) 에서
 * 내려받은 CSV/TSV 를 대시보드가 읽는 JSON 으로 바꾼다.
 *
 *   node traffic/import-volume.mjs <파일.csv>                       # 일별 교통량 → data/volume.json
 *   node traffic/import-volume.mjs <파일.csv> --baseline 2026-09-01~2026-10-18   # 통제 전 시간대별 속도 → data/baseline.json
 *   옵션: --source "출처 표기"  --encoding euc-kr  --dry
 *
 * 열 이름은 자동으로 찾는다 (대소문자·공백 무시):
 *   날짜   : 일자, 날짜, 일시, date, 수집일
 *   방향   : 방향, 상하행, 상행/하행, direction  (값에 '상' 또는 '하', 또는 둔산/연구단지·유성 이 들어가면 방향으로 인식)
 *   교통량 : 교통량, 통행량, 대수, volume, 합계
 *   시간대 : 시간, 시간대, hour  (또는 00시~23시 / 0~23 이름의 열 24개 → 시간대별 값으로 인식해 합산)
 *   속도   : 속도, 평균속도, speed  (--baseline 일 때)
 * 방향 값 → 키: '상' 또는 유성·연구단지·도룡 → toDaedeok, '하' 또는 둔산·만년·서구 → toDunsan. 반대면 --swap.
 * 파일 형식이 다르면 아래 norm() 의 표를 고치면 된다.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const VALOPTS = ['--baseline', '--source', '--encoding'];
const file = ARGS.find((a, i) => !a.startsWith('--') && !VALOPTS.includes(ARGS[i - 1]));
const opt = n => { const i = ARGS.indexOf(n); return i >= 0 ? ARGS[i + 1] : null; };
const flag = n => ARGS.includes(n);
if (!file || !existsSync(file)) { console.error('사용법: node traffic/import-volume.mjs <csv 파일> [--baseline 기간] [--source 출처] [--encoding euc-kr] [--swap] [--dry]'); process.exit(2); }

/* ---------- 읽기 (UTF-8 → 깨지면 EUC-KR) ---------- */
const buf = readFileSync(file);
let text;
const enc = opt('--encoding');
if (enc) text = new TextDecoder(enc).decode(buf);
else { text = new TextDecoder('utf-8', { fatal: false }).decode(buf); if (/�/.test(text)) text = new TextDecoder('euc-kr').decode(buf); }
text = text.replace(/^﻿/, '');

/* ---------- CSV/TSV 파서 ---------- */
function parseCsv(t) {
  const delim = (t.split('\n')[0].match(/\t/g) || []).length > (t.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cell); if (row.some(x => x.trim() !== '')) rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); if (row.some(x => x.trim() !== '')) rows.push(row); }
  return rows;
}
const rows = parseCsv(text);
// 머리글 행: 날짜/일자 같은 낱말이 있는 첫 행 (앞에 제목 줄이 있을 수 있음)
const hi = Math.max(0, rows.findIndex(r => r.filter(c => c.trim()).length >= 2 && r.some(c => /일자|날짜|일시|date|수집일|통계일/i.test(c))));
const head = rows[hi].map(h => h.replace(/\s+/g, '').toLowerCase());
const body = rows.slice(hi + 1);
const col = re => head.findIndex(h => re.test(h));
const C = {
  date: col(/^(일자|날짜|일시|date|수집일|통계일)/),
  dir: col(/방향|상하행|상행\/하행|direction/),
  vol: col(/^(교통량|통행량|대수|volume|합계|총계|일교통량)/),
  hour: col(/^(시간대|시간|hour)$/),
  spd: col(/속도|speed/),
};
const hourCols = head.map((h, i) => ({ h, i })).filter(x => /^(\d{1,2})(시|~|:|$)/.test(x.h) || /^\d{2}시?(-|~)\d{2}/.test(x.h)).map(x => ({ i: x.i, hour: +x.h.match(/\d{1,2}/)[0] }));
if (C.date < 0) { console.error('날짜 열을 찾지 못했습니다. 머리글:', head.join(' | ')); process.exit(3); }

const normDate = s => { const m = String(s).match(/(\d{4})[.\-/년]?\s*(\d{1,2})[.\-/월]?\s*(\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null; };
const num = s => { const v = parseFloat(String(s).replace(/[^\d.\-]/g, '')); return Number.isFinite(v) ? v : null; };
const swap = flag('--swap');
function dirKey(s) {
  if (s == null || s === '') return 'total';
  const t = String(s);
  let k = /유성|연구단지|도룡|과학공원|상/.test(t) ? 'toDaedeok' : /둔산|만년|서구|하|정부청사/.test(t) ? 'toDunsan' : 'total';
  if (swap && k !== 'total') k = k === 'toDaedeok' ? 'toDunsan' : 'toDaedeok';
  return k;
}

/* ---------- 교통량 ---------- */
function importVolume() {
  const days = {};
  for (const r of body) {
    const d = normDate(r[C.date]); if (!d) continue;
    const k = dirKey(C.dir >= 0 ? r[C.dir] : null);
    let v = null;
    if (hourCols.length >= 20) v = hourCols.reduce((a, x) => a + (num(r[x.i]) ?? 0), 0);            // 시간대 열 24개 → 합산
    else if (C.hour >= 0 && C.vol >= 0) { v = num(r[C.vol]); (days[d] ??= {}); days[d][k] = (days[d][k] ?? 0) + (v ?? 0); continue; } // 시간대별 행 → 누적
    else if (C.vol >= 0) v = num(r[C.vol]);
    if (v == null) continue;
    (days[d] ??= {})[k] = Math.round(v);
  }
  for (const d of Object.keys(days)) { const o = days[d]; if (o.toDaedeok != null || o.toDunsan != null) o.total = (o.toDaedeok ?? 0) + (o.toDunsan ?? 0); }
  const out = { unit: '대/일', source: opt('--source') ?? `대전교통정보센터 교통데이터 통계분석 (${basename(file)})`, imported: new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10), before: 60000, days: Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b))) };
  const n = Object.keys(out.days).length;
  console.log(`교통량 ${n}일: ${Object.keys(out.days)[0]} ~ ${Object.keys(out.days)[n - 1]}`);
  if (!n) process.exit(4);
  if (!flag('--dry')) writeFileSync(join(HERE, 'data', 'volume.json'), JSON.stringify(out) + '\n'), console.log('→ traffic/data/volume.json');
}

/* ---------- 통제 전 기준 (시간대별 속도) ---------- */
function importBaseline(period) {
  if (C.spd < 0) { console.error('속도 열을 찾지 못했습니다. 머리글:', head.join(' | ')); process.exit(3); }
  const acc = {}; // key → hour → [spd]
  for (const r of body) {
    const d = normDate(r[C.date]); if (!d) continue;
    const k = dirKey(C.dir >= 0 ? r[C.dir] : null); if (k === 'total') continue;
    const h = C.hour >= 0 ? +String(r[C.hour]).match(/\d{1,2}/)?.[0] : null;
    const v = num(r[C.spd]); if (v == null || h == null || h > 23) continue;
    ((acc[k] ??= Array.from({ length: 24 }, () => []))[h]).push(v);
  }
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null, r1 = x => x == null ? null : Math.round(x * 10) / 10;
  const groups = {};
  for (const [k, hrs] of Object.entries(acc)) {
    const h = hrs.map(a => r1(mean(a)));
    groups[`bridge:${k}`] = { h, spd: r1(mean(h.filter(v => v != null))), am: r1(mean(h.slice(7, 9).filter(v => v != null))), pm: r1(mean(h.slice(17, 19).filter(v => v != null))) };
  }
  const out = { period: period || '통제 전', source: opt('--source') ?? `대전교통정보센터 교통데이터 통계분석 (${basename(file)})`, imported: new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10), groups };
  console.log('기준 프로필:', Object.entries(groups).map(([k, g]) => `${k} 평균 ${g.spd} / 출근 ${g.am} / 퇴근 ${g.pm}`).join(' · '));
  if (!Object.keys(groups).length) process.exit(4);
  if (!flag('--dry')) writeFileSync(join(HERE, 'data', 'baseline.json'), JSON.stringify(out) + '\n'), console.log('→ traffic/data/baseline.json');
}

if (flag('--baseline')) importBaseline(opt('--baseline')); else importVolume();
