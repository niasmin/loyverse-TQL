#!/usr/bin/env bash
# Builds the sales report PDF for a date range and sends it to LINE.
# Defaults to last calendar month in Bangkok time. Prints no sales figures,
# since workflow logs of a public repository are public.
#
# Env: SUPABASE_URL (https://<project-ref>.supabase.co), SYNC_KEY (loyverse.sync_state.sync_key).
# Args: [START END] as YYYY-MM-DD.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="${RUNNER_TEMP:-$(mktemp -d)}/sales-report"
mkdir -p "$WORK"
: "${SUPABASE_URL:?SUPABASE_URL is not set}"
: "${SYNC_KEY:?SYNC_KEY is not set}"
BASE="${SUPABASE_URL%/}/functions/v1"

month_start=$(TZ=Asia/Bangkok date +%Y-%m-01)
START="${1:-}"; END="${2:-}"
if [[ -z "$START" || -z "$END" ]]; then
  START=$(date -d "$month_start -1 month" +%F)
  END=$(date -d "$month_start -1 day" +%F)
fi
# the period of the same length just before, for comparison
days=$(( ($(date -d "$END" +%s) - $(date -d "$START" +%s)) / 86400 + 1 ))
PREV_END=$(date -d "$START -1 day" +%F)
PREV_START=$(date -d "$START -$days day" +%F)
echo "Report $START to $END (compare $PREV_START to $PREV_END)"

fetch() {
  curl -fsS -H "x-sync-key: $SYNC_KEY" "$BASE/report-data?start=$1&end=$2" -o "$3"
}
fetch "$START" "$END" "$WORK/data.json"
fetch "$PREV_START" "$PREV_END" "$WORK/prev.json"

TITLE=$(python3 "$DIR/build.py" "$WORK/data.json" "$WORK/report.html" "$WORK/prev.json")
NAME="tranquila-sales-$START-to-$END"
node "$DIR/pdf.js" "$WORK/report.html" "$WORK/$NAME.pdf"
pdftoppm -r 150 -jpeg -jpegopt quality=85 "$WORK/$NAME.pdf" "$WORK/page"
pdftoppm -r 60 -jpeg -jpegopt quality=75 "$WORK/$NAME.pdf" "$WORK/preview"

args=(-F "title=$TITLE" -F "pdf=@$WORK/$NAME.pdf;type=application/pdf")
for f in "$WORK"/page-*.jpg; do args+=(-F "page=@$f;type=image/jpeg"); done
for f in "$WORK"/preview-*.jpg; do args+=(-F "preview=@$f;type=image/jpeg"); done
curl -fsS -X POST -H "x-sync-key: $SYNC_KEY" "${args[@]}" "$BASE/line-send-report"
echo
