# export GSC_KEY_JSON="$(cat newtroubdaours-search-console-7c543ca725dd.json)"
# uv run --with google-api-python-client --with google-auth googsearch.py
import json, os, datetime as dt
from google.oauth2 import service_account
from googleapiclient.discovery import build

SITE = "sc-domain:newtroubadours.org"  # or "https://newtroubadours.org/"
DAYS = 90  # Search Console keeps about 16 months

creds = service_account.Credentials.from_service_account_info(
    json.loads(os.environ["GSC_KEY_JSON"]),
    scopes=["https://www.googleapis.com/auth/webmasters.readonly"],
)
svc = build("searchconsole", "v1", credentials=creds)

end = dt.date.today() - dt.timedelta(days=3)  # data lags 1-3 days
start = end - dt.timedelta(days=DAYS)

REPORTS = {
    "daily": ["date"],
    "pages": ["page"],
    "page_daily": ["page", "date"],
    "page_query": ["page", "query"],
    "query_daily": ["query", "date"],
    "countries": ["country"],
    "devices": ["device"],
    "appearance": ["searchAppearance"],
}


def pull(dims):
    out, start_row = [], 0
    while True:
        resp = (
            svc.searchanalytics()
            .query(
                siteUrl=SITE,
                body={
                    "startDate": start.isoformat(),
                    "endDate": end.isoformat(),
                    "dimensions": dims,
                    "rowLimit": 25000,
                    "startRow": start_row,
                },
            )
            .execute()
        )
        batch = resp.get("rows", [])
        for r in batch:
            row = dict(zip(dims, r["keys"]))
            row.update(
                clicks=r["clicks"],
                impressions=r["impressions"],
                ctr=r["ctr"],
                position=r["position"],
            )
            out.append(row)
        if len(batch) < 25000:
            return out
        start_row += 25000


result = {"range": {"start": start.isoformat(), "end": end.isoformat()}, "reports": {}}
for name, dims in REPORTS.items():
    result["reports"][name] = pull(dims)
    print(f"{name}: {len(result['reports'][name])} rows")

json.dump(result, open("gsc_all.json", "w"))
