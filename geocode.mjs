#!/usr/bin/env node
/**
 * 둔산 재건축 트래커 — 단지 경계·좌표 갱신 스크립트 (API 키 불필요)
 *
 * data.js(window.DUNSAN_DATA)를 읽어
 *   1) pts[].osm 이 있는 단지: Overpass API로 OSM 폴리곤을 다시 받아 rings·중심점을 갱신
 *   2) pts[].osm 이 없는 단지(새로 추가한 단지): Nominatim으로 이름 검색해 OSM id를 찾은 뒤 1)과 동일
 * 결과를 같은 블록에 다시 씁니다.
 *
 *   node geocode.mjs            # 전체 갱신
 *   node geocode.mjs --dry      # 파일을 쓰지 않고 결과만 출력
 *
 * 새 단지를 추가하려면 zone-data의 cx 배열에 이름만 넣고 실행하면 됩니다.
 * (2026.10.21 현재 17개 구역 48개 단지 전부 좌표가 들어 있어 평소에는 실행할 필요가 없습니다.)
 * 둘 다 OpenStreetMap 공개 서비스라 키가 필요 없고, Nominatim은 1초에 1건만 요청합니다.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('./data.js', import.meta.url);
const DRY = process.argv.includes('--dry');
const UA = 'dunsan-tracker/1.0 (geocode script)';
const BBOX = { s: 36.335, w: 127.355, n: 36.380, e: 127.420 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const src = readFileSync(FILE, 'utf8');
const m = src.match(/^window\.DUNSAN_DATA\s*=\s*([\s\S]*);\s*$/);
if (!m) { console.error('data.js 형식을 인식하지 못했습니다 (window.DUNSAN_DATA = {...};).'); process.exit(1); }
const data = JSON.parse(m[1]);

/* --- Nominatim: 이름 → OSM id (폴리곤 우선) --- */
async function findOsmId(name, dong) {
  const apt = /\d단지$/.test(name) ? name.replace(/(\d)단지$/, '아파트 $1단지') : name.replace(/\(.*\)/, '') + '아파트';
  for (const q of [`대전 서구 ${apt}`, `대전 서구 ${dong || '둔산동'} ${apt}`, `대전 ${name}`]) {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=kr&q=' + encodeURIComponent(q), { headers: { 'User-Agent': UA } });
    await sleep(1100);
    if (!r.ok) continue;
    const j = (await r.json()).filter(x => +x.lat > BBOX.s && +x.lat < BBOX.n && +x.lon > BBOX.w && +x.lon < BBOX.e);
    const poly = j.find(x => x.osm_type === 'way' || x.osm_type === 'relation');
    if (poly) return `${poly.osm_type}/${poly.osm_id}`;
  }
  return null;
}

/* --- Overpass: OSM id 목록 → 폴리곤 --- */
async function fetchGeom(ids) {
  const ways = ids.filter(i => i.startsWith('way/')).map(i => i.split('/')[1]);
  const rels = ids.filter(i => i.startsWith('relation/')).map(i => i.split('/')[1]);
  const parts = [];
  if (ways.length) parts.push(`way(id:${ways.join(',')});`);
  if (rels.length) parts.push(`relation(id:${rels.join(',')});`);
  const ql = `[out:json][timeout:60];(${parts.join('')});out geom;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: 'data=' + encodeURIComponent(ql) });
  if (!r.ok) throw new Error('overpass ' + r.status);
  const j = await r.json();
  const out = {};
  for (const e of j.elements) {
    const key = `${e.type}/${e.id}`;
    if (e.type === 'way') out[key] = e.geometry.map(p => [+p.lat.toFixed(6), +p.lon.toFixed(6)]);
    else out[key] = chain(e.members.filter(x => x.type === 'way' && x.role === 'outer').map(x => x.geometry.map(p => [+p.lat.toFixed(6), +p.lon.toFixed(6)])));
  }
  return out;
}
function chain(segs) {
  if (!segs.length) return [];
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  let ring = segs.shift();
  while (segs.length) {
    const i = segs.findIndex(s => same(s[0], ring.at(-1)) || same(s.at(-1), ring.at(-1)) || same(s.at(-1), ring[0]) || same(s[0], ring[0]));
    if (i < 0) break;
    const s = segs.splice(i, 1)[0];
    if (same(s[0], ring.at(-1))) ring = ring.concat(s.slice(1));
    else if (same(s.at(-1), ring.at(-1))) ring = ring.concat(s.reverse().slice(1));
    else if (same(s.at(-1), ring[0])) ring = s.slice(0, -1).concat(ring);
    else ring = s.reverse().slice(0, -1).concat(ring);
  }
  return ring;
}
function centroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [y0, x0] = ring[i], [y1, x1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0; a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  a /= 2;
  return Math.abs(a) < 1e-12 ? ring[0] : [+(cy / (6 * a)).toFixed(6), +(cx / (6 * a)).toFixed(6)];
}

/* --- 실행 --- */
for (const z of data.zones) {
  if (!z.cx) continue;
  z.pts = z.pts || [];
  for (const name of z.cx) {
    let p = z.pts.find(x => x.name === name);
    if (!p) { p = { name }; z.pts.push(p); }
    if (!p.osm) {
      p.osm = await findOsmId(name, z.dong);
      console.log(p.osm ? `  ✓ ${z.id}구역 ${name} → ${p.osm}` : `  ✗ ${z.id}구역 ${name} — OSM에서 찾지 못함 (osm 필드를 직접 적어 주세요)`);
    }
  }
}
const allIds = data.zones.flatMap(z => (z.pts || []).map(p => p.osm).filter(Boolean));
const geom = await fetchGeom(allIds);
for (const z of data.zones) {
  if (!z.pts || !z.pts.length) continue;
  z.rings = [];
  for (const p of z.pts) {
    const ring = geom[p.osm];
    if (!ring || ring.length < 4) { console.log(`  ✗ ${z.id}구역 ${p.name} 폴리곤 없음`); continue; }
    [p.lat, p.lng] = centroid(ring); z.rings.push(ring);
  }
  const ok = z.pts.filter(p => p.lat != null);
  if (ok.length) {
    z.lat = +(ok.reduce((a, p) => a + p.lat, 0) / ok.length).toFixed(6);
    z.lng = +(ok.reduce((a, p) => a + p.lng, 0) / ok.length).toFixed(6);
    z.approx = ok.length < z.cx.length;
  }
  console.log(`통합 ${z.id}구역  중심 ${z.lat}, ${z.lng}  단지 ${ok.length}/${z.cx.length}`);
}
data.sources = { ...(data.sources||{}), osm: `OpenStreetMap 단지 경계 ${new Date().toISOString().slice(0, 10)} 조회` };
if (DRY) process.exit(0);
writeFileSync(FILE, 'window.DUNSAN_DATA = ' + JSON.stringify(data, null, 0) + ';\n');
console.log('data.js 갱신 완료 — node validate.mjs 로 검사하세요');
