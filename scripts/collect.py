"""Collect verified daily and macroeconomic observations into data/dashboard.json."""

import argparse
import csv
import io
import json
import operator
import os
import re
from datetime import date, timedelta
from urllib.parse import unquote

import requests
from requests.adapters import HTTPAdapter, Retry

from data_pipeline import (
    ROOT, Dashboard, CollectionError, REGISTRY, finite_number, period_end,
)
from derivatives import ECOS_DERIVATIVE_SERIES, ECOS_DERIVATIVE_UNITS, derive_monthly_turnover_pcr


ECOS_URL = "https://ecos.bok.or.kr/api/StatisticSearch"
KOFIA_URL = "https://apis.data.go.kr/1160100/service/GetKofiaStatisticsInfoService"
FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"

# Keep the ECOS table and item codes explicit. The quoted-currency units match
# the original ECOS exchange-rate history, including the 100-yen quotation.
ECOS_SERIES = {
    "kospi_ecos": ("802Y001", "0001000", 1),
    "kosdaq_ecos": ("802Y001", "0089000", 1),
    "foreign_net_kospi": ("802Y001", "0030000", 1),
    "foreign_net_kosdaq": ("802Y001", "0113000", 1),
    "kospi_turnover": ("802Y001", "0088000", 1),
    "kosdaq_turnover": ("802Y001", "0091000", 1),
    "kospi_marketcap": ("802Y001", "0183000", 1),
    "kosdaq_marketcap_monthly": ("901Y014", "2040000", 100_000),
    "usdkrw": ("731Y001", "0000001", 1),
    "jpykrw100": ("731Y001", "0000002", 1),
    "eurkrw": ("731Y001", "0000003", 1),
    "cnykrw": ("731Y001", "0000053", 1),
    "kr_base_rate": ("722Y001", "0101000", 1),
    "kr3y": ("817Y002", "010200000", 1),
    "kr10y": ("817Y002", "010210000", 1),
    "kr_cd91": ("817Y002", "010502000", 1),
    "kr_aa3y": ("817Y002", "010300000", 1),
    "kr_rp": ("817Y002", "010901000", 1),
    "kr_m2": ("161Y006", "BBHA00", 1000),
    "kr_cpi": ("901Y009", "0", 1),
    "kr_gdp": ("200Y104", "1400", 1000),
    "kospi_per_monthly": ("901Y014", "1110000", 1),
    "kospi_dividend_monthly": ("901Y014", "1100000", 1),
    "index_futures_volume_monthly": ("901Y057", "S25A", 1),
    "index_option_call_volume_monthly": ("901Y058", "S26BA", 1),
    "index_option_put_volume_monthly": ("901Y058", "S26CA", 1),
    "institution_net_monthly": ("901Y055", "S22CA", 100, "VA"),
    "individual_net_monthly": ("901Y055", "S22CB", 100, "VA"),
    "foreign_net_monthly": ("901Y055", "S22CC", 100, "VA"),
}
ECOS_SERIES.update(ECOS_DERIVATIVE_SERIES)

FRED_SERIES = {"us2y": "DGS2", "us10y": "DGS10", "usd_broad": "DTWEXBGS"}
KOFIA_SERIES = {
    "getGrantingOfCreditBalanceInfo": (
        {}, {"credit_kospi": ("crdTrFingScrs", 1e12), "credit_kosdaq": ("crdTrFingKosdaq", 1e12)},
    ),
    "getSecuritiesMarketTotalCapitalInfo": (
        {}, {"deposit": ("invrDpsgAmt", 1e12), "forced_sales": ("brkTrdUcolMnyVsOppsTrdAmt", 1e8)},
    ),
}
KOFIA_TOTALS = {
    "cma": ("getCMAStatus", {"mngInvTgt": "합계"}, "invrCtg", "actBal", {"개인", "기관"}, None),
    # The official KOFIA fund classification names money-market funds 단기금융.
    "mmf": ("getFundTotalNetEssetInfo", {"ctg": "단기금융"}, "tstMthdCtg", "nPptTotAmt", {"공모", "사모"}, "합계"),
}


class SourceClient:
    def __init__(self, raw_dir):
        self.raw_dir = raw_dir
        self.session = requests.Session()
        retry = Retry(
            total=1, backoff_factor=0.5, status_forcelist=(429, 500, 502, 503, 504),
            respect_retry_after_header=False, raise_on_status=False,
        )
        self.session.mount("https://", HTTPAdapter(max_retries=retry))

    def get(self, name, url, params=None, suffix="json"):
        try:
            response = self.session.get(url, params=params, timeout=(5, 12))
            response.raise_for_status()
        except requests.exceptions.Timeout:
            raise CollectionError("timeout", "공식 출처 응답 시간이 초과됐습니다.") from None
        except requests.exceptions.HTTPError as error:
            status = error.response.status_code
            raise CollectionError("http_error", f"공식 출처가 HTTP {status} 응답을 반환했습니다.") from None
        except requests.exceptions.RequestException:
            raise CollectionError("connection_error", "공식 출처에 연결할 수 없습니다.") from None
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        (self.raw_dir / f"{name}.{suffix}").write_bytes(response.content)
        return response.content


def package_json(content):
    try:
        payload = json.loads(content)
    except (ValueError, UnicodeError):
        raise CollectionError("invalid_response", "공식 출처가 읽을 수 없는 데이터를 반환했습니다.") from None
    if not isinstance(payload, dict):
        raise CollectionError("invalid_response", "공식 출처의 응답 형식이 변경됐습니다.")
    return payload


def period_key(day, frequency):
    if frequency == "monthly":
        return day.strftime("%Y%m")
    if frequency == "quarterly":
        return f"{day.year}Q{(day.month - 1) // 3 + 1}"
    return day.strftime("%Y%m%d")


def number_or_missing(raw_value):
    if raw_value is None or (isinstance(raw_value, str) and raw_value.strip() in {"", ".", "-", "—"}):
        return None
    value = finite_number(raw_value)
    if value is None:
        raise CollectionError("invalid_value", "공식 출처가 읽을 수 없는 관측값을 반환했습니다.")
    return value


def ecos_observations(client, key, token, start, end):
    if not token:
        raise CollectionError("missing_key", "ECOS 수집용 인증 설정이 필요합니다.")
    table, item, divisor, *dimensions = ECOS_SERIES[key]
    frequency = REGISTRY[key].frequency
    cycle = {"daily": "D", "monthly": "M", "quarterly": "Q"}[frequency]
    start_key, end_key = period_key(start, frequency), period_key(end, frequency)
    url = (
        f"{ECOS_URL}/{token}/json/kr/1/10000/{table}/{cycle}/"
        f"{start_key}/{end_key}/{item}"
    )
    if dimensions:
        url += "/" + "/".join(dimensions)
    payload = package_json(client.get(f"ecos-{key}", url))
    if "RESULT" in payload:
        code = payload["RESULT"].get("CODE")
        if code == "INFO-200":
            return []
        if code == "INFO-100":
            raise CollectionError("authorization_error", "ECOS 인증이 실패했습니다.")
        raise CollectionError("upstream_error", "ECOS가 이 통계 요청을 처리하지 못했습니다.")
    result = payload["StatisticSearch"]
    if int(result["list_total_count"]) != len(result["row"]):
        raise CollectionError("incomplete_response", "ECOS가 조회 결과의 일부만 반환했습니다.")
    rows = []
    accepted_units = {"kr_m2": "십억원", "kr_gdp": "십억원", "kr_cpi": "2020=100",
                      "kospi_per_monthly": "배", "kospi_dividend_monthly": "%",
                      "kosdaq_marketcap_monthly": "천원",
                      "index_futures_volume_monthly": "계약",
                      "index_option_call_volume_monthly": "계약",
                      "index_option_put_volume_monthly": "계약"}
    accepted_units.update(ECOS_DERIVATIVE_UNITS)
    accepted_units.update({key: "백만원" for key in (
        "institution_net_monthly", "individual_net_monthly", "foreign_net_monthly",
    )})
    expected_unit = accepted_units.get(key)
    if expected_unit is None and REGISTRY[key].unit in {"원", "억원", "%"}:
        expected_unit = "연%" if REGISTRY[key].unit == "%" else REGISTRY[key].unit
    first_period = start if cycle == "D" else period_end(start_key, frequency)
    last_period = end if cycle == "D" else period_end(end_key, frequency)
    for row in result["row"]:
        if row.get("STAT_CODE") != table or row.get("ITEM_CODE1") != item:
            raise CollectionError("unexpected_series", "요청한 ECOS 통계표와 응답 항목이 일치하지 않습니다.")
        if any(row.get(f"ITEM_CODE{index}") != code for index, code in enumerate(dimensions, 2)):
            raise CollectionError("unexpected_series", "요청한 ECOS 거래대금·거래량 구분과 응답 항목이 일치하지 않습니다.")
        if expected_unit and (row.get("UNIT_NAME") or "").strip().replace(" ", "") != expected_unit:
            raise CollectionError("unexpected_unit", "ECOS 원자료의 단위가 등록된 단위와 일치하지 않습니다.")
        raw_date = row["TIME"]
        if not isinstance(raw_date, str) or not re.fullmatch({
            "daily": r"\d{8}", "monthly": r"\d{6}", "quarterly": r"\d{4}Q[1-4]",
        }[frequency], raw_date):
            raise CollectionError("invalid_date", "ECOS 관측 기간 형식이 변경됐습니다.")
        if frequency == "daily":
            raw_date = date.fromisoformat(raw_date).isoformat()
        day = period_end(raw_date, frequency)
        if not first_period <= day <= last_period:
            raise CollectionError("invalid_date", "ECOS 응답에 요청 범위 밖의 관측일이 있습니다.")
        value = number_or_missing(row["DATA_VALUE"])
        if day <= end and value is not None:
            rows.append((day.isoformat(), round(value / divisor, 8)))
    return rows


def fred_observations(client, key, start, end):
    code = FRED_SERIES[key]
    params = {"id": code, "cosd": start.isoformat(), "coed": end.isoformat()}
    content = client.get(f"fred-{key}", FRED_URL, params, suffix="csv")
    rows = csv.DictReader(io.StringIO(content.decode("utf-8-sig")))
    if not rows.fieldnames or code not in rows.fieldnames:
        raise CollectionError("invalid_response", "FRED CSV의 지표 열을 확인할 수 없습니다.")
    date_column = rows.fieldnames[0]
    if date_column not in ("observation_date", "DATE"):
        raise CollectionError("invalid_date", "FRED CSV의 기준일 열을 확인할 수 없습니다.")
    observations = []
    for row in rows:
        value = number_or_missing(row[code])
        if value is not None:
            observed = date.fromisoformat(row[date_column])
            if start <= observed <= end:
                observations.append((observed.isoformat(), value))
    return observations


def kofia_rows(client, operation, token, start, end, filters):
    if not token:
        raise CollectionError("missing_key", "공공데이터포털 수집용 인증 설정이 필요합니다.")
    params = {
        "serviceKey": unquote(token), "numOfRows": 1000, "resultType": "json",
        "beginBasDt": start.strftime("%Y%m%d"),
        "endBasDt": (end + timedelta(days=1)).strftime("%Y%m%d"),
        **filters,
    }
    accumulated = []
    for page in range(1, 31):
        payload = package_json(client.get(
            f"kofia-{operation}-{page}", f"{KOFIA_URL}/{operation}", {**params, "pageNo": page},
        ))
        response = payload["response"]
        if str(response["header"]["resultCode"]) not in {"0", "00"}:
            raise CollectionError("upstream_error", "공공데이터포털이 이 통계 요청을 처리하지 못했습니다.")
        body = response["body"]
        total = int(body["totalCount"])
        if not total:
            return []
        if "pageNo" in body and int(body["pageNo"]) != page:
            raise CollectionError("unexpected_page", "공공데이터포털 페이지 번호가 요청과 일치하지 않습니다.")
        items = body["items"]["item"]
        if isinstance(items, dict):
            items = [items]
        if not items:
            break
        if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
            raise CollectionError("invalid_response", "공공데이터포털 응답 항목의 형식이 변경됐습니다.")
        accumulated.extend(items)
        if len(accumulated) >= total:
            return accumulated
    raise CollectionError("incomplete_response", "공공데이터포털의 전체 페이지를 확인할 수 없습니다.")


def kofia_observations(rows, field, divisor, start, end):
    points = {}
    for row in rows:
        observed = date.fromisoformat(row["basDt"])
        if start <= observed <= end:
            value = number_or_missing(row[field])
            if value is None:
                continue
            day = observed.isoformat()
            if day in points and points[day] != value:
                raise CollectionError("ambiguous_rows", "동일 기준일에 서로 다른 합계가 반환됐습니다.")
            points[day] = value
    return [(day, round(value / divisor, 2)) for day, value in points.items()]


def kofia_total_observations(client, key, token, start, end):
    operation, filters, group_field, amount_field, components, reported_total = KOFIA_TOTALS[key]
    groups_to_read = components | {reported_total} if reported_total else components
    rows = kofia_rows(client, operation, token, start, end, filters)
    by_date = {}
    for row in rows:
        if any(row.get(field) != value for field, value in filters.items()):
            continue
        group = row.get(group_field)
        if group not in groups_to_read:
            continue
        observed = date.fromisoformat(row["basDt"])
        if not start <= observed <= end:
            continue
        value = number_or_missing(row[amount_field])
        if value is None:
            continue
        if value < 0:
            raise CollectionError("invalid_value", "집계 대상 잔액에 음수 값이 있습니다.")
        groups = by_date.setdefault(observed.isoformat(), {})
        if group in groups and groups[group] != value:
            raise CollectionError("ambiguous_rows", "동일 기준일과 분류에 서로 다른 잔액이 반환됐습니다.")
        groups[group] = value
    results = []
    for day, groups in by_date.items():
        if reported_total in groups:
            value = groups[reported_total]
        elif components <= groups.keys():
            value = sum(groups[group] for group in components)
        else:
            continue
        results.append((day, round(value / 1e12, 2)))
    return results


def safely_collect(dashboard, keys, fetch):
    try:
        data = fetch()
    except CollectionError as error:
        for key in keys:
            dashboard.failure(key, error)
        return
    except (KeyError, TypeError, ValueError, AttributeError, IndexError):
        error = CollectionError("invalid_response", "공식 출처의 응답 형식 또는 필드가 변경됐습니다.")
        for key in keys:
            dashboard.failure(key, error)
        return
    for key in keys:
        try:
            dashboard.success(key, data.get(key, []))
        except CollectionError as error:
            dashboard.failure(key, error)


def run_sources(dashboard, client, backfill):
    ecos_key = os.environ.get("ECOS_API_KEY", "").strip()
    kofia_key = os.environ.get("DATA_GO_KR_API_KEY", "").strip()
    end = dashboard.today
    for key in FRED_SERIES:
        start = dashboard.since(key, backfill)
        safely_collect(dashboard, [key], lambda: {key: fred_observations(client, key, start, end)})
    for key in ECOS_SERIES:
        start = dashboard.since(key, backfill)
        safely_collect(dashboard, [key], lambda: {key: ecos_observations(client, key, ecos_key, start, end)})
    for operation, (filters, fields) in KOFIA_SERIES.items():
        start = min(dashboard.since(key, backfill) for key in fields)

        try:
            rows = kofia_rows(client, operation, kofia_key, start, end, filters)
        except CollectionError as error:
            for key in fields:
                dashboard.failure(key, error)
            continue
        except (KeyError, TypeError, ValueError, AttributeError, IndexError):
            error = CollectionError("invalid_response", "공공데이터포털 응답 형식이 변경됐습니다.")
            for key in fields:
                dashboard.failure(key, error)
            continue
        if filters:
            rows = [row for row in rows if all(row.get(key) == value for key, value in filters.items())]
        for key, (field, divisor) in fields.items():
            safely_collect(dashboard, [key], lambda: {
                key: kofia_observations(rows, field, divisor, start, end),
            })
    for key in KOFIA_TOTALS:
        start = dashboard.since(key, backfill)
        safely_collect(dashboard, [key], lambda: {
            key: kofia_total_observations(client, key, kofia_key, start, end),
        })


def basis_points(left, right):
    return (left - right) * 100


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backfill", action="store_true", help="request available observations back to 2016")
    parser.add_argument("--seed-only", action="store_true", help="build the dashboard from stored observations without network access")
    args = parser.parse_args()
    dashboard = Dashboard()
    if not args.seed_only:
        raw_dir = ROOT / "outputs" / "raw" / dashboard.now.strftime("%Y%m%dT%H%M%S%z")
        run_sources(dashboard, SourceClient(raw_dir), args.backfill)
    dashboard.combine("foreign_net_ecos", "foreign_net_kospi", "foreign_net_kosdaq", operator.add)
    dashboard.combine("kr_term_spread", "kr10y", "kr3y", basis_points)
    dashboard.combine("kr_credit_spread", "kr_aa3y", "kr3y", basis_points)
    dashboard.combine("kr_us10y_spread", "kr10y", "us10y", basis_points)
    dashboard.combine("index_option_volume_pcr_monthly", "index_option_put_volume_monthly", "index_option_call_volume_monthly", lambda put, call: put / call if call > 0 else float("nan"))
    derive_monthly_turnover_pcr(dashboard)
    data = dashboard.write()
    for key in sorted(dashboard.failed_keys):
        print(f"::warning title={key}::{dashboard.diagnostics[key]['code']}")
    counts = {}
    for series in data["series"].values():
        status = series["status"]
        counts[status] = counts.get(status, 0) + 1
    print("수집 상태:", ", ".join(f"{key}={value}" for key, value in sorted(counts.items())))
    return int(bool(dashboard.failed_keys))


if __name__ == "__main__":
    raise SystemExit(main())
