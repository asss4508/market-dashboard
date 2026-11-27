"""Collect published per-creation-unit baskets and compare verified snapshots."""

import argparse
import hashlib
import json
import math
import os
import re
import tempfile
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from io import BytesIO
from pathlib import Path
from zipfile import BadZipFile

import requests
from bs4 import BeautifulSoup
from openpyxl import load_workbook
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


ROOT = Path(__file__).resolve().parents[1]
KST = timezone(timedelta(hours=9))
TIGER_BASE = "https://prod.investments.miraeasset.com/tigeretf/ko/product/search/detail"
KOACT_BASE = "https://www.samsungactive.co.kr"
TIGER_CHART = TIGER_BASE.rsplit("/search/detail", 1)[0] + "/chart/prdct-item-list.ajax"
FUNDS = {
    "tiger": ("0204S0", "TIGER", "미래에셋자산운용", TIGER_BASE + "/index.do?ksdFund=KR70204S0006"),
    "time": ("0162Y0", "TIME", "타임폴리오자산운용", "https://timeetf.co.kr/m11_view.php?idx=24"),
    "koact": ("0163Y0", "KoAct", "삼성액티브자산운용", KOACT_BASE + "/etf/view.do?id=2ETFU6"),
    "ds": ("0220B0", "DS", "디에스자산운용", "https://dsetf.com/etf/0220B0"),
    "midas": ("0191B0", "MIDAS", "마이다스에셋자산운용",
              "https://midasasset.com/fund/마이다스midas코스닥액티브etf/"),
}
CASH = {"현금", "원화현금", "원화예금"}
NOTE = ("구성종목 비중 변화에는 가격 변동이 포함됩니다. 수량은 1설정단위(CU) 기준이며 "
        "펀드 전체의 실제 매매량은 알 수 없습니다. 현금은 종목 변화 집계에서 제외하며 "
        "비중 차이가 0.01%p 미만이면 보합으로 분류합니다.")


class InvalidBasket(ValueError):
    pass


def number(value):
    if value is None or str(value).strip() in {"", "-", "—"}:
        return None
    result = float(str(value).replace(",", ""))
    if not math.isfinite(result):
        raise InvalidBasket("invalid number")
    return result


def holding(code, name, quantity, value, weight):
    name = str(name or "").strip()
    cash = name in CASH
    code = str(code or ("KRW-CASH" if cash else "")).strip()
    if not code or not name:
        raise InvalidBasket("missing identifier")
    weight = number(weight)
    if not cash and weight is None:
        raise InvalidBasket("missing constituent weight")
    return {"code": code, "name": name, "quantity": number(quantity),
            "marketValue": number(value), "weightPct": weight,
            "assetType": "cash" if cash else "security"}


def snapshot(day, rows, count, observed_at):
    if not rows or len(rows) != count or len({r["code"] for r in rows}) != count:
        raise InvalidBasket("incomplete list")
    # Each of these five domestic equity baskets reports weights summing to 100%.
    # Some issuers exclude cash from that denominator and leave its weight blank.
    if abs(sum(r["weightPct"] or 0 for r in rows) - 100) > 0.005 * count + 0.01:
        raise InvalidBasket("incomplete weight coverage")
    rows = sorted(rows, key=lambda r: r["code"])
    digest = hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False,
                                        separators=(",", ":")).encode()).hexdigest()
    return {"date": day.isoformat(), "collectedAt": observed_at, "complete": True,
            "totalRows": count, "revisionHash": digest, "holdings": rows}


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temp:
        temp.write(content)
        tmp_path = Path(temp.name)
    try:
        os.replace(tmp_path, path)
    finally:
        tmp_path.unlink(missing_ok=True)


def write_json(path, payload):
    atomic_write(path, (json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode())


class Reader:
    def __init__(self, raw):
        self.raw = raw
        self.stage = None
        self.session = requests.Session()
        retry = Retry(total=2, backoff_factor=0.5, status_forcelist=(429, 502, 503, 504),
                      allowed_methods={"GET"}, raise_on_status=False)
        self.session.mount("https://", HTTPAdapter(max_retries=retry))

    def get(self, fund, day, url, params=None):
        self.stage = {
            TIGER_CHART: "tiger_dated_json",
            TIGER_BASE + "/pdf/excel.do": "tiger_workbook",
            FUNDS["time"][3]: "time_pdf_date",
            "https://timeetf.co.kr/pdf_excel.php": "time_workbook",
            KOACT_BASE + "/api/v1/product/etf-pdf/2ETFU6.do": "koact_pdf",
            FUNDS["ds"][3]: "ds_product",
        }.get(url, "source")
        response = self.session.get(url, params=params, timeout=(5, 18))
        response.raise_for_status()
        body = response.content
        digest = hashlib.sha256(body).hexdigest()
        path = self.raw / fund / day.isoformat() / f"{digest}.raw"
        if not path.exists():
            atomic_write(path, body)
        return body


def tiger(reader, day, at):
    # The issuer's Excel lookup rolls holidays to another basket. Its JSON
    # gives the valuation date (the session preceding the PDF date). TIME's
    # exact-date PDF table establishes which days actually published baskets.
    isin = "KR70204S0006"
    if not time_table(reader, day):
        return None
    prior = next((d for d in weekdays(day - timedelta(days=1)) if time_table(reader, d)), None)
    if prior is None:
        raise InvalidBasket("issuer date cross-check failed")
    body = reader.get("tiger", day, TIGER_BASE + "/pdf/excel.do", {
        "ksdFund": isin, "jongCode": "0204S0", "fixDate": day.strftime("%Y%m%d")})
    soup = BeautifulSoup(body, "html.parser", from_encoding="utf-8")
    rows = []
    for tr in soup.select("tr"):
        cells = [cell.get_text(strip=True) for cell in tr.select("td")]
        if len(cells) == 7 and cells[0].isdigit():
            if int(cells[0]) != len(rows) + 1:
                raise InvalidBasket("discontinuous issuer list")
            rows.append(holding(*cells[1:6]))
    reference = json.loads(reader.get("tiger", day, TIGER_CHART, {
        "ksdFund": isin, "fixDate": prior.strftime("%Y%m%d"),
        "prfPrd": "Week01", "listCnt": len(rows) + 1}))["rtnData"]
    if not reference:
        return None
    if any(r["ksdFund"] != isin or r["wkdate"] != prior.strftime("%Y%m%d") for r in reference):
        raise InvalidBasket("issuer date cross-check failed")
    official = [holding(r["code"] if r["memItemname"] in CASH else r["memItemcode"],
                        r["memItemname"], r["stockQty"], r["stockPrc"], r["stockRate"])
                for r in reference]
    def positions(items):
        return {(r["code"], r["quantity"], r["marketValue"]) for r in items}
    if positions(rows) != positions(official):
        raise InvalidBasket("issuer date cross-check failed")
    return snapshot(day, rows, len(reference), at)


def time_table(reader, day):
    body = reader.get("time", day, FUNDS["time"][3], {"pdfDate": day.isoformat()})
    soup = BeautifulSoup(body, "html.parser", from_encoding="utf-8")
    section = soup.select_one("#constituentItems")
    if section is None or section.select_one("#pdfDate")["value"] != day.isoformat():
        raise InvalidBasket("unexpected PDF date")
    table = section.select_one("table")
    if [c.get_text(strip=True) for c in table.select("thead th")] != [
            "종목코드", "종목명", "수량", "평가금액(원)", "비중(%)"]:
        raise InvalidBasket("unexpected PDF columns")
    return [holding(*[c.get_text(strip=True) for c in tr.select("td")])
            for tr in table.select("tbody tr")]


def timefolio(reader, day, at):
    rows = time_table(reader, day)
    if not rows:
        return None
    if not any(r["assetType"] == "cash" for r in rows):
        raise InvalidBasket("missing TIME cash line")
    workbook = reader.get("time", day, "https://timeetf.co.kr/pdf_excel.php",
                          {"idx": 24, "pdfDate": day.isoformat()})
    try:
        with closing(load_workbook(BytesIO(workbook), read_only=True, data_only=True)) as book:
            table = iter(book.active.values)
            if tuple(next(table, ())) != ("종목코드", "종목명", "수량", "평가금액(원)", "비중(%)"):
                raise InvalidBasket("unexpected workbook header")
            reference = []
            for code, name, quantity, amount, weight in table:
                if isinstance(code, int):
                    code = str(code).zfill(6)
                reference.append(holding(code, name, quantity, amount, weight))
    except BadZipFile as error:
        raise InvalidBasket("invalid workbook") from error
    if sorted(reference, key=lambda r: r["code"]) != sorted(rows, key=lambda r: r["code"]):
        raise InvalidBasket("TIME table and workbook differ")
    return snapshot(day, rows, len(reference), at)


def koact(reader, day, at):
    compact = day.strftime("%Y%m%d")
    payload = json.loads(reader.get("koact", day, KOACT_BASE + "/api/v1/product/etf-pdf/2ETFU6.do",
                                    {"gijunYMD": compact})).get("pdf")
    if not payload or not payload.get("list") or payload["gijunYMD"] != compact:
        return None
    if payload["totalCnt"] != payload["nowCnt"]:
        raise InvalidBasket("incomplete KoAct list")
    rows = [holding(r["itmNo"], r["secNm"], r["applyQ"], r["evalA"], r["ratio"])
            for r in payload["list"]]
    return snapshot(day, rows, payload["totalCnt"], at)


def ds_snapshots(reader, today, at):
    body = reader.get("ds", today, FUNDS["ds"][3]).decode("utf-8")
    # The product page embeds the full two dated baskets in its server-rendered
    # Next.js payload. The visible summary cards show only selected holdings.
    decoder = json.JSONDecoder()
    for match in re.finditer(r'self\.__next_f\.push\((\[1,".*?"\])\)</script>', body, re.S):
        text = json.loads(match[1])[1]
        if '"latestHoldings":' not in text:
            continue
        def field(key):
            return decoder.raw_decode(text.partition(f'"{key}":')[2])[0]
        latest = {"date": field("latestHoldingsDate"), "items": field("latestHoldings")}
        previous = field("periodHoldings").get("1d")
        results = []
        for item in (latest, previous):
            if item is None:
                continue
            day = date.fromisoformat(item["date"])
            if day > today:
                raise InvalidBasket("future issuer date")
            rows = [holding(r["ticker"], r["name"], r["quantity"], r["marketValue"], r["weightPct"])
                    for r in item["items"]]
            results.append(snapshot(day, rows, len(item["items"]), at))
        return results
    raise InvalidBasket("missing issuer basket")


ADAPTERS = {"tiger": tiger, "time": timefolio, "koact": koact}


def compare(previous, latest):
    if not previous or not latest or not previous["complete"] or not latest["complete"]:
        return None
    def securities(s):
        return {r["code"]: r for r in s["holdings"] if r["assetType"] != "cash"}
    before, after = securities(previous), securities(latest)
    counts = dict.fromkeys(("entry", "increase", "decrease", "exit", "unchanged"), 0)
    changes = []
    for code in sorted(before.keys() | after.keys()):
        old, new = before.get(code), after.get(code)
        w0, w1 = (old["weightPct"] if old else 0), (new["weightPct"] if new else 0)
        delta = Decimal(str(w1)) - Decimal(str(w0))
        if old is None:
            kind = "entry"
        elif new is None:
            kind = "exit"
        elif abs(delta) < Decimal("0.01"):
            kind = "unchanged"
        else:
            kind = "increase" if delta > 0 else "decrease"
        q0, q1 = (old["quantity"] if old else 0), (new["quantity"] if new else 0)
        counts[kind] += 1
        changes.append({"code": code, "name": (new or old)["name"], "kind": kind,
                        "previousWeight": w0, "newWeight": w1, "deltaPp": float(delta),
                        "quantityChange": q1 - q0 if q0 is not None and q1 is not None else None,
                        "priceEffectUnknown": True})
    changes.sort(key=lambda r: (-abs(r["deltaPp"]), r["code"]))
    return {"from": previous["date"], "to": latest["date"], "changes": changes, "counts": counts, "note": NOTE}


def archive(directory, item):
    day = directory / item["date"]
    path = day / "latest.json"
    if path.exists():
        old = json.loads(path.read_bytes())
        if old["revisionHash"] == item["revisionHash"]:
            return old
        version = day / f'{old["revisionHash"]}.json'
        if not version.exists():
            write_json(version, old)
    write_json(path, item)
    return item


def weekdays(today):
    for offset in range(21):
        day = today - timedelta(days=offset)
        if day.weekday() < 5:
            yield day


def diagnostic(fund, day, reader, error):
    status = None
    if isinstance(error, requests.HTTPError) and error.response is not None:
        status = error.response.status_code
        code = "http_error"
    elif isinstance(error, requests.exceptions.SSLError):
        code = "tls_error"
    elif isinstance(error, requests.Timeout):
        code = "source_timeout"
    elif isinstance(error, requests.RequestException):
        code = "connection_error"
    elif isinstance(error, json.JSONDecodeError):
        code = "invalid_json"
    elif isinstance(error, InvalidBasket):
        code = {"incomplete weight coverage": "incomplete_weights",
                "incomplete list": "incomplete_list",
                "issuer date cross-check failed": "issuer_date_mismatch",
                "unexpected PDF date": "issuer_date_mismatch",
                "incomplete KoAct list": "incomplete_list",
                "TIME table and workbook differ": "workbook_mismatch"}.get(str(error), "invalid_basket")
    else:
        code = "source_schema_changed"
    return {"id": fund, "code": code, "stage": getattr(reader, "stage", None),
            "date": day.isoformat(), "httpStatus": status,
            "message": "해당 날짜의 공개 구성종목을 확인할 수 없어 검증된 자료를 유지합니다."}


def collect(root, today, at, reader):
    records, errors = [], []
    for fund, (ticker, brand, issuer, url) in FUNDS.items():
        if fund == "midas":
            records.append({"id": fund, "ticker": ticker, "name": f"{brand} 코스닥액티브",
                            "issuer": issuer, "sourceName": issuer, "sourceUrl": url,
                            "status": "link_only", "scope": "holdings-per-cu",
                            "statusReason": "운용사가 구성종목 공시를 한국거래소로 안내하여 상품 페이지 링크만 제공합니다.",
                            "latest": None, "previous": None, "comparison": None, "gapDates": []})
            continue
        directory = root / "data" / "etf-history" / ticker
        failed_dates = set()
        failure = None
        fetched = []
        try:
            if fund == "ds":
                fetched = ds_snapshots(reader, today, at)
            else:
                for day in weekdays(today):
                    try:
                        item = ADAPTERS[fund](reader, day, at)
                    except requests.RequestException as exc:
                        failed_dates.add(day.isoformat())
                        failure = failure or diagnostic(fund, day, reader, exc)
                        break
                    except (ValueError, KeyError, TypeError, AttributeError) as exc:
                        failed_dates.add(day.isoformat())
                        failure = failure or diagnostic(fund, day, reader, exc)
                        if isinstance(exc, json.JSONDecodeError):
                            break
                        continue
                    if item:
                        fetched.append(item)
                    if len(fetched) == 2:
                        break
        except (requests.RequestException, ValueError, KeyError, TypeError, AttributeError) as exc:
            failed_dates.add(today.isoformat())
            failure = diagnostic(fund, today, reader, exc)
        for item in fetched:
            archive(directory, item)
        files = sorted((p for p in directory.glob("*/latest.json")
                        if p.parent.name <= today.isoformat()), reverse=True)[:2]
        items = [json.loads(p.read_bytes()) for p in files]
        latest, previous = (items + [None, None])[:2]
        comparison = compare(previous, latest)
        if failure:
            errors.append(failure)
        elif not latest or not fetched:
            errors.append({"id": fund, "code": "no_published_basket",
                           "message": "조회 기간에 검증할 수 있는 공개 구성종목이 없습니다."})
        gap = []
        if comparison:
            first, last = (date.fromisoformat(comparison[k]) for k in ("from", "to"))
            gap = [(first + timedelta(days=i)).isoformat() for i in range(1, (last - first).days)
                   if (first + timedelta(days=i)).weekday() < 5]
            if gap:
                comparison["note"] += " 중간 평일에 확인된 파일이 없어 표시된 두 날짜 사이의 변화입니다."
            if any(d in failed_dates for d in gap):
                comparison = None
        status = "missing" if not latest else (
            "current" if latest["date"] == next(weekdays(today)).isoformat() and not failed_dates else "delayed")
        records.append({"id": fund, "ticker": ticker, "name": f"{brand} 코스닥액티브", "issuer": issuer,
                        "sourceName": issuer,
                        "sourceUrl": url, "status": status, "scope": "holdings-per-cu",
                        "latest": latest, "previous": previous, "comparison": comparison, "gapDates": gap})
    payload = {"schemaVersion": 1, "generatedAt": at, "etfs": records, "errors": errors}
    write_json(root / "data" / "etf-changes.json", payload)
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--as-of", type=date.fromisoformat, help="Latest eligible KST date")
    args = parser.parse_args()
    now = datetime.now(KST)
    report = collect(ROOT, args.as_of or now.date(), now.isoformat(timespec="seconds"),
                     Reader(ROOT / "outputs" / "raw" / "etf"))
    for r in report["etfs"]:
        print(r["ticker"], r["status"], (r["latest"] or {}).get("date"),
              (r["comparison"] or {}).get("counts", {}))
    for error in report["errors"]:
        print(f"::warning title=ETF {error['id']}::{error['code']} stage={error.get('stage')} "
              f"date={error.get('date')} http={error.get('httpStatus')}")
    return int(bool(report["errors"]))


if __name__ == "__main__":
    raise SystemExit(main())
