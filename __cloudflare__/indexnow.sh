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
#        ./indexnow.sh --performer tis-tales 'Jane Doe'     pages built from keys, like ./updatecache:
#        ./indexnow.sh --venue v1 v2 --event some-event-id    --performer --venue --promoter --festival
#        ./indexnow.sh --repertoire debs-newbold-dauntless    --storyclub --booksmerch --event --repertoire
#        ./indexnow.sh --performer a b --page about.html      keys follow a switch until the next switch;
#                                                             --page (or --url) goes back to plain pages/URLs
#        (a key containing % is taken as already URL-encoded; --repertoire needs jq and reads the events JSON)
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
  echo "Usage: $0 [-n] [-f listfile|-] [page|url ...] [--performer|--venue|--promoter|--festival|--storyclub|--booksmerch|--event|--repertoire key ...]" >&2
  exit 1
}

# Percent-encode a key like jq's @uri (a key that already contains % is left alone).
# Runs in a subshell with LC_ALL=C so multi-byte characters are encoded byte by byte (bash 3.2 safe).
urlenc() (
  LC_ALL=C
  s="$1"
  case "$s" in *%*) printf '%s' "$s"; exit 0 ;; esac
  out=""
  i=0
  while [ "$i" -lt "${#s}" ]; do
    c="${s:$i:1}"
    case "$c" in
      [A-Za-z0-9._~-]) out="$out$c" ;;
      *) out="$out$(printf '%%%02X' "'$c")" ;;
    esac
    i=$((i + 1))
  done
  printf '%s' "$out"
)

# Repertoire pages are tour_guide.html?performer=<performer>&tour=R-<show>; the performer is the
# longest performer id that is a prefix of the show id, so the events JSON is needed.
REP_JSON=""
load_rep_json() {   # runs in the main shell (not in $(...)) so the download happens once
  local name
  [ -z "$REP_JSON" ] || return 0
  command -v jq >/dev/null || { echo "--repertoire needs jq" >&2; return 1; }
  REP_JSON=$(mktemp "${TMPDIR:-/tmp}/indexnow-json.XXXXXX")
  trap 'rm -f "$REP_JSON"' EXIT
  for name in events_normalized events_normalised; do
    curl -sf --max-time 60 -o "$REP_JSON" "${NT_EVENTS_JSON:-https://$HOST/$name.json}" && break
    : > "$REP_JSON"
  done
  [ -s "$REP_JSON" ] || { echo "Could not load the events JSON (set NT_EVENTS_JSON?)" >&2; return 1; }
}
repertoire_page() {
  local show="$1" perf
  show="${show#R-}"; show="${show#rep:}"
  perf=$(jq -r --arg k "$show" '
    if ((.repertoire_shows // {}) | has($k)) then
      (.performers | keys) as $p
      | ([$p[] | . as $x | select($k | startswith($x + "-"))] | sort_by(length) | last) // empty
    else empty end' "$REP_JSON" 2>/dev/null)
  [ -n "$perf" ] || { echo "Skipping repertoire '$show': not a known show, or no matching performer." >&2; return 1; }
  printf 'tour_guide.html?performer=%s&tour=R-%s' "$(urlenc "$perf")" "$(urlenc "$show")"
}

# Page path for a typed key (same pages/params as ./updatecache)
typed_page() {
  local type="$1" key="$2"
  case "$type" in
    performer)  printf 'performers.html?performer=%s' "$(urlenc "$key")" ;;
    venue)      printf 'venues.html?venue=%s' "$(urlenc "$key")" ;;
    promoter)   printf 'promoters.html?promoter=%s' "$(urlenc "$key")" ;;
    festival)   printf 'festival.html?festival=%s' "$(urlenc "$key")" ;;
    storyclub)  printf 'storyclub.html?club=%s' "$(urlenc "$key")" ;;
    booksmerch) printf 'books_merch.html?performer=%s' "$(urlenc "$key")" ;;
    event)      printf 'event.html?event=%s' "$(urlenc "$key")" ;;
    repertoire) repertoire_page "$key" ;;
  esac
}

DRY=0
TYPE=""     # current key type set by --performer etc.; empty = plain pages/URLs
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
    --performer|--performers)  TYPE=performer;  shift ;;
    --venue|--venues)          TYPE=venue;      shift ;;
    --promoter|--promoters)    TYPE=promoter;   shift ;;
    --festival|--festivals)    TYPE=festival;   shift ;;
    --storyclub|--storyclubs)  TYPE=storyclub;  shift ;;
    --booksmerch)              TYPE=booksmerch; shift ;;
    --event|--events)          TYPE=event;      shift ;;
    --repertoire|--repertoires) TYPE=repertoire; shift ;;
    --page|--pages|--url|--urls) TYPE=""; shift ;;
    *)
      if [ "$TYPE" = repertoire ]; then
        load_rep_json || { shift; continue; }
      fi
      if [ -n "$TYPE" ]; then
        page=$(typed_page "$TYPE" "$1") && [ -n "$page" ] && INPUTS+=("$page")
      else
        INPUTS+=("$1")
      fi
      shift ;;
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
