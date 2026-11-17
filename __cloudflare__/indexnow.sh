#!/bin/bash
# indexnow.sh - notify IndexNow that pages on newtroubadours.org changed
#
# Usage:
#   ./indexnow.sh mypage.html
#   ./indexnow.sh -f refreshed.txt
#   ./indexnow.sh -s https://newtroubadours.org/sitemap.xml
#   ./indexnow.sh -n -s https://newtroubadours.org/sitemap.xml
#   ./indexnow.sh -s sitemap.xml -f refreshed.txt about.html
#
# Sitemap support:
#   -s / --sitemap accepts a sitemap URL or local XML file.
#   Sitemap indexes are recursively expanded.
#   Gzipped sitemaps are supported.
#   XML namespaces are supported.
#
# Other existing features:
#   -f / --file reads URLs from a file or stdin.
#   --performer, --venue, --promoter, --festival
#   --storyclub, --booksmerch, --event, --repertoire
#   -n / --dry-run
#
# URLs are deduplicated and restricted to HOST.
# Requests are sent in batches of NT_BATCH (default 1000).
# IndexNow maximum: 10,000 URLs per request.

HOST="newtroubadours.org"
KEY="a3763432621d411d8c8767d786f84edf"
KEY_LOCATION="https://$HOST/$KEY.txt"
BATCH="${NT_BATCH:-1000}"

usage() {
  echo "Usage: $0 [-n] [-f file|-] [-s sitemap.xml] [page|url ...] [typed keys ...]" >&2
  exit 1
}

# Validate batch size
[[ "$BATCH" =~ ^[0-9]+$ ]] && [ "$BATCH" -ge 1 ] && [ "$BATCH" -le 10000 ] || {
  echo "NT_BATCH must be between 1 and 10000" >&2
  exit 1
}

# Percent-encode a key
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

REP_JSON=""

load_rep_json() {
  local name
  [ -z "$REP_JSON" ] || return 0
  command -v jq >/dev/null || {
    echo "--repertoire needs jq" >&2
    return 1
  }

  REP_JSON=$(mktemp "${TMPDIR:-/tmp}/indexnow-json.XXXXXX")

  for name in events_normalized events_normalised; do
    curl -sf --max-time 60 -o "$REP_JSON" \
      "${NT_EVENTS_JSON:-https://$HOST/$name.json}" && break
    : > "$REP_JSON"
  done

  [ -s "$REP_JSON" ] || {
    echo "Could not load events JSON (set NT_EVENTS_JSON?)" >&2
    return 1
  }
}

repertoire_page() {
  local show="$1" perf
  show="${show#R-}"
  show="${show#rep:}"

  perf=$(jq -r --arg k "$show" '
    if ((.repertoire_shows // {}) | has($k)) then
      (.performers | keys) as $p
      | ([$p[] | . as $x | select($k | startswith($x + "-"))]
         | sort_by(length) | last) // empty
    else empty end' "$REP_JSON" 2>/dev/null)

  [ -n "$perf" ] || {
    echo "Skipping repertoire '$show': unknown show or performer." >&2
    return 1
  }

  printf 'tour_guide.html?performer=%s&tour=R-%s' \
    "$(urlenc "$perf")" "$(urlenc "$show")"
}

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
TYPE=""
INPUTS=()
SITEMAPS=()

# ------------------------------------------------------------
# Argument parsing
# ------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in

    -n|--dry-run)
      DRY=1
      shift
      ;;

    -f|--file)
      [ -n "${2:-}" ] || usage

      if [ "$2" = "-" ]; then
        src="/dev/stdin"
      else
        src="$2"
        [ -r "$src" ] || {
          echo "Cannot read list file: $src" >&2
          exit 1
        }
      fi

      while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        line="${line#"${line%%[![:space:]]*}"}"
        line="${line%"${line##*[![:space:]]}"}"

        [ -z "$line" ] && continue
        [[ "$line" == \#* ]] && continue

        INPUTS+=("$line")
      done < "$src"

      shift 2
      ;;

    -s|--sitemap)
      [ -n "${2:-}" ] || usage
      SITEMAPS+=("$2")
      shift 2
      ;;

    -h|--help)
      usage
      ;;

    --performer|--performers)
      TYPE=performer
      shift
      ;;

    --venue|--venues)
      TYPE=venue
      shift
      ;;

    --promoter|--promoters)
      TYPE=promoter
      shift
      ;;

    --festival|--festivals)
      TYPE=festival
      shift
      ;;

    --storyclub|--storyclubs)
      TYPE=storyclub
      shift
      ;;

    --booksmerch)
      TYPE=booksmerch
      shift
      ;;

    --event|--events)
      TYPE=event
      shift
      ;;

    --repertoire|--repertoires)
      TYPE=repertoire
      shift
      ;;

    --page|--pages|--url|--urls)
      TYPE=""
      shift
      ;;

    *)
      if [ "$TYPE" = repertoire ]; then
        load_rep_json || {
          shift
          continue
        }
      fi

      if [ -n "$TYPE" ]; then
        page=$(typed_page "$TYPE" "$1") &&
          [ -n "$page" ] && INPUTS+=("$page")
      else
        INPUTS+=("$1")
      fi

      shift
      ;;
  esac
done

# ------------------------------------------------------------
# Sitemap processing
# ------------------------------------------------------------

if [ ${#SITEMAPS[@]} -gt 0 ]; then

  command -v python3 >/dev/null || {
    echo "Sitemap support requires python3." >&2
    exit 1
  }

  SITEMAP_TMP=$(mktemp "${TMPDIR:-/tmp}/indexnow-sitemap.XXXXXX")

  for sitemap in "${SITEMAPS[@]}"; do

    echo
    echo "Reading sitemap: $sitemap"

    python3 - "$sitemap" > "$SITEMAP_TMP" <<'PYTHON'
import sys
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
import gzip
import os

seen = set()

def read_source(source):
    if source.startswith(("http://", "https://")):
        request = urllib.request.Request(
            source,
            headers={"User-Agent": "IndexNow-Sitemap-Submitter/1.0"}
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read()
        base = source
    else:
        with open(source, "rb") as f:
            data = f.read()
        base = os.path.abspath(source)

    if data.startswith(b"\x1f\x8b") or source.endswith(".gz"):
        data = gzip.decompress(data)

    return data, base

def local_name(tag):
    return tag.rsplit("}", 1)[-1].lower()

def get_locs(element):
    for child in element:
        if local_name(child.tag) == "loc" and child.text:
            yield child.text.strip()

def process_sitemap(source):
    if source in seen:
        return

    seen.add(source)

    try:
        data, base = read_source(source)
        root = ET.fromstring(data)
    except Exception as e:
        print(
            f"Error reading sitemap {source}: {e}",
            file=sys.stderr
        )
        raise

    root_type = local_name(root.tag)

    if root_type == "sitemapindex":
        for sitemap in root:
            if local_name(sitemap.tag) == "sitemap":
                for loc in get_locs(sitemap):
                    if loc:
                        child_url = urllib.parse.urljoin(base, loc)
                        process_sitemap(child_url)

    elif root_type == "urlset":
        for url in root:
            if local_name(url.tag) == "url":
                for loc in get_locs(url):
                    if loc:
                        print(loc)

    else:
        print(
            f"Unrecognised sitemap root: {root_type} ({source})",
            file=sys.stderr
        )
        raise SystemExit(1)

process_sitemap(sys.argv[1])
PYTHON

    result=$?

    if [ "$result" -ne 0 ]; then
      rm -f "$SITEMAP_TMP"
      echo "Sitemap processing failed: $sitemap" >&2
      exit 1
    fi

    while IFS= read -r url; do
      [ -n "$url" ] && INPUTS+=("$url")
    done < "$SITEMAP_TMP"

  done

  rm -f "$SITEMAP_TMP"
fi

[ ${#INPUTS[@]} -gt 0 ] || usage

# ------------------------------------------------------------
# Normalise URLs and restrict to HOST
# ------------------------------------------------------------

CANDIDATES=()
skipped=0

for page in "${INPUTS[@]}"; do

  if [[ "$page" =~ ^https?:// ]]; then
    url="$page"
  else
    page="${page#./}"
    page="${page#/}"
    url="https://$HOST/$page"
  fi

  case "$url" in
    "https://$HOST"|"https://$HOST/"*|"http://$HOST"|"http://$HOST/"*)
      CANDIDATES+=("$url")
      ;;
    *)
      echo "Skipping (not on $HOST): $url" >&2
      skipped=$((skipped + 1))
      ;;
  esac
done

# ------------------------------------------------------------
# Remove duplicates, preserving order
# ------------------------------------------------------------

URLLIST=()

if [ ${#CANDIDATES[@]} -gt 0 ]; then
  while IFS= read -r url; do
    URLLIST+=("$url")
  done < <(printf '%s\n' "${CANDIDATES[@]}" | awk '!seen[$0]++')
fi

total=${#URLLIST[@]}

[ "$total" -gt 0 ] || {
  echo "No valid URLs to submit." >&2
  exit 1
}

note=""
[ "$skipped" -gt 0 ] && note=" ($skipped skipped)"

echo
echo "$total URL(s) to submit$note, in batches of $BATCH."

# ------------------------------------------------------------
# JSON escaping
# ------------------------------------------------------------

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

# ------------------------------------------------------------
# Submit to IndexNow
# ------------------------------------------------------------

fail=0
batch_no=0

for (( i = 0; i < total; i += BATCH )); do

  batch_no=$((batch_no + 1))
  URLS=""

  for url in "${URLLIST[@]:i:BATCH}"; do
    URLS+="\"$(json_escape "$url")\","
  done

  URLS="${URLS%,}"

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

  if [ "$DRY" -eq 1 ]; then
    if [ "$total" -le 20 ]; then
      echo "$PAYLOAD"
    else
      printf '%s\n' "${URLLIST[@]:i:BATCH}" | head -n 5
      echo "  ... ($count total)"
    fi
    continue
  fi

  code=$(curl -s --max-time 60 \
    -o /dev/null \
    -w "%{http_code}" \
    -X POST "https://api.indexnow.org/IndexNow" \
    -H "Content-Type: application/json; charset=utf-8" \
    -d "$PAYLOAD")

  echo "HTTP status: $code"

  case "$code" in
    200|202) ;;
    *)
      fail=1
      echo "Batch $batch_no failed." >&2
      ;;
  esac

  [ $((i + BATCH)) -lt "$total" ] && sleep 1

done

# ------------------------------------------------------------
# Finish
# ------------------------------------------------------------

if [ "$DRY" -eq 1 ]; then
  echo
  echo "(dry run: nothing was sent)"
fi

if [ "$fail" -ne 0 ]; then
  echo "Some batches were not accepted." >&2
  echo "200/202 = accepted; 400 = bad request; 403 = key not found;" >&2
  echo "422 = URL/host mismatch; 429 = too many requests." >&2
  exit 1
fi

echo
echo "Finished: $total URL(s) processed."

exit 0
