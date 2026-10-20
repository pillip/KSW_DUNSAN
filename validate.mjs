#!/usr/bin/env node
/**
 * data.js 무결성 검사. `node validate.mjs` — 문제가 있으면 종료코드 1.
 * GitHub Actions(.github/workflows/validate.yml)가 push·PR마다 실행합니다.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./data.js', import.meta.url), 'utf8');
const m = src.match(/^window\.DUNSAN_DATA\s*=\s*([\s\S]*);\s*$/);
if (!m) fail('data.js는 `window.DUNSAN_DATA = {...};` 형식이어야 합니다.');
let d;
try { d = JSON.parse(m[1]); } catch (e) { fail('data.js의 객체가 올바른 JSON이 아닙니다: ' + e.message); }

const errors = [];
const STATUS = new Set(['selected', 'applied', 'none', 'excluded']);
const ids = d.zones.map(z => z.id).sort((a, b) => a - b);
if (ids.join() !== Array.from({ length: 17 }, (_, i) => i + 1).join()) errors.push('구역 id는 1~17이 한 번씩 있어야 합니다: ' + ids.join());

let sum = 0, pts = 0;
for (const z of d.zones) {
  const tag = `통합 ${z.id}구역`;
  if (!STATUS.has(z.status)) errors.push(`${tag}: status '${z.status}' 는 ${[...STATUS].join('/')} 중 하나여야 합니다.`);
  if (!Number.isInteger(z.units) || z.units <= 0) errors.push(`${tag}: units 가 양의 정수가 아닙니다.`);
  sum += z.units;
  if (!Array.isArray(z.cx) || !z.cx.length) errors.push(`${tag}: cx(단지 목록)가 비었습니다.`);
  if (!Array.isArray(z.pts) || z.pts.length !== z.cx.length) errors.push(`${tag}: pts 개수(${z.pts?.length})가 cx 개수(${z.cx?.length})와 다릅니다.`);
  if (!Array.isArray(z.rings) || z.rings.length !== z.cx.length) errors.push(`${tag}: rings 개수가 cx 개수와 다릅니다.`);
  const u = (z.pts || []).reduce((a, p) => a + (p.units || 0), 0);
  if (u !== z.units) errors.push(`${tag}: 단지 세대수 합계(${u})가 구역 세대수(${z.units})와 다릅니다.`);
  for (const p of z.pts || []) {
    pts++;
    if (!p.osm || !/^(way|relation)\/\d+$/.test(p.osm)) errors.push(`${tag} ${p.name}: osm id 형식 오류 (${p.osm})`);
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') errors.push(`${tag} ${p.name}: 좌표 없음`);
    if (p.lat < 36.33 || p.lat > 36.38 || p.lng < 127.35 || p.lng > 127.42) errors.push(`${tag} ${p.name}: 좌표가 둔산 범위를 벗어남 (${p.lat}, ${p.lng})`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.approved || '')) errors.push(`${tag} ${p.name}: 사용승인일 형식 오류 (${p.approved})`);
  }
  for (const r of z.rings || []) {
    if (!Array.isArray(r) || r.length < 4) errors.push(`${tag}: 폴리곤 꼭짓점이 4개 미만`);
    else if (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) errors.push(`${tag}: 폴리곤이 닫혀 있지 않습니다.`);
  }
  for (const k of ['area', 'site', 'far', 'baseFar', 'type', 'infra', 'pub']) if (z[k] == null) errors.push(`${tag}: ${k} 누락`);
  for (const k of z.src || []) if (!d.sources?.[k] && !['hh0715','hk0715','jd0715','gm0406','aru0331','aru0109','hk0810','nfz','jd0917','tjb0715','nate0715','sj0406','namu','sed0810'].includes(k)) errors.push(`${tag}: 알 수 없는 출처 키 '${k}'`);
}
if (sum !== d.total) errors.push(`구역 세대수 합계 ${sum} ≠ total ${d.total}`);
const ph = (d.phases || []).reduce((a, p) => a + p.units, 0);
if (ph !== d.total) errors.push(`연차별 정비물량 합계 ${ph} ≠ total ${d.total}`);
const pub = d.zones.reduce((a, z) => a + (z.pub?.est || 0), 0);
if (d.contrib && pub !== d.contrib.totalEst) errors.push(`공공기여 추정액 합계 ${pub} ≠ contrib.totalEst ${d.contrib.totalEst}`);
const sel = d.zones.filter(z => z.status === 'selected').reduce((a, z) => a + z.units, 0);
if (sel !== 5252) console.warn(`주의: 선도지구 세대수 합계가 5,252가 아닙니다 (${sel}). 2차 선정 반영이면 정상입니다.`);

if (errors.length) { console.error('✗ data.js 검사 실패\n- ' + errors.join('\n- ')); process.exit(1); }
console.log(`✓ data.js 정상 — 구역 ${d.zones.length}개, 단지 ${pts}개, 세대 ${sum.toLocaleString()}, 연차 ${d.phases.length}년, 업데이트 ${d.updated}`);

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }
