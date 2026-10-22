#!/usr/bin/env bash
# 국내 PC·서버에서 cron 으로 돌리는 수집 스크립트 (GitHub 스케줄 대신).
#
#   traffic/cron.sh api       10분 수집 — 공공데이터포털 API → traffic/data/{latest,daily,raw}
#   traffic/cron.sh tportal   교통정보센터 통계 — tportal → traffic/data/{history,volume}  (하루 1번, 최근 7일)
#   traffic/cron.sh tportal 30            # 30일치
#
# 준비 (한 번)
#   1. 이 저장소를 clone 하고 push 가 되는지 확인 (SSH 키 또는 git credential helper).
#   2. Node 20 이상. `node -v`
#   3. traffic/.env 파일에 한 줄:  DATA_GO_KR_KEY=인증키   (Decoding·Encoding 어느 쪽이든 됨, .gitignore 에 올라가 있음)
#   4. crontab -e   (GitHub 웹으로 올린 파일은 실행 권한이 빠지므로 sh 로 부른다)
#        */10 * * * *  sh /절대경로/KSW_DUNSAN/traffic/cron.sh api     >> $HOME/ksw-cron.log 2>&1
#        40 6 * * *    sh /절대경로/KSW_DUNSAN/traffic/cron.sh tportal >> $HOME/ksw-cron.log 2>&1
#      macOS 는 잠자기에 들어가면 cron 이 안 돌므로 시스템 설정 → 배터리/에너지 → 자동 잠자기 방지, 또는 `sudo pmset -a sleep 0`.
#   5. GitHub 쪽 .github/workflows/traffic.yml 의 schedule 블록은 지운다 (이중 수집·push 충돌 방지). traffic-tportal.yml 은 삭제.
#
# 겹침 방지(lock)·로그·실패해도 다음 회차에 자동 복구. 같은 분에 두 번 돌아도 collect.mjs 가 덮어쓴다.
# sh 로 실행돼도(실행 권한이 없거나 `sh cron.sh` 로 불렀을 때) 동작하도록 POSIX sh 문법만 쓴다.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/current/bin:$HOME/.volta/bin:$PATH"
MODE="${1:-api}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
NOW="$(TZ=Asia/Seoul date '+%Y-%m-%d %H:%M')"
 
# lock (macOS 에 flock 이 없어 mkdir 로)
LOCK="$REPO/traffic/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  # 20분 넘게 남아 있는 lock 은 죽은 프로세스의 것으로 보고 치운다
  if [ -n "$(find "$LOCK" -mmin +20 2>/dev/null)" ]; then rmdir "$LOCK" && mkdir "$LOCK" || exit 0; else echo "$NOW [$MODE] 이전 실행이 아직 진행 중 — 건너뜀"; exit 0; fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
 
[ -f "$REPO/traffic/.env" ] && set -a && . "$REPO/traffic/.env" && set +a
 
git pull --rebase --autostash -q || { echo "$NOW [$MODE] git pull 실패 (원격 연결·충돌 확인)"; exit 1; }
 
case "$MODE" in
  api)
    if [ -z "${DATA_GO_KR_KEY:-}" ]; then echo "$NOW [api] traffic/.env 에 DATA_GO_KR_KEY 가 없습니다"; exit 2; fi
    node traffic/collect.mjs ${COLLECT_ARGS:-} || { echo "$NOW [api] 수집 실패"; exit 1; }
    MSG="traffic: $NOW 수집 [skip ci]" ;;
  tportal)
    node traffic/collect-tportal.mjs --days "${2:-7}" || { echo "$NOW [tportal] 수집 실패"; exit 1; }
    MSG="traffic: ${NOW%% *} 교통정보센터 통계 [skip ci]" ;;
  *) echo "사용법: cron.sh api | tportal [일수]"; exit 2 ;;
esac
 
git add traffic/data
if git diff --cached --quiet; then echo "$NOW [$MODE] 변경 없음"; exit 0; fi
git -c user.name="traffic-bot" -c user.email="actions@users.noreply.github.com" commit -q -m "$MSG"
for i in 1 2 3; do
  git push -q && { echo "$NOW [$MODE] push 완료"; exit 0; }
  git pull --rebase --autostash -q -X theirs || true
done
echo "$NOW [$MODE] push 실패 (다음 회차에 다시 시도)"
exit 1
