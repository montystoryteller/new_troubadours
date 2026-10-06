#!/bin/bash
# indexnow.sh - notify IndexNow that page(s) on newtroubadours.org changed
# Usage: ./indexnow.sh mypage.html
#        ./indexnow.sh 'mypage.html?myarg=whatever' other.html
#        ./indexnow.sh https://newtroubadours.org/mypage.html

HOST="newtroubadours.org"
KEY="a3763432621d411d8c8767d786f84edf"   # 8-128 chars: a-z, A-Z, 0-9, dashes
KEY_LOCATION="https://$HOST/$KEY.txt"

if [ $# -eq 0 ]; then
  echo "Usage: $0 <page|url> [page|url ...]" >&2
  exit 1
fi

# Build the JSON urlList
URLS=""

for page in "$@"; do
  # If it's already a full URL, use it unchanged
  if [[ "$page" =~ ^https?:// ]]; then
    url="$page"
  else
    page="${page#./}"   # strip leading ./
    page="${page#/}"    # strip leading /
    url="https://$HOST/$page"
  fi

  URLS+="\"$url\","
done

URLS="${URLS%,}"      # drop trailing comma

PAYLOAD=$(cat <<EOF
{
  "host": "$HOST",
  "key": "$KEY",
  "keyLocation": "$KEY_LOCATION",
  "urlList": [$URLS]
}
EOF
)

echo "Submitting:"
echo "$PAYLOAD"
echo

curl -s -o /dev/null -w "HTTP status: %{http_code}\n" \
  -X POST "https://api.indexnow.org/IndexNow" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "$PAYLOAD"
