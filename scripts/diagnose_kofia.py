"""Inspect public KOFIA category fields without logging keys or raw responses."""

import json
import os
import re
from datetime import date, datetime, timedelta
from urllib.parse import unquote

from collect import KOFIA_URL, SourceClient, package_json
from data_pipeline import KST, ROOT, CollectionError, finite_number


OPERATIONS = {
    "getCMAStatus": ("mngInvTgt", "invrCtg"),
    "getFundTotalNetEssetInfo": ("ctg", "tstMthdCtg"),
}
PUBLIC_AMOUNTS = {"scrtCmpyCnt", "actCnt", "actBal", "nPptTotAmt"}


def load_rows(client, operation, token, date_filters, request_name):
    result = package_json(client.get(
        f"{operation}-{request_name}",
        f"{KOFIA_URL}/{operation}",
        {"serviceKey": token, "numOfRows": 200, "pageNo": 1, "resultType": "json", **date_filters},
    ))["response"]
    if str(result["header"]["resultCode"]) not in {"0", "00"}:
        raise CollectionError("upstream_error", "공공데이터포털 조회 실패")
    body = result["body"]
    count = int(body["totalCount"])
    if not count:
        return count, []
    rows = body["items"]["item"]
    if isinstance(rows, dict):
        rows = [rows]
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise CollectionError("invalid_response", "공공데이터포털 응답 형식 오류")
    return count, rows


def public_label(value, token):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if token in value or not re.fullmatch(r"[0-9A-Za-z가-힣ㄱ-ㅎ &+./()_-]{1,40}", value):
        return None
    return value


def summarize(operation, request_name, total, rows, start, end, token):
    fields = OPERATIONS[operation]
    keys = set()
    categories = {field: set() for field in fields}
    public_rows = []
    for row in rows:
        keys.update(
            key for key in row if re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]{0,39}", key)
            and not re.search(r"secret|password|token|login|email|key", key, re.I)
            and token not in key
        )
        try:
            observed = date.fromisoformat(row.get("basDt"))
        except (TypeError, ValueError):
            continue
        if not start <= observed <= end:
            continue
        summary = {"basDt": observed.isoformat()}
        for field in fields:
            label = public_label(row.get(field), token)
            if label:
                categories[field].add(label)
                summary[field] = label
        for field in sorted(PUBLIC_AMOUNTS & row.keys()):
            value = finite_number(row[field])
            if value is not None:
                summary[field] = value
        public_rows.append(summary)
    public_rows.sort(key=lambda row: row["basDt"], reverse=True)
    return {
        "operation": operation,
        "request": request_name,
        "totalCount": total,
        "windowRows": len(public_rows),
        "keys": sorted(keys),
        "categories": {field: sorted(values)[:30] for field, values in categories.items()},
        "sample": public_rows[:2],
    }


def probe(client, operation, token, start, end):
    params = {
        "beginBasDt": start.strftime("%Y%m%d"),
        "endBasDt": (end + timedelta(days=1)).strftime("%Y%m%d"),
    }
    total, rows = load_rows(client, operation, token, params, "range")
    summary = summarize(operation, "range", total, rows, start, end, token)
    print(json.dumps(summary, ensure_ascii=False))
    if summary["windowRows"]:
        return
    # An exact KST date distinguishes a range filter mismatch from absence of data.
    latest = end - timedelta(days=2)
    while latest.weekday() >= 5:
        latest -= timedelta(days=1)
    total, rows = load_rows(client, operation, token, {"basDt": latest.strftime("%Y%m%d")}, "exact")
    print(json.dumps(summarize(operation, "exact", total, rows, start, end, token), ensure_ascii=False))


def main():
    token = unquote(os.environ.get("DATA_GO_KR_API_KEY", "").strip())
    if not token:
        print('{"code":"missing_key"}')
        return 1
    now = datetime.now(KST)
    client = SourceClient(ROOT / "outputs" / "raw" / "kofia-probe" / now.strftime("%Y%m%dT%H%M%S%z"))
    failed = False
    for operation in OPERATIONS:
        try:
            probe(client, operation, token, now.date() - timedelta(days=6), now.date())
        except CollectionError as error:
            print(json.dumps({"operation": operation, "code": error.code}))
            failed = True
        except (KeyError, ValueError, TypeError, AttributeError, IndexError):
            print(json.dumps({"operation": operation, "code": "invalid_response"}))
            failed = True
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
