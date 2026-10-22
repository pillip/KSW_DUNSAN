# 둔산 재건축 트래커

둔산지구 노후계획도시 정비 17개 구역 48개 단지의 선도지구 선정 현황, 절차와 일정, 10년 로드맵, 공공기여 추정, 2차 공모 점수 계산기를 한 페이지에 담은 정적 사이트. 서버·빌드·API 키 없이 동작한다.

배포 주소: https://pillip.github.io/KSW_DUNSAN/

## 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 페이지. 마크업·스타일·스크립트가 한 파일에 있다. 데이터는 포함하지 않는다. |
| `data.js` | **모든 데이터.** `window.DUNSAN_DATA = {...}` 한 줄 안에 JSON 객체. 구역·단지·좌표·경계·연차별 물량·공공기여·평가 배점. |
| `validate.mjs` | `data.js` 무결성 검사. 세대수 합계, 좌표 범위, 폴리곤 닫힘, 연차 합계, 공공기여 합계 등. |
| `.github/workflows/validate.yml` | push·PR마다 `validate.mjs`, 수집 스크립트, HTML 인라인 스크립트 구문 검사를 실행. |
| `.github/workflows/traffic.yml` | 10분마다 대전교통정보 API를 수집해 `traffic/data/`에 커밋. |
| `geocode.mjs` | 새 단지를 추가할 때 OpenStreetMap에서 경계·중심점을 받아 `data.js`에 써 넣는다. |
| `assets/logo.svg`, `favicon*.png`, `apple-touch-icon.png`, `icon-*.png`, `site.webmanifest` | 마크와 아이콘 세트. |
| `og.png` | 링크 미리보기 이미지(1200×630). 실제 구역 폴리곤으로 그렸다. |
| `traffic.html`, `traffic/` | **대덕대교 통행 모니터** — 트램 공사 부분통제 기간의 소통 기록 대시보드와 수집 스크립트. 아래 별도 절. |
| `audit.html` | **행정사무감사 질의 도우미**(의정활동용, 검색엔진 제외). 집행부 약속 추적표(localStorage), 질의 항목 빌더(10개 주제, 질의서·구두요지·자료요구서 형식), 업무보고·회의록 PDF 분석(pdf.js, 브라우저 내 처리), 선택형 AI 초안(본인 Claude API 키, 브라우저에서 직접 호출). 주민용 페이지 푸터에서만 링크. |

외부 의존성(모두 키 불필요): Leaflet 1.9.4(cdnjs), 배경 지도는 OpenStreetMap 표준 타일 기본 · Esri World Imagery(위성) 전환, Google Fonts(IBM Plex Sans KR / Mono).

## 로컬에서 보기

`index.html`을 브라우저에서 직접 열면 된다. `data.js`는 `<script src>`로 읽으므로 `file://`에서도 동작한다.

OSM 타일 서버는 Referer가 없거나 브라우저가 아닌 User-Agent(앱 내장 웹뷰 등)의 요청을 403 "Access blocked" 그림 타일로 거부한다. 페이지는 첫 타일을 캔버스로 검사해 차단 타일이면 OSM HOT → Esri 위성 순으로 자동 전환한다. 앱 내장 미리보기에서는 배경이 위성영상으로 나올 수 있다.

## 데이터 갱신 절차

1. `data.js`를 고친다 (아래 필드 설명 참고).
2. `node validate.mjs` — 합계·형식 오류가 있으면 종료코드 1과 함께 이유를 출력한다.
3. push하면 GitHub Actions가 같은 검사를 다시 돌린다. 실패하면 배포 전에 확인한다.
4. `data.js`의 `updated`를 바꾸면 내비게이션의 "업데이트" 날짜가 따라간다.

### 자주 하는 변경

- **2차 선도지구 선정 결과(2027 예정)**: 해당 구역의 `status`를 `"selected"`로, `notes`에 선정일과 세대수를 추가. `validate.mjs`가 선도지구 합계가 5,252가 아니라고 경고하지만 정상이다.
- **고시본 수치 반영**: `units`·`area`·`site`·`far`·`pub` 대조. 합계가 48,721·2,647,064·3,909,206(백만 원)과 맞아야 검사를 통과한다.
- **연차별 정비물량 변경**: `phases[].units`. 합계가 `total`과 같아야 한다.
- **단지 추가**: `cx`에 이름을 넣고 `node geocode.mjs` 실행 → `pts`·`rings`·좌표가 채워진다. 세대수·사용승인일은 `pts[]`에 직접 적는다.

### 구역 필드

| 필드 | 내용 | 출처 |
|---|---|---|
| `id`, `type`, `single` | 통합구역 번호, 주택단지/시설 정비형, 단일 단지 여부 | 기본계획(안) 표4-48 |
| `cx`, `units`, `area`, `site`, `far`, `baseFar` | 단지 목록, 기존 세대, 예정구역 면적, 주택부지, 종전용적률, 기준용적률 | 표4-53, 표4-34 |
| `status` | `selected` 선도지구 · `applied` 1차 신청·미선정 · `none` 미신청 · `excluded` 1차 공모 제외 | 국토부·대전시 발표, 보도 |
| `dong` | 법정동(단지 과반 기준) | 서구 공동주택 현황 |
| `infra` | 기반시설 설치계획(도로 확폭·공원·자족시설, 면적) | 기본계획 4장·FAQ |
| `pub` | 공공기여 추정 `{area, landPrice, est}` (㎡, 백만 원/㎡, 백만 원) | 표6-9 |
| `pts[]` | 단지별 `name, units, osm, lat, lng, approved(사용승인일), bldgs(동수), floors(층수), far(용적률)` | 서구 공동주택 현황 2026.8, 표4-53, OSM |
| `rings[]` | 단지별 경계 좌표 `[[lat,lng],...]` (닫힌 고리) | OpenStreetMap |
| `approvedAvg`, `bldgs` | 평균 사용승인 연도(소수), 총 동수 | 계산값 |
| `notes`, `src` | 패널 메모, 출처 키 | — |

### 최상위 필드

- `phases[]`: 연차별 정비물량 `{year, units, cap}` — `cap`은 허용세대수 총량. 표6-7·6-8.
- `model`: 단계별 일정 모델 — 행정절차 1.5년, 사업시행 4년, 최초 이주 2028, 최초 입주 2031, 최종 이주 2037, 최종 입주 2040. 6장.
- `contrib`: 공공기여 비율(1구간 10%, 2구간 41%), 총 추정액, 기반시설 설치비 추정.
- `scoring`: 선도지구 평가 배점. FAQ·국토부 고시 제2024-559호.

## 점수 계산기의 가정

평가기준은 대전시 FAQ에 공개된 1차 공모 배점을 그대로 쓴다. 중간 구간은 다음과 같이 추정했다.

- 동의율: 50%→10점, 100%→70점 선형.
- 주차대수: 0.3대 이하 2.5점, 1.2대 이상 0점, 사이는 선형.
- 통합 단지 수: 1개 2점, 2개 3점, 3개 4점, 4개 이상 5점. 통합 세대수: 1,000 미만 2점, 1,000~2,000 3점, 2,000~3,000 4점, 3,000 이상 5점.
- 건축물 연령: 17개 구역 전체를 기준으로 상대평가(실제는 신청 구역끼리 비교).
- 복리시설 면적: 자료가 없어 사용자가 0~2.5점을 직접 지정.

2차 공모 평가기준이 공고되면 `scoring`과 계산 로직을 맞춘다.

## 행감 도우미 (audit.html)

- 약속 추적표의 상태·메모와 선택한 주제는 브라우저 localStorage에만 저장된다. 다른 기기와 공유하려면 "추적표 복사"로 탭 구분 텍스트를 스프레드시트에 붙여 넣는다.
- 업무보고 PDF 분석은 정규식 기반이다: 예산·집행·이월·불용 + 숫자가 있는 줄, "검토하겠·추진 예정·연내" 등 약속 표현, 노후계획도시 관련 키워드. 표 형태 PDF는 줄이 섞일 수 있으니 원문과 대조한다.
- AI 초안은 `https://api.anthropic.com/v1/messages`를 브라우저에서 직접 호출한다(`anthropic-dangerous-direct-browser-access` 헤더). 키는 localStorage에만 저장되며 이 사이트에는 서버가 없다. 비공개 자료는 넣지 않는다.
- 질의 주제·근거 문장은 `audit.html`의 `TOPICS`, 약속 목록은 `PROMISES` 배열에 있다. 행감 답변이 나오면 `PROMISES`에 결과를 반영하고 `TOPICS`의 근거를 갱신한다.

## 대덕대교 통행 모니터 (traffic.html)

트램 2호선 공사로 대덕대교 5차로가 통제되는 기간(2026.10.19~2029.5.12)의 소통 변화를 매일 기록하는 대시보드. 공공데이터포털 「대전광역시_대전교통정보 서비스」(15157924, 무료·자동승인)의 `getTrafficInfoAll`을 국내 머신의 cron이 10분마다 호출해 결과를 저장소에 커밋하고(git scraping), 페이지는 그 JSON만 읽는다. 브라우저 쪽에는 키가 없다.

| 파일 | 역할 |
|---|---|
| `traffic.html` | 대시보드. 방향별 요약(오늘 vs 기간 평균/통제 전), 일별 추이(하루 평균·출퇴근 피크·통행시간·혼잡 비율), 시간대 프로필, 일자×시간대 히트맵, 우회도로 표, 교통량, 실시간 링크값. 모든 차트에 표 보기. |
| `traffic/links.json` | 수집할 링크 규칙(교량 구간·방향·우회도로 정규식, 링크 ID 고정), 통제 정보. |
| `traffic/collect.mjs` | 수집·집계. `--discover`(링크 이름 확인), `--rebuild`(raw로 daily 재계산), `--from-file`(저장된 응답으로 테스트). |
| `traffic/tportal-fetch.js` | 대전교통 빅데이터 플랫폼에서 구간 속도·VDS 교통량 과거 자료를 내려받는 브라우저 콘솔 스크립트 → `tportal-export.json`. |
| `traffic/collect-tportal.mjs` | 교통정보센터 통계를 Node로 받아 `history.json`·`volume.json` 갱신 (`cron.sh tportal`). 해외 IP에서는 접속 불가. |
| `traffic/import-tportal.mjs` | `tportal-export.json` → `history.json`(구간별 1시간 속도) · `volume.json`(VDS 교통량) · `baseline.json`(통제 전 기준). collect-tportal이 같은 함수를 쓴다. |
| `traffic/import-volume.mjs` | 범용 CSV 변환기(엑셀 저장본 등). UTF-8/EUC-KR 자동, 열 이름 자동 인식. |
| `traffic/data/latest.json` | 마지막 수집값. `raw/YYYY-MM-DD.json` 하루치 표본(35일 보관). `daily.json` 일별·시간대별 집계(영구). `history.json`·`volume.json`·`baseline.json`은 교통정보센터 통계(수동 갱신). |
| `traffic/cron.sh` | **정기 수집 본체.** cron/launchd에서 `api`(10분)·`tportal`(매일) 모드로 pull→수집→push. POSIX sh. |
| `traffic/launchd.tportal.plist` | macOS launchd 작업 예시(tportal 매일 06:40). |
| `.github/workflows/traffic.yml` | 수동 실행 전용(discover 확인·임시 수집). 스케줄 없음. |

### 운영 방식 — 국내 머신 cron

tportal(교통정보센터)은 해외 IP뿐 아니라 **클라우드 IP(AWS 서울 리전 포함)도 막는다**(2026.10.22 확인: GitHub 러너·AWS ap-northeast-2 모두 connect timeout). 공공데이터포털 API(apis.data.go.kr)는 어디서든 된다. GitHub의 `schedule`은 지연·누락이 잦다. 그래서:

- `cron.sh api`(10분, 공공데이터포털): 국내든 해외든 아무 서버(AWS 등)의 cron.
- `cron.sh tportal`(매일, 교통정보센터): **집·사무실 네트워크(통신사 IP)의 Mac/PC**에서. macOS는 `traffic/launchd.tportal.plist`(잠자는 동안 놓친 실행을 깨어나면 돌림)를 쓴다. 상시 머신이 없으면 수동 경로(아래)를 한 달에 한 번.

두 작업이 다른 머신에서 같은 저장소에 push해도 `cron.sh`가 pull --rebase로 맞춘다. GitHub 워크플로는 수동 실행용으로만 남긴다.

```
# 한 번만
git clone git@github.com:pillip/KSW_DUNSAN.git && cd KSW_DUNSAN     # push 되는 계정으로
node -v                                                               # 20 이상
echo "DATA_GO_KR_KEY=공공데이터포털_인증키" > traffic/.env              # .gitignore 에 있음
sh traffic/cron.sh api        # 손으로 한 번 돌려 push 까지 되는지 확인
sh traffic/cron.sh tportal 30 # 교통정보센터 통계 30일치

# crontab -e  (sh 로 부르면 실행 권한이 없어도 된다)
*/10 * * * *  sh /절대경로/KSW_DUNSAN/traffic/cron.sh api     >> $HOME/ksw-cron.log 2>&1
40 6 * * *    sh /절대경로/KSW_DUNSAN/traffic/cron.sh tportal >> $HOME/ksw-cron.log 2>&1
```

- `cron.sh`는 pull → 수집 → 변경 있으면 commit·push. 겹침은 lock으로 막고, 실패하면 다음 회차에 자연히 복구된다. 로그 한 줄에 결과가 남는다.
- macOS면 잠자기 때 cron이 멈추므로 자동 잠자기를 끈다(`sudo pmset -a sleep 0`). 노트북보다는 상시 켜진 머신이 맞다.
- 머신이 며칠 꺼져 있으면 그 기간의 10분 자료는 비고(API는 실시간만 제공), 교통정보센터 통계는 `cron.sh tportal 30`으로 메꿀 수 있다 — 대시보드는 10분 자료가 없는 날을 그 1시간 평균으로 채운다.
- 공공데이터포털 인증키: 「대전광역시_대전교통정보 서비스」 활용신청(자동승인) → 마이페이지. Decoding·Encoding 어느 쪽을 넣어도 `collect.mjs`가 처리한다.
- 링크 확인: `DATA_GO_KR_KEY=... node traffic/collect.mjs --discover` → `traffic/data/discover.json`. 2026.10.22 확인 결과 교량 링크는 `1850012801`(대덕대교네거리→과학공원네거리, 연구단지 방향)·`1850012701`(반대, 둔산 방향), 각 412m. API는 갑천도시고속도로를 "천변도시고속화도로"로 부르고, 만년로는 링크 목록에 없다.

### 교통정보센터 통계 (교통량 · 통제 전 기준 · 과거 소통)

소통정보 API에는 차량 대수가 없고, 10분 수집도 통제 시작 뒤에 시작했다. 둘 다 대전교통 빅데이터 플랫폼(http://tportal.daejeon.go.kr/)의 통계에서 가져온다. 포털은 로그인·키 없이 쓰지만 공개 API가 아니라 화면이 쓰는 내부 API를 그대로 호출하므로, 사이트가 바뀌면 `collect-tportal.mjs`·`tportal-fetch.js`를 손봐야 한다.

- `cron.sh tportal`(= `node traffic/collect-tportal.mjs --days 7`)이 전날까지를 받아 `history.json`·`volume.json`을 갱신한다. 날짜별 덮어쓰기라 겹쳐 받아도 된다.
- 국내 머신이 없을 때의 수동 경로: tportal의 trafficvolume 페이지 콘솔에 `traffic/tportal-fetch.js`를 붙여 넣어 `tportal-export.json`을 받고 `node traffic/import-tportal.mjs tportal-export.json` → 커밋.
- **통제 전 기준**은 한 번 만들면 바뀌지 않는다(2026.10.22에 9/28~10/16 평일 14일, 한글날 제외로 계산). 기간을 바꾸려면 `node traffic/collect-tportal.mjs --from 2026-09-01 --baseline 2026-09-28~2026-10-16 --exclude 2026-10-09`.
- 구간 속도: 도로소통정보 > 구간별 통행속도(1시간). 대덕대로 상행(둔산→연구단지)·하행 중 `대덕대교네거리▶과학공원네거리`와 그 앞뒤 구간. 공공데이터포털 API와 같은 교통정보센터 링크 체계라 그대로 이어 붙일 수 있다. 대시보드는 10분 수집이 없는 날을 이 자료로 채우고(10분 수집이 있으면 그쪽 우선), 일별 표에 출처를 적는다.
- 교통량: 도로-교통량 > VDS(지점별, 1시간). 대덕대교 위에는 VDS가 없어 교량 바로 옆 만년동 쪽 **VDS0016**(상행, 만년네거리▶서구보건소네거리)·**VDS0015**(하행, 대덕대교네거리▶만년상아아파트)를 쓴다. 대전시 「트램구간 일간보고서」 5공구 값과 같은 지점이다. 대덕대교네거리에서 회전해 들어오는 차가 섞이므로 교량 통과량과 완전히 같지는 않다.
- 통제 전 기준: 기간의 평일(공휴일 제외)·주말을 따로 평균. 요약·일별·시간대 차트는 비교 대상을 "기간 평균"에서 "통제 전"으로 바꾸고, 주말 날짜는 주말 기준과 비교한다. 9/28~10/16 평일 14일: 둔산 방향 38.2 km/h(출근 27.3 / 퇴근 31.3), 연구단지 방향 32.2(출근 29.1 / 퇴근 21.4), 교통량 56,467 대/일.
- `import-volume.mjs`는 다른 CSV 형식(포털의 엑셀 저장본 등)을 넣을 때의 범용 변환기.

### 집계 규칙

- 교량 구간 = 도로명 대덕대로, 양쪽 노드가 모두 대덕대교·과학공원 노드인 링크. 방향은 endNodeName → udType 순으로 판정.
- 같은 시각의 링크들은 한 표본: 속도 평균, 통행시간은 합(교량만). 속도 0은 결측으로 버린다.
- 하루 평균·최저, 07–09시·17–19시 피크 평균, 혼잡 비율(소통등급 2·3 표본 비율), 시간대별 속도·통행시간·혼잡.
- 오늘이 아직 진행 중이면 요약·우회도로 표의 비교는 같은 시간대(0시~마지막 시)끼리 한다. 피크는 그 시간대가 끝나야 값이 나온다.
- 우회도로는 도로명이 같은 링크 전부의 평균(양방향), 통행시간은 계산하지 않는다.

## 구역 링크

구역을 선택하면 주소창이 `#z13`처럼 바뀌고, 구역 상세의 "이 구역 링크 복사"로 복사한 링크를 열면 그 구역이 바로 선택된다.

## 출처

- 대전광역시 「2035 대전 노후계획도시정비 기본계획(안)」 둔산지구 주민공람본(2025.11): 3장 현황(표3-26), 4장 기본방향(표4-34·4-48·4-53), 6장 계획의 실행(표6-6~6-9). https://www.daejeon.go.kr/urb/UrbNormalboardView.do?gubun=&boardId=normal_0020&ntatcSeq=1503184548&menuSeq=1110
- 대전광역시 「노후계획도시정비 FAQ」(2026.1): 선도지구 평가기준, 동의율 산정, 공공기여, 구역별 기반시설 설치계획.
- 대전광역시 서구 「공동주택 현황」(2026.8.13, 공공데이터포털 15104512): 사용승인일, 동수, 층수.
- 국토교통부·대전시 보도자료, 중도일보·하우징헤럴드·위클리한국주택경제·한국경제·TJB·뉴시스 보도(2025.11~2026.10).
- 단지 경계 © OpenStreetMap contributors (ODbL). 위성영상 © Esri, Maxar, Earthstar Geographics.

공람안은 확정 전 문서라 2026.8 고시본과 수치가 다를 수 있다. 공공기여 추정액은 기본계획이 "이해를 돕기 위한 예시"로 제시한 값이다.
