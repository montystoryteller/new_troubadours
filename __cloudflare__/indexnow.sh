#!/bin/bash
# indexnow.sh - notify IndexNow that page(s) on newtroubadours.org changed
# Usage: ./indexnow.sh mypage.html
#        ./indexnow.sh 'mypage.html?myarg=whatever' other.html
#        ./indexnow.sh https://newtroubadours.org/mypage.html
#        ./indexnow.sh -f refreshed.txt              submit every URL listed in a file
#        ./indexnow.sh -f refreshed.txt other.html   files and arguments can be mixed
#        ./indexnow.sh -f -                          read the list from stdin, e.g.
#                                                    ./updatecache --list-recent 12 | ./indexnow.sh -f -
#
# List files: one page or URL per line. Blank lines and lines starting with # are ignored,
# Windows line endings are fine, duplicates are dropped, and URLs on other hosts are skipped
# (IndexNow only accepts URLs on the host that owns the key). Long lists are sent in batches
# of NT_BATCH URLs (default 1000; IndexNow's limit is 10,000 per request).
# Use -n / --dry-run to see what would be sent without sending it.

HOST="newtroubadours.org"
KEY="a3763432621d411d8c8767d786f84edf"   # 8-128 chars: a-z, A-Z, 0-9, dashes
KEY_LOCATION="https://$HOST/$KEY.txt"
BATCH="${NT_BATCH:-1000}"

usage() {
  echo "Usage: $0 [-n] [-f listfile|-] [page|url ...]" >&2
  exit 1
}

DRY=0
INPUTS=()   # raw pages/URLs, in order

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY=1; shift ;;
    -f|--file)
      [ -n "${2:-}" ] || usage
      if [ "$2" = "-" ]; then
        src="/dev/stdin"
      else
        src="$2"
        [ -r "$src" ] || { echo "Cannot read list file: $src" >&2; exit 1; }
      fi
      while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"                       # strip CR (Windows line endings)
        line="${line#"${line%%[![:space:]]*}"}"    # trim leading whitespace
        line="${line%"${line##*[![:space:]]}"}"    # trim trailing whitespace
        [ -z "$line" ] && continue
        [[ "$line" == \#* ]] && continue
        INPUTS+=("$line")
      done < "$src"
      shift 2 ;;
    -h|--help) usage ;;
    *) INPUTS+=("$1"); shift ;;
  esac
done

[ ${#INPUTS[@]} -gt 0 ] || usage

# Normalise to full URLs and keep only this host (plain arrays only: macOS ships bash 3.2)
CANDIDATES=()
skipped=0
for page in "${INPUTS[@]}"; do
  # If it's already a full URL, use it unchanged
  if [[ "$page" =~ ^https?:// ]]; then
    url="$page"
  else
    page="${page#./}"   # strip leading ./
    page="${page#/}"    # strip leading /
    url="https://$HOST/$page"
  fi

  case "$url" in
    "https://$HOST"|"https://$HOST/"*|"http://$HOST"|"http://$HOST/"*) CANDIDATES+=("$url") ;;
    *) echo "Skipping (not on $HOST): $url" >&2; skipped=$((skipped + 1)) ;;
  esac
done

# Drop duplicates, keeping the first occurrence (order preserved)
URLLIST=()
if [ ${#CANDIDATES[@]} -gt 0 ]; then
  while IFS= read -r url; do
    URLLIST+=("$url")
  done < <(printf '%s\n' "${CANDIDATES[@]}" | awk '!seen[$0]++')
fi

total=${#URLLIST[@]}
[ "$total" -gt 0 ] || { echo "No valid URLs to submit." >&2; exit 1; }

# JSON-escape a string (backslash and double quote)
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

note=""; [ "$skipped" -gt 0 ] && note=" ($skipped skipped)"
echo "$total URL(s) to submit$note, in batches of $BATCH."

fail=0
batch_no=0
for (( i = 0; i < total; i += BATCH )); do
  batch_no=$((batch_no + 1))
  URLS=""
  for url in "${URLLIST[@]:i:BATCH}"; do
    URLS+="\"$(json_escape "$url")\","
  done
  URLS="${URLS%,}"      # drop trailing comma
  count=$(( total - i < BATCH ? total - i : BATCH ))

  PAYLOAD=$(cat <<EOP
{
  "host": "$HOST",
  "key": "$KEY",
  "keyLocation": "$KEY_LOCATION",
  "urlList": [$URLS]
}
EOP
)

  echo
  echo "Batch $batch_no: $count URL(s)"
  if [ $DRY -eq 1 ]; then
    if [ "$total" -le 20 ]; then echo "$PAYLOAD"; else printf '%s\n' "${URLLIST[@]:i:BATCH}" | head -n 5; echo "  ... ($count total)"; fi
    continue
  fi

  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "https://api.indexnow.org/IndexNow" \
    -H "Content-Type: application/json; charset=utf-8" \
    -d "$PAYLOAD")
  echo "HTTP status: $code"
  case "$code" in
    200|202) ;;
    *) fail=1 ;;
  esac
  [ $((i + BATCH)) -lt "$total" ] && sleep 1
done

[ $DRY -eq 1 ] && echo && echo "(dry run: nothing was sent)"
[ $fail -eq 0 ] || { echo "Some batches were not accepted (200/202 = ok; 400 bad request, 403 key not found, 422 URL/host mismatch, 429 too many requests)." >&2; exit 1; }
exit 0
