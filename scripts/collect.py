"""매일 실행되는 데이터 수집 스크립트.

필요한 환경변수:
  KRX_ID, KRX_PW        - KRX 정보데이터시스템 계정 (data.krx.co.kr, 아이디/비밀번호 가입)
  ECOS_API_KEY          - 한국은행 ECOS API 인증키
  DATA_GO_KR_API_KEY    - 공공데이터포털 API 인증키 (금융투자협회종합통계정보)

pykrx는 모듈 임포트 시점에 KRX_ID/KRX_PW를 읽어 세션을 만들기 때문에,
반드시 os.environ 설정 이후에 `from pykrx import stock`를 수행해야 한다.
"""
import datetime
import json
import os
import sys

import pandas as pd
import requests
from requests.adapters import HTTPAdapter, Retry

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "data"))

FRED_US10Y_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10"
ECOS_BASE = "https://ecos.bok.or.kr/api"

# 일부 국내 공공/금융 API가 기본 requests User-Agent를 막거나 응답이 느려서,
# 브라우저형 UA + 재시도(backoff)를 붙인 공용 세션을 쓴다.
session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
})
retry = Retry(total=3, backoff_factor=2, status_forcelist=[429, 500, 502, 503, 504])
session.mount("https://", HTTPAdapter(max_retries=retry))
session.mount("http://", HTTPAdapter(max_retries=retry))
REQUEST_TIMEOUT = 30


def upsert_json(filename, new_rows):
    """date 기준으로 병합 저장. 최근 실행분이 과거 실행분을 덮어써 자가 보정된다."""
    path = os.path.join(DATA_DIR, filename)
    existing = []
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            existing = json.load(f)

    by_date = {row["date"]: row for row in existing}
    for row in new_rows:
        by_date[row["date"]] = row

    merged = [by_date[d] for d in sorted(by_date)]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=None)
    print(f"[{filename}] {len(new_rows)}건 반영, 총 {len(merged)}건")


def collect_index_and_flow(start, end):
    """코스피/코스닥 지수 + 투자자별(기관/외국인/개인) 순매수 - pykrx (KRX_ID/KRX_PW 필요)"""
    from pykrx import stock

    kospi = stock.get_index_ohlcv_by_date(start, end, "1001")
    kosdaq = stock.get_index_ohlcv_by_date(start, end, "2001")
    index_rows = []
    for d in kospi.index:
        date_str = d.strftime("%Y-%m-%d")
        row = {"date": date_str, "kospi": float(kospi.loc[d, "종가"])}
        if d in kosdaq.index:
            row["kosdaq"] = float(kosdaq.loc[d, "종가"])
        index_rows.append(row)
    upsert_json("kospi_kosdaq.json", index_rows)

    kospi_flow = stock.get_market_trading_value_by_date(start, end, "KOSPI")
    kosdaq_flow = stock.get_market_trading_value_by_date(start, end, "KOSDAQ")
    flow_rows = []
    for d in kospi_flow.index:
        date_str = d.strftime("%Y-%m-%d")
        inst = float(kospi_flow.loc[d, "기관합계"])
        foreign = float(kospi_flow.loc[d, "외국인합계"])
        indiv = float(kospi_flow.loc[d, "개인"])
        if d in kosdaq_flow.index:
            inst += float(kosdaq_flow.loc[d, "기관합계"])
            foreign += float(kosdaq_flow.loc[d, "외국인합계"])
            indiv += float(kosdaq_flow.loc[d, "개인"])
        flow_rows.append({
            "date": date_str,
            "institution_net": round(inst / 1e8, 1),  # 억원 단위
            "foreign_net": round(foreign / 1e8, 1),
            "individual_net": round(indiv / 1e8, 1),
        })
    upsert_json("investor_flow.json", flow_rows)


def collect_us10y():
    """미국 10년물 국채금리 - FRED (키 불필요)"""
    r = session.get(FRED_US10Y_URL, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    rows = []
    for line in r.text.strip().splitlines()[1:]:
        date_str, value = line.split(",")
        value = value.strip()
        if value in ("", "."):
            continue
        rows.append({"date": date_str, "yield": float(value)})
    upsert_json("us10y.json", rows)


def ecos_item_list(stat_code, api_key):
    url = f"{ECOS_BASE}/StatisticItemList/{api_key}/json/kr/1/100/{stat_code}"
    r = session.get(url, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    data = r.json()
    result = data.get("StatisticItemList")
    if not result:
        raise RuntimeError(f"ECOS StatisticItemList error: {data}")
    return result.get("row", [])


def ecos_series(stat_code, item_code, start, end, api_key, cycle="D"):
    url = (
        f"{ECOS_BASE}/StatisticSearch/{api_key}/json/kr/1/10000/"
        f"{stat_code}/{cycle}/{start}/{end}/{item_code}"
    )
    r = session.get(url, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    data = r.json()
    result = data.get("StatisticSearch")
    if not result:
        raise RuntimeError(f"ECOS StatisticSearch error: {data}")
    return result.get("row", [])


def collect_fx(start, end):
    """주요 환율 - 한국은행 ECOS (731Y001, 일별 매매기준율). ECOS_API_KEY 필요."""
    api_key = os.environ.get("ECOS_API_KEY")
    if not api_key:
        print("[fx] ECOS_API_KEY 미설정, 건너뜀")
        return

    stat_code = "731Y001"
    items = ecos_item_list(stat_code, api_key)
    name_to_code = {it["ITEM_NAME"]: it["ITEM_CODE"] for it in items}

    wanted = {
        "usd_krw": "미국달러",
        "jpy_krw": "일본엔",
        "eur_krw": "유로",
        "cny_krw": "위안",
    }
    series_by_key = {}
    for key, name_hint in wanted.items():
        match = next((code for name, code in name_to_code.items() if name_hint in name), None)
        if not match:
            print(f"[fx] '{name_hint}' 항목을 ECOS 코드 목록에서 찾지 못함: {list(name_to_code)[:10]}")
            continue
        rows = ecos_series(stat_code, match, start, end, api_key)
        series_by_key[key] = {r["TIME"]: float(r["DATA_VALUE"]) for r in rows}

    all_dates = sorted(set().union(*[s.keys() for s in series_by_key.values()])) if series_by_key else []
    fx_rows = []
    for d in all_dates:
        date_str = f"{d[0:4]}-{d[4:6]}-{d[6:8]}"
        row = {"date": date_str}
        for key, series in series_by_key.items():
            if d in series:
                row[key] = series[d]
        fx_rows.append(row)
    upsert_json("fx.json", fx_rows)


KOFIA_BASE = "http://apis.data.go.kr/1160100/service/GetKofiaStatisticsInfoService"


def kofia_fetch(operation, api_key):
    """전체 기간이 ~1200건 내외로 크지 않아, 건수 확인 후 한 번에 전체를 가져온다."""
    url = f"{KOFIA_BASE}/{operation}"
    probe = session.get(
        url, params={"serviceKey": api_key, "numOfRows": 1, "pageNo": 1, "resultType": "json"},
        timeout=REQUEST_TIMEOUT,
    )
    probe.raise_for_status()
    total = probe.json()["response"]["body"]["totalCount"]

    r = session.get(
        url, params={"serviceKey": api_key, "numOfRows": total, "pageNo": 1, "resultType": "json"},
        timeout=REQUEST_TIMEOUT,
    )
    r.raise_for_status()
    item = r.json()["response"]["body"]["items"].get("item", [])
    if isinstance(item, dict):
        item = [item]
    return item


def to_iso_date(bas_dt):
    return f"{bas_dt[0:4]}-{bas_dt[4:6]}-{bas_dt[6:8]}"


def collect_margin_and_deposit(start, end):
    """신용거래융자 잔고, 투자자예탁금 - 금융투자협회(KOFIA) 종합통계 (공공데이터포털 경유)."""
    api_key = os.environ.get("DATA_GO_KR_API_KEY")
    if not api_key:
        print("[margin/deposit] DATA_GO_KR_API_KEY 미설정, 건너뜀")
        return

    credit_items = kofia_fetch("getGrantingOfCreditBalanceInfo", api_key)
    margin_rows = [
        {
            "date": to_iso_date(it["basDt"]),
            "kospi_margin": round(float(it["crdTrFingScrs"]) / 1e12, 2),
            "kosdaq_margin": round(float(it["crdTrFingKosdaq"]) / 1e12, 2),
        }
        for it in credit_items
    ]
    upsert_json("margin_balance.json", margin_rows)

    kospi_by_date = {}
    kospi_path = os.path.join(DATA_DIR, "kospi_kosdaq.json")
    if os.path.exists(kospi_path):
        with open(kospi_path, "r", encoding="utf-8") as f:
            for row in json.load(f):
                if "kospi" in row:
                    kospi_by_date[row["date"]] = row["kospi"]

    fund_items = kofia_fetch("getSecuritiesMarketTotalCapitalInfo", api_key)
    deposit_rows = []
    for it in fund_items:
        date_str = to_iso_date(it["basDt"])
        row = {"date": date_str, "deposit": round(float(it["invrDpsgAmt"]) / 1e12, 2)}
        if date_str in kospi_by_date:
            row["kospi"] = kospi_by_date[date_str]
        deposit_rows.append(row)
    upsert_json("investor_deposit.json", deposit_rows)


def main():
    end = datetime.date.today()
    backfill = "--backfill" in sys.argv
    start = datetime.date(2018, 1, 1) if backfill else end - datetime.timedelta(days=10)

    start_s, end_s = start.strftime("%Y%m%d"), end.strftime("%Y%m%d")
    print(f"수집 범위: {start_s} ~ {end_s} (backfill={backfill})")

    tasks = [("us10y", lambda: collect_us10y())]
    if os.environ.get("KRX_ID") and os.environ.get("KRX_PW"):
        tasks.append(("index/flow", lambda: collect_index_and_flow(start_s, end_s)))
    else:
        print("[index/flow] KRX_ID/KRX_PW 미설정, 건너뜀")
    tasks.append(("fx", lambda: collect_fx(start_s, end_s)))
    tasks.append(("margin/deposit", lambda: collect_margin_and_deposit(start_s, end_s)))

    failed = []
    for name, task in tasks:
        try:
            task()
        except Exception as e:
            print(f"[{name}] 수집 실패, 다른 소스는 계속 진행: {e}")
            failed.append(name)

    if failed:
        print(f"실패한 소스: {', '.join(failed)} (다음 실행에서 재시도됨)")


if __name__ == "__main__":
    main()
