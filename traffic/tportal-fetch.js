/**
 * 대전교통 빅데이터 플랫폼(tportal.daejeon.go.kr)에서 대덕대교 구간 과거 자료를 내려받는 브라우저 콘솔 스크립트.
 *
 * 사용법
 *   1) https://tportal.daejeon.go.kr/analysis/trafficvolume 를 연다 (로그인 불필요).
 *   2) 개발자도구(F12) → Console 에 이 파일 내용을 통째로 붙여 넣고 Enter.
 *      기간을 바꾸려면 맨 아래 run('2026-09-01','2026-10-31') 의 날짜를 고친다. 종료일은 어제까지만 자료가 있다.
 *   3) 끝나면 tportal-export.json 이 내려받아진다 (사이트 API 가 느려 몇 분 걸릴 수 있음).
 *   4) node traffic/import-tportal.mjs tportal-export.json --baseline 2026-09-28~2026-10-16 --exclude 2026-10-09
 *
 * 받는 것
 *   - 도로소통정보 > 구간별 통행속도(1시간): 대덕대로 상행·하행 중 대덕대교 인접 구간 10개
 *   - 도로-교통량 > VDS(지점별, 1시간): VDS0016(상행, 만년네거리▶서구보건소네거리) · VDS0015(하행, 대덕대교네거리▶만년상아아파트)
 *     — 대덕대교 위에는 VDS 가 없고, 이 둘이 교량 바로 옆(만년동 쪽) 지점이다. 시의 트램구간 일간보고서 5공구 값과 같은 지점.
 * 사이트 내부 API(/web-service/api/v1/road/*)를 그대로 쓰므로 화면이 바뀌면 고쳐야 할 수 있다.
 */
(async function run(START = '2026-09-01', END = new Date(Date.now() + 9 * 36e5 - 864e5).toISOString().slice(0, 10)) {
  const sid = (document.cookie.match(/DJT_SID=([^;]+)/) || [])[1] || '';
  const api = async (p, body) => { const r = await fetch(p, { method: 'POST', headers: { 'Content-type': 'application/json;charset=UTF-8', 'X-Site-Id': '1', 'X-Visit': sid }, body: JSON.stringify(body) }); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`HTTP ${r.status} ${t.slice(0, 60)}`); } };
  const DAYS = ['1502', '1503', '1504', '1505', '1506', '1507', '1501'];
  const KEEP = /대덕대교|과학공원|만년상아|북부소방서/;
  const VDS = [['VDS0016', '3501'], ['VDS0015', '3502']];
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const chunks = (a, b, n) => { const out = []; let s = new Date(a); const e = new Date(b); while (s <= e) { const t = new Date(Math.min(e, s.getTime() + (n - 1) * 864e5)); out.push([fmt(s), fmt(t)]); s = new Date(t.getTime() + 864e5); } return out; };
  const retry = async (fn, n = 3) => { let err; for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { err = e; await new Promise(r => setTimeout(r, 3000)); } } throw err; };
  const out = { fetched: new Date().toISOString().slice(0, 10), range: [START, END], sections: {}, vds: {} };
  const log = (...a) => console.log('[tportal]', ...a);

  for (const dir of ['3501', '3502']) for (const [a, b] of chunks(START, END, 10)) {
    const r = await retry(() => api('/web-service/api/v1/road/getTrafficSpeedBySection', { chodate: 'up', tunit: '1h', sdate: a, edate: b, direction: dir, stime: '00', etime: '23', days: 'allDay', dayArr: DAYS, road: '대덕대로' }));
    if (!Array.isArray(r)) { log('구간속도 실패', dir, a, b); continue; }
    for (const x of r) {
      if (!KEEP.test(x.nodeNm)) continue;
      const m = x.ymdNm.match(/(\d{4})년 (\d{1,2})월 (\d{1,2})일/); const ymd = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
      (((out.sections[dir] ??= {})[x.nodeNm] ??= {})[ymd] ??= Array(24).fill(null))[+x.hhId] = x.speed;
    }
    log('구간속도', dir, a, b, r.length);
  }
  for (const [vds, dir] of VDS) for (const [a, b] of chunks(START, END, 3)) {
    const r = await retry(() => api('/web-service/api/v1/road/getVDSByLocationDetail', { chodate: 'up', tunit: '1h', sdate: a, edate: b, direction: dir, stime: '00', etime: '23', days: 'allDay', dayArr: DAYS, road: '대덕대로', vdsid: vds }));
    if (!Array.isArray(r)) { log('VDS 실패', vds, a, b); continue; }
    for (const x of r) {
      const y = x.ymdId; const ymd = `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;
      const d = ((out.vds[vds] ??= { dir, loc: x.instLocat, node: x.nodeNm, days: {} }).days[ymd] ??= { spd: Array(24).fill(null), vol: Array(24).fill(null) });
      d.spd[+x.hhId] = x.vdsTrvlSpdYmdh; d.vol[+x.hhId] = x.vdsTrVolYmdhTot;
    }
    log('VDS', vds, a, b, r.length);
  }
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  const u = URL.createObjectURL(blob); const el = document.createElement('a'); el.href = u; el.download = 'tportal-export.json'; document.body.appendChild(el); el.click(); el.remove();
  log('완료 — tportal-export.json 저장');
  window.__tportalExport = out;
})();
