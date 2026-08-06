"""10분마다 실행되는 장중 실시간 시세 스냅샷 수집 스크립트.

collect.py가 다루는 일별 종가 시계열과 달리, 여기서는 코스피/코스닥/원달러/
미국 10년물의 "현재가" 한 건만 받아 data/intraday.json에 덮어쓴다.
장이 닫혀 있으면 소스 페이지도 마지막 값을 그대로 보여주므로, 값이 바뀌지
않으면 커밋 워크플로 쪽에서 자연히 커밋이 스킵된다.
"""
import datetime
import json
import os
import re

import requests
from bs4 import BeautifulSoup

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "data"))
KST = datetime.timezone(datetime.timedelta(hours=9))

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
}
REQUEST_TIMEOUT = 10


def fetch_naver_index(code):
    """네이버 금융 코스피/코스닥 현재가 (#now_value)."""
    url = f"https://finance.naver.com/sise/sise_index.naver?code={code}"
    r = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
    r.encoding = "euc-kr"
    soup = BeautifulSoup(r.text, "html.parser")
    el = soup.select_one("#now_value")
    if not el:
        raise RuntimeError(f"{code} now_value 요소를 찾지 못함")
    return float(el.get_text(strip=True).replace(",", ""))


def fetch_usd_krw():
    """네이버 금융 원/달러 현재가 (환율 목록의 첫 항목)."""
    url = "https://finance.naver.com/marketindex/"
    r = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
    r.encoding = "euc-kr"
    soup = BeautifulSoup(r.text, "html.parser")
    el = soup.select_one("#exchangeList .value")
    if not el:
        raise RuntimeError("USD 환율 value 요소를 찾지 못함")
    return float(el.get_text(strip=True).replace(",", ""))


def fetch_us10y_intraday():
    """야후 파이낸스 ^TNX(CBOE 10년물 금리 지수) 실시간가.

    FRED(DGS10)는 하루 1건만 발표되는 일별 지표라 장중 갱신에 못 쓴다.
    """
    url = "https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX"
    r = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    data = r.json()
    price = data["chart"]["result"][0]["meta"]["regularMarketPrice"]
    return float(price)


def main():
    snapshot = {"updated_at": datetime.datetime.now(KST).isoformat(timespec="seconds")}

    fetchers = {
        "kospi": lambda: fetch_naver_index("KOSPI"),
        "kosdaq": lambda: fetch_naver_index("KOSDAQ"),
        "usd_krw": fetch_usd_krw,
        "us10y": fetch_us10y_intraday,
    }
    failed = []
    for key, fetch in fetchers.items():
        try:
            snapshot[key] = fetch()
        except Exception as e:
            print(f"[{key}] 수집 실패: {e}")
            failed.append(key)

    path = os.path.join(DATA_DIR, "intraday.json")
    existing = {}
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            existing = json.load(f)

    # 이번에 실패한 항목은 직전 성공값을 그대로 유지한다.
    merged = {**existing, **snapshot}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)

    print(f"intraday.json 갱신: {merged}")
    if failed:
        print(f"실패한 항목: {', '.join(failed)} (다음 실행에서 재시도됨)")


if __name__ == "__main__":
    main()
