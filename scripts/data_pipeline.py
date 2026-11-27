"""Shared data registry, validation, and publication for the market dashboard."""

import calendar
import json
import math
import os
import tempfile
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from derivatives import DERIVATIVE_INDICATORS, DERIVATIVE_LIMITATIONS


ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
KST = timezone(timedelta(hours=9), "KST")


@dataclass(frozen=True)
class Source:
    name: str
    url: str
    access: str
    license: str


@dataclass(frozen=True)
class Indicator:
    label: str
    category: str
    unit: str
    scope: str
    definition: str
    source: Source
    frequency: str = "daily"
    expected_lag: int = 4
    limitation: str = ""


ECOS = Source("한국은행 ECOS", "https://ecos.bok.or.kr/", "ECOS Open API", "한국은행 작성 통계 · 출처 표시")
ECOS_MARKET = Source("한국은행 ECOS · 한국거래소", ECOS.url, ECOS.access, "ECOS 외부 작성 통계 · 출처 표시 및 비상업 이용")
ECOS_BONDS = Source("한국은행 ECOS · 금융투자협회", ECOS.url, ECOS.access, "ECOS 외부 작성 통계 · 출처 표시 및 비상업 이용")
ECOS_CPI = Source("한국은행 ECOS · 국가데이터처", ECOS.url, ECOS.access, "ECOS 외부 작성 통계 · 출처 표시 및 비상업 이용")
ECOS_FX = Source("한국은행 ECOS", ECOS.url, ECOS.access, "ECOS 환율 통계 · 출처 표시")
KOFIA = Source("금융투자협회 · 금융위원회", "https://www.data.go.kr/data/15094809/openapi.do", "공공데이터포털 Open API", "이용허락범위 제한 없음")
KRX_ARCHIVE = Source("한국거래소 · 기존 보관 이력", "https://data.krx.co.kr/", "기존 대시보드 기록", "기존 보관 이력 · 신규 직접 수집은 재배포 권한 필요")
KRX = Source("한국거래소", "https://data.krx.co.kr/", "공식 시세 및 통계 조회", "신규 데이터의 공개 재배포 승인 필요")
DERIVED = Source("공식 관측값으로 계산", "https://ecos.bok.or.kr/", "동일 기준일 관측값 비교", "기초 통계의 출처 및 이용 조건 적용")


def fred_source(code):
    return Source("FRED · 미국 연방준비제도", f"https://fred.stlouisfed.org/series/{code}", "공개 CSV", "연방준비제도 통계 · 출처 표시")


ARCHIVE_ONLY = "기존 이력만 제공됩니다. 직접 수집을 통한 갱신은 재배포 권한 확인 후 연결할 수 있습니다."
NEEDS_SOURCE = "공개 대시보드에 사용할 수 있는 동질적인 검증 자료를 확보하면 연결할 수 있습니다."
NEEDS_UNIVERSE = "종목별 수정주가와 당시의 상장 종목 목록이 필요합니다."

# Price levels, index bases, and current aggregate stocks are strictly positive.
# Flows, yields, and spreads can be zero or negative.
POSITIVE_SERIES = {
    "kospi", "kosdaq", "kospi_ecos", "kosdaq_ecos", "kospi200", "kosdaq150",
    "usdkrw", "eurkrw", "jpykrw100", "cnykrw", "dxy", "usd_broad",
    "kr_m2", "kr_cpi", "kr_gdp", "kospi_marketcap", "kosdaq_marketcap",
}
NONNEGATIVE_SERIES = {
    "deposit", "credit_kospi", "credit_kosdaq", "cma", "mmf", "forced_sales",
    "kospi_turnover", "kosdaq_turnover",
    "index_futures_volume_monthly", "index_option_call_volume_monthly",
    "index_option_put_volume_monthly", "index_option_volume_pcr_monthly", "kospi_dividend_monthly",
}


REGISTRY = {
    "kospi": Indicator("코스피", "국내 지수", "pt", "코스피", "일별 종가 · 기존 KRX 보관 이력", KRX_ARCHIVE, limitation=ARCHIVE_ONLY),
    "kosdaq": Indicator("코스닥", "국내 지수", "pt", "코스닥", "일별 종가 · 기존 KRX 보관 이력", KRX_ARCHIVE, limitation=ARCHIVE_ONLY),
    "kospi_ecos": Indicator("코스피", "국내 지수", "pt", "코스피", "ECOS 주식시장 일별 종가", ECOS_MARKET),
    "kosdaq_ecos": Indicator("코스닥", "국내 지수", "pt", "코스닥", "ECOS 주식시장 일별 종가", ECOS_MARKET),
    "kospi200": Indicator("코스피 200", "국내 지수", "pt", "코스피 200", "KRX 코스피 200 가격지수 종가", KRX, limitation=NEEDS_SOURCE),
    "kosdaq150": Indicator("코스닥 150", "국내 지수", "pt", "코스닥 150", "KRX 코스닥 150 가격지수 종가", KRX, limitation=NEEDS_SOURCE),
    "vkospi": Indicator("VKOSPI", "국내 지수", "pt", "코스피 200 옵션", "코스피 200 옵션에서 산출한 변동성 지수", KRX, limitation=NEEDS_SOURCE),
    "usdkrw": Indicator("원/달러", "환율", "원", "미국 달러 1단위", "원/미국 달러 일별 매매기준율", ECOS_FX),
    "eurkrw": Indicator("원/유로", "환율", "원", "유로 1단위", "원/유로 일별 매매기준율", ECOS_FX),
    "jpykrw100": Indicator("원/엔(100엔)", "환율", "원", "일본 엔 100단위", "원/일본 엔 100엔당 일별 매매기준율", ECOS_FX),
    "cnykrw": Indicator("원/위안", "환율", "원", "중국 위안 1단위", "원/중국 위안 일별 매매기준율", ECOS_FX),
    "dxy": Indicator("달러 인덱스(DXY)", "환율", "pt", "ICE 달러 인덱스", "미국 달러와 6개 통화 바스켓의 가격지수", Source("ICE", "https://www.ice.com/products/194/US-Dollar-Index-Futures", "ICE 시세", "공개 재배포 허가 필요"), limitation="ICE DXY 이력 이용 권한이 필요합니다. 연준 광의 달러지수는 별도 지표입니다."),
    "usd_broad": Indicator("연준 광의 달러지수", "환율", "pt", "미국 교역 상대국", "연준 명목 광의 무역가중 달러지수(2006년 1월=100)", fred_source("DTWEXBGS"), expected_lag=12),
    "us2y": Indicator("미국채 2년", "금리", "%", "미국 국채", "미국 국채 2년 만기 고정만기 수익률", fred_source("DGS2"), expected_lag=7),
    "us10y": Indicator("미국채 10년", "금리", "%", "미국 국채", "미국 국채 10년 만기 고정만기 수익률", fred_source("DGS10"), expected_lag=7),
    "kr3y": Indicator("국고채 3년", "금리", "%", "한국 국고채", "국고채 3년 최종호가수익률", ECOS_BONDS),
    "kr10y": Indicator("국고채 10년", "금리", "%", "한국 국고채", "국고채 10년 최종호가수익률", ECOS_BONDS),
    "kr_cd91": Indicator("CD 91일", "금리", "%", "양도성예금증서", "CD 91일 최종호가수익률", ECOS_BONDS),
    "kr_aa3y": Indicator("회사채 AA- 3년", "금리", "%", "한국 회사채", "회사채 AA- 3년 최종호가수익률", ECOS_BONDS),
    "kr_base_rate": Indicator("한국은행 기준금리", "금리", "%", "한국 통화정책", "한국은행 기준금리 일별 수준", ECOS),
    "kr_term_spread": Indicator("한국 장단기 금리차", "금리", "bp", "한국 국고채", "동일 관측일 국고채 10년 − 국고채 3년", DERIVED),
    "kr_credit_spread": Indicator("회사채 신용스프레드", "금리", "bp", "한국 회사채와 국고채", "동일 관측일 회사채 AA- 3년 − 국고채 3년", DERIVED),
    "kr_us10y_spread": Indicator("한미 10년 금리차", "금리", "bp", "한국과 미국 국채", "동일 관측일 국고채 10년 − 미국채 10년", DERIVED, expected_lag=7),
    "kr_m2": Indicator("광의통화 M2", "유동성", "조원", "한국 통화량", "월별 평잔 원계열 광의통화(십억원을 조원으로 변환)", ECOS, "monthly", 65),
    "kr_cpi": Indicator("소비자물가", "실물 경제", "pt", "전국 소비자물가", "전국 소비자물가지수 총지수(2020=100)", ECOS_CPI, "monthly", 45),
    "kr_gdp": Indicator("실질 GDP", "실물 경제", "조원", "한국 국민계정", "2020년 연쇄가격 계절조정 실질 국내총생산", ECOS, "quarterly", 125),
    "kr_rp": Indicator("RP 금리", "금리", "%", "한국 단기금융", "한국 환매조건부채권 거래금리", ECOS, limitation="대상 RP의 만기·거래 범위가 확인된 이력을 연결해야 합니다."),
    "kr_cds": Indicator("한국 CDS", "금리", "bp", "한국 정부", "한국 5년 만기 신용부도스왑 프리미엄", Source("CDS 시세 제공사", "https://www.bok.or.kr/", "시장정보 제공사", "공개 재배포 허가 필요"), limitation=NEEDS_SOURCE),
    "deposit": Indicator("투자자예탁금", "증시 자금", "조원", "국내 증시", "장내파생상품 거래예수금을 제외한 투자자예탁금 잔액", KOFIA, expected_lag=7),
    "credit_kospi": Indicator("코스피 신용융자", "증시 자금", "조원", "코스피", "유가증권시장 신용거래융자 잔고", KOFIA, expected_lag=7),
    "credit_kosdaq": Indicator("코스닥 신용융자", "증시 자금", "조원", "코스닥", "코스닥시장 신용거래융자 잔고", KOFIA, expected_lag=7),
    "cma": Indicator("CMA 잔고", "증시 자금", "조원", "국내 증권사", "전체 운용대상의 같은 기준일 개인·기관 CMA 계좌잔고 합계", KOFIA, expected_lag=7),
    "mmf": Indicator("단기금융(MMF) 순자산총액", "증시 자금", "조원", "국내 펀드", "단기금융(MMF)의 공식 합계 또는 같은 기준일 공모·사모 순자산 합계", KOFIA, expected_lag=7, limitation="합계가 없고 공모·사모 중 일부만 있는 기준일은 제외합니다."),
    "forced_sales": Indicator("반대매매 금액", "증시 자금", "억원", "국내 증시", "위탁매매 미수금 대비 반대매매 금액", KOFIA, expected_lag=7),
    "foreign_net": Indicator("외국인 순매수", "투자자 수급", "억원", "코스피+코스닥", "코스피·코스닥 합산 외국인 순매수대금", KRX_ARCHIVE, limitation=ARCHIVE_ONLY),
    "institution_net": Indicator("기관 순매수", "투자자 수급", "억원", "코스피+코스닥", "코스피·코스닥 합산 기관 순매수대금", KRX_ARCHIVE, limitation=ARCHIVE_ONLY),
    "individual_net": Indicator("개인 순매수", "투자자 수급", "억원", "코스피+코스닥", "코스피·코스닥 합산 개인 순매수대금", KRX_ARCHIVE, limitation=ARCHIVE_ONLY),
    "foreign_net_kospi": Indicator("코스피 외국인 순매수", "투자자 수급", "억원", "코스피", "ECOS 유가증권시장 외국인 순매수대금", ECOS_MARKET),
    "foreign_net_kosdaq": Indicator("코스닥 외국인 순매수", "투자자 수급", "억원", "코스닥", "ECOS 코스닥시장 외국인 순매수대금", ECOS_MARKET),
    "foreign_net_ecos": Indicator("외국인 순매수", "투자자 수급", "억원", "코스피+코스닥", "동일 거래일 ECOS 유가증권 및 코스닥시장 외국인 순매수대금 합계", ECOS_MARKET),
    "institution_net_monthly": Indicator("기관 순매수 · 월", "투자자 수급", "억원", "ECOS 투자자별 주식거래 공표 범위", "ECOS 901Y055 기관투자자 순매수(S22CA), 거래대금(VA), 백만원을 억원으로 변환", ECOS_MARKET, "monthly", 45,
        "월별 공표 거래대금입니다. 양 시장 합산 일별 수급과 시장 범위가 같다고 확인되지 않아 일별 이력·점수에 이어 붙이지 않습니다."),
    "individual_net_monthly": Indicator("개인 순매수 · 월", "투자자 수급", "억원", "ECOS 투자자별 주식거래 공표 범위", "ECOS 901Y055 개인 순매수(S22CB), 거래대금(VA), 백만원을 억원으로 변환", ECOS_MARKET, "monthly", 45,
        "월별 공표 거래대금입니다. 양 시장 합산 일별 수급과 시장 범위가 같다고 확인되지 않아 일별 이력·점수에 이어 붙이지 않습니다."),
    "foreign_net_monthly": Indicator("외국인 순매수 · 월", "투자자 수급", "억원", "ECOS 투자자별 주식거래 공표 범위", "ECOS 901Y055 외국인 순매수(S22CC), 거래대금(VA), 백만원을 억원으로 변환", ECOS_MARKET, "monthly", 45,
        "월별 공표 외국인 항목이며 기타외국인은 별도 분류입니다. 양 시장 합산 일별 외국인 수급과 이어 붙이지 않습니다."),
    "kospi_turnover": Indicator("코스피 거래대금", "투자자 수급", "억원", "코스피", "ECOS 유가증권시장 일별 주식 거래대금", ECOS_MARKET),
    "kosdaq_turnover": Indicator("코스닥 거래대금", "투자자 수급", "억원", "코스닥", "ECOS 코스닥시장 일별 주식 거래대금", ECOS_MARKET),
    "kospi_marketcap": Indicator("코스피 시가총액", "국내 지수", "억원", "코스피", "ECOS 유가증권시장 일별 시가총액", ECOS_MARKET),
    "kospi_per_monthly": Indicator("코스피 공표 PER · 월", "밸류에이션", "배", "코스피", "ECOS 주요금융통계의 월별 KOSPI 주가이익비율", ECOS_MARKET, "monthly", 45, "이익 산정의 상세 기준을 확보하지 않아 TTM·12M Forward PER로 분류하지 않습니다."),
    "kospi_dividend_monthly": Indicator("코스피 배당수익률 · 월", "밸류에이션", "%", "코스피", "ECOS 주요금융통계의 월별 KOSPI 배당수익률", ECOS_MARKET, "monthly", 45),
    "index_futures_volume_monthly": Indicator("주가지수선물 거래량 · 월", "선물옵션", "계약", "주가지수선물 합계", "ECOS 주가지수선물 거래의 월별 계약수", ECOS_MARKET, "monthly", 45, "월별 거래량이며 미결제약정·롤오버가 아닙니다. 상품별·만기별 구성은 제공되지 않습니다."),
    "index_option_call_volume_monthly": Indicator("주가지수 콜옵션 거래량 · 월", "선물옵션", "계약", "주가지수옵션 합계", "ECOS 주가지수옵션 거래의 월별 CALL 계약수", ECOS_MARKET, "monthly", 45, "월별 거래량이며 미결제약정이 아닙니다. 상품별·만기별 구성은 제공되지 않습니다."),
    "index_option_put_volume_monthly": Indicator("주가지수 풋옵션 거래량 · 월", "선물옵션", "계약", "주가지수옵션 합계", "ECOS 주가지수옵션 거래의 월별 PUT 계약수", ECOS_MARKET, "monthly", 45, "월별 거래량이며 미결제약정이 아닙니다. 상품별·만기별 구성은 제공되지 않습니다."),
    "index_option_volume_pcr_monthly": Indicator("주가지수옵션 거래량 P/C · 월", "선물옵션", "배", "주가지수옵션 합계", "같은 기준월 ECOS PUT 계약수 / CALL 계약수", ECOS_MARKET, "monthly", 45, "풋/콜 월 거래량 비율입니다. 미결제약정 비율 또는 일별 지표가 아닙니다."),
}


for identifier, label, category, unit, scope, definition, limitation in (
    ("kosdaq_marketcap", "코스닥 시가총액", "국내 지수", "억원", "코스닥", "코스닥시장 일별 시가총액", NEEDS_SOURCE),
    ("advancers", "상승 종목수", "시장 폭", "개", "국내 상장 보통주", "직전 거래일 대비 상승 종목수", NEEDS_UNIVERSE),
    ("decliners", "하락 종목수", "시장 폭", "개", "국내 상장 보통주", "직전 거래일 대비 하락 종목수", NEEDS_UNIVERSE),
    ("new_high52", "52주 신고가 종목수", "시장 폭", "개", "국내 상장 보통주", "52주 신고가를 기록한 종목수", NEEDS_UNIVERSE),
    ("new_low52", "52주 신저가 종목수", "시장 폭", "개", "국내 상장 보통주", "52주 신저가를 기록한 종목수", NEEDS_UNIVERSE),
    ("above_ma20", "20일선 상회 비율", "시장 폭", "%", "국내 상장 보통주", "수정주가가 20거래일 이동평균 위에 있는 비율", NEEDS_UNIVERSE),
    ("above_ma60", "60일선 상회 비율", "시장 폭", "%", "국내 상장 보통주", "수정주가가 60거래일 이동평균 위에 있는 비율", NEEDS_UNIVERSE),
    ("above_ma120", "120일선 상회 비율", "시장 폭", "%", "국내 상장 보통주", "수정주가가 120거래일 이동평균 위에 있는 비율", NEEDS_UNIVERSE),
    ("above_ma200", "200일선 상회 비율", "시장 폭", "%", "국내 상장 보통주", "수정주가가 200거래일 이동평균 위에 있는 비율", NEEDS_UNIVERSE),
    ("equal_weight", "동일가중 지수", "시장 폭", "pt", "국내 상장 보통주", "동일가중 편입으로 계산한 가격지수", NEEDS_UNIVERSE),
    ("large_cap", "대형주 지수", "시장 폭", "pt", "국내 대형주", "동일 정의의 대형주 가격지수", NEEDS_SOURCE),
    ("small_cap", "소형주 지수", "시장 폭", "pt", "국내 소형주", "동일 정의의 소형주 가격지수", NEEDS_SOURCE),
    ("ttm_per", "후행 PER", "밸류에이션", "배", "국내 증시", "최근 12개월 실제 이익 기준 주가수익비율", NEEDS_SOURCE),
    ("forward_per", "선행 PER", "밸류에이션", "배", "국내 증시", "향후 12개월 컨센서스 이익 기준 주가수익비율", "시점별 기업 실적 컨센서스 이력이 필요합니다."),
    ("pbr", "PBR", "밸류에이션", "배", "국내 증시", "시장 주가순자산비율", NEEDS_SOURCE),
    ("dividend_yield", "배당수익률", "밸류에이션", "%", "국내 증시", "시장 전체 배당수익률", NEEDS_SOURCE),
    ("eps_revision", "EPS 추정치 변화", "밸류에이션", "%", "국내 증시", "시점별 주당순이익 컨센서스 수정률", "시점별 기업 실적 컨센서스 이력이 필요합니다."),
    ("futures_price", "코스피 200 선물", "파생상품", "pt", "코스피 200 선물", "대표 선물 종가", "계약 만기와 연결 기준이 검증된 이력이 필요합니다."),
    ("futures_oi", "선물 미결제약정", "파생상품", "계약", "코스피 200 선물", "미결제약정 계약 수", NEEDS_SOURCE),
    ("futures_volume", "선물 거래량", "파생상품", "계약", "코스피 200 선물", "일별 체결 계약 수", NEEDS_SOURCE),
    ("futures_net_foreign", "외국인 선물 순매수", "파생상품", "계약", "코스피 200 선물", "외국인 매수 계약 수 − 매도 계약 수", NEEDS_SOURCE),
    ("program_arb", "프로그램 차익 순매수", "투자자 수급", "억원", "코스피", "차익 프로그램 매매 순매수대금", NEEDS_SOURCE),
    ("program_nonarb", "프로그램 비차익 순매수", "투자자 수급", "억원", "코스피", "비차익 프로그램 매매 순매수대금", NEEDS_SOURCE),
    ("option_call_oi", "콜옵션 미결제약정", "파생상품", "계약", "코스피 200 옵션", "콜옵션 미결제약정 계약 수", NEEDS_SOURCE),
    ("option_put_oi", "풋옵션 미결제약정", "파생상품", "계약", "코스피 200 옵션", "풋옵션 미결제약정 계약 수", NEEDS_SOURCE),
    ("option_call_volume", "콜옵션 거래량", "파생상품", "계약", "코스피 200 옵션", "콜옵션 일별 체결 계약 수", NEEDS_SOURCE),
    ("option_put_volume", "풋옵션 거래량", "파생상품", "계약", "코스피 200 옵션", "풋옵션 일별 체결 계약 수", NEEDS_SOURCE),
):
    REGISTRY[identifier] = Indicator(label, category, unit, scope, definition, KRX, limitation=limitation)

REGISTRY.update({
    key: Indicator(category="선물옵션", source=ECOS_MARKET, frequency="monthly", expected_lag=45, **fields)
    for key, fields in DERIVATIVE_INDICATORS.items()
})
NONNEGATIVE_SERIES.update(DERIVATIVE_INDICATORS)
for key, limitation in DERIVATIVE_LIMITATIONS.items():
    REGISTRY[key] = replace(REGISTRY[key], limitation=limitation)

# Requirements differ by indicator. An unavailable advance/decline snapshot
# does not imply that a 200-session adjusted-price history is needed for it.
for key in ("advancers", "decliners"):
    REGISTRY[key] = replace(REGISTRY[key], limitation=(
        "해당 거래일의 전종목 전일대비 값과 보통주 종목구분이 필요합니다. "
        "기준일·대상 종목 수·완전성이 검증된 공개 이용 가능 스냅샷부터 누적할 수 있습니다. "
        "현재 원천이 연결되지 않아 집계하지 않았습니다."
    ))
for key in ("new_high52", "new_low52"):
    REGISTRY[key] = replace(REGISTRY[key], limitation=(
        "거래일별 보통주 목록과 분할·병합 등을 반영한 52주 수정주가 이력이 필요합니다. "
        "현재 종목 목록을 과거에 소급하거나 지수 신고가로 대체하지 않습니다."
    ))
for length in (20, 60, 120, 200):
    key = f"above_ma{length}"
    REGISTRY[key] = replace(REGISTRY[key], limitation=(
        f"해당일 보통주 목록과 종목별 {length}거래일 수정주가가 필요합니다. "
        "자료가 충분한 종목 수와 전체 대상 수를 확인해야 하며, 누락 종목을 하락·보합으로 채우지 않습니다. "
        "현재 공개 이용 가능한 전종목 이력이 연결되지 않았습니다."
    ))
REGISTRY["equal_weight"] = replace(REGISTRY["equal_weight"], limitation=(
    "시점별 편입 종목·수정주가와 동일가중 재조정 기준이 필요합니다. "
    "현재 상장 종목만 과거에 적용하거나 시가총액가중 지수를 동일가중으로 표시하지 않습니다."
))
for key in ("large_cap", "small_cap"):
    REGISTRY[key] = replace(REGISTRY[key], limitation=(
        "같은 지수 체계의 규모별 지수와 공개 이용 가능한 이력이 필요합니다. "
        "연결된 ECOS 주식시장 일·월 통계에는 해당 규모별 지수가 없어 코스피·코스닥으로 대체하지 않습니다."
    ))
for key in ("institution_net", "individual_net"):
    REGISTRY[key] = replace(REGISTRY[key], limitation=(
        "기존 보관 일별 이력을 유지합니다. ECOS 일별 주식시장 통계에는 이 투자자 구분이 없어 "
        "새 일별 관측을 연결하지 못했습니다. ECOS 월별 공표 수급은 별도 계열로 제공합니다."
    ))


LEGACY_FILES = {
    "kospi_kosdaq.json": {"kospi": "kospi", "kosdaq": "kosdaq"},
    "investor_flow.json": {key: key for key in ("foreign_net", "institution_net", "individual_net")},
    "fx.json": {"usdkrw": "usd_krw", "eurkrw": "eur_krw", "jpykrw100": "jpy_krw", "cnykrw": "cny_krw"},
    "us10y.json": {"us10y": "yield"},
    "margin_balance.json": {"credit_kospi": "kospi_margin", "credit_kosdaq": "kosdaq_margin"},
    "investor_deposit.json": {"deposit": "deposit"},
    "reverse_trade.json": {"forced_sales": "amount"},
}


class CollectionError(Exception):
    """A public, sanitized description for a source failure."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def finite_number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(str(value).strip().replace(",", ""))
    except (ValueError, TypeError):
        return None
    return number if math.isfinite(number) else None


def period_end(value, frequency):
    if frequency == "monthly":
        year, month = int(value[:4]), int(value[4:])
    elif frequency == "quarterly":
        year, month = int(value[:4]), int(value[5:]) * 3
    else:
        return date.fromisoformat(value)
    return date(year, month, calendar.monthrange(year, month)[1])


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def read_json(path, default):
    if not path.exists():
        return default
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def same_definition(key, spec, series):
    source = series.get("source") or {}
    return (
        series.get("id") == key
        and source.get("name") == spec.source.name
        and source.get("url") == spec.source.url
        and all(series.get(field) == getattr(spec, field)
                for field in ("unit", "frequency", "scope", "definition"))
    )


class Dashboard:
    def __init__(self, directory=DATA, now=None):
        self.directory = directory
        self.now = now or datetime.now(KST)
        self.today = self.now.astimezone(KST).date()
        self.at = self.now.isoformat(timespec="seconds")
        previous = read_json(directory / "dashboard.json", {})
        self.observations = {key: {} for key in REGISTRY}
        self.attempts = {}
        self.failed_keys = set()
        self.diagnostics = {}
        historical_diagnostics = {item["id"]: item for item in previous.get("diagnostics", [])}
        self.seed_legacy()
        for key, series in previous.get("series", {}).items():
            spec = REGISTRY.get(key)
            if spec is None or not same_definition(key, spec, series):
                continue
            for point in series.get("points", []):
                self.put(key, point["date"], point["value"], point["collectedAt"], point["availableAt"])
            self.attempts[key] = (series.get("lastAttemptAt"), series.get("error"))
            if key in historical_diagnostics:
                self.diagnostics[key] = historical_diagnostics[key]

    def seed_legacy(self):
        for filename, mapping in LEGACY_FILES.items():
            for row in read_json(self.directory / filename, []):
                for key, field in mapping.items():
                    self.put(key, row.get("date"), row.get(field), collected_at=None)

    def put(self, key, observed, value, collected_at, available_at=None):
        try:
            observed = date.fromisoformat(observed)
        except (TypeError, ValueError):
            return
        value = finite_number(value)
        if observed > self.today or value is None:
            return
        day = observed.isoformat()
        previous = self.observations[key].get(day)
        if previous and previous["value"] == value and (previous["collectedAt"] or not collected_at):
            return
        self.observations[key][day] = {
            "date": day, "value": value, "availableAt": available_at, "collectedAt": collected_at,
        }

    def since(self, key, backfill):
        history_start = date(2016, 1, 1)
        if backfill or not self.observations[key]:
            return history_start
        revision_days = {"daily": 45, "monthly": 550, "quarterly": 1100}[REGISTRY[key].frequency]
        latest = date.fromisoformat(max(self.observations[key]))
        return max(history_start, latest - timedelta(days=revision_days))

    def success(self, key, observations):
        if not observations:
            raise CollectionError("no_observations", "조회 기간에 유효한 관측값이 없습니다.")
        verified = {}
        for day, raw_value in observations:
            try:
                observed = date.fromisoformat(day)
            except (TypeError, ValueError):
                raise CollectionError("invalid_date", "관측일을 확인할 수 없습니다.") from None
            if observed > self.today:
                raise CollectionError("invalid_date", "미래 관측일을 게시할 수 없습니다.")
            value = finite_number(raw_value)
            if (value is None or (key in POSITIVE_SERIES and value <= 0)
                    or (key in NONNEGATIVE_SERIES and value < 0)):
                raise CollectionError("invalid_value", "관측값이 지표의 단위 또는 허용 범위와 맞지 않습니다.")
            iso_day = observed.isoformat()
            if iso_day in verified and verified[iso_day] != value:
                raise CollectionError("ambiguous_rows", "동일 관측일에 서로 다른 값이 반환됐습니다.")
            verified[iso_day] = value
        for observed, value in verified.items():
            self.put(key, observed, value, collected_at=self.at)
        self.attempts[key] = (self.at, None)
        self.failed_keys.discard(key)
        self.diagnostics.pop(key, None)

    def failure(self, key, error):
        self.attempts[key] = (self.at, str(error))
        self.failed_keys.add(key)
        self.diagnostics[key] = {"id": key, "code": error.code, "message": str(error), "at": self.at}

    def combine(self, key, first, second, formula):
        left, right = self.observations[first], self.observations[second]
        for day in left.keys() & right.keys():
            collected = [p["collectedAt"] for p in (left[day], right[day]) if p["collectedAt"]]
            available = [p["availableAt"] for p in (left[day], right[day]) if p["availableAt"]]
            self.put(
                key, day, round(formula(left[day]["value"], right[day]["value"]), 6),
                collected_at=max(collected, default=None),
                available_at=max(available) if len(available) == 2 else None,
            )
        attempts = [self.attempts[source] for source in (first, second) if source in self.attempts]
        self.attempts[key] = (
            max((at for at, _ in attempts if at), default=None),
            "구성 지표 중 갱신에 실패한 출처가 있습니다." if any(error for _, error in attempts) else None,
        )

    def write(self):
        series = {}
        catalog = []
        for key, spec in REGISTRY.items():
            points = sorted(self.observations[key].values(), key=lambda point: point["date"])
            as_of = points[-1]["date"] if points else None
            attempt_at, error = self.attempts.get(key, (None, None))
            if not as_of:
                status = "missing"
            elif error or (self.today - date.fromisoformat(as_of)).days > spec.expected_lag:
                status = "delayed"
            # Weekend display is an approximation; collection failures take precedence.
            elif spec.frequency == "daily" and self.today.weekday() >= 5 and as_of < self.today.isoformat():
                status = "closed"
            else:
                status = "current"
            series[key] = {
                "id": key, "label": spec.label, "unit": spec.unit, "frequency": spec.frequency,
                "scope": spec.scope, "definition": spec.definition, "source": vars(spec.source).copy(),
                "points": points, "asOf": as_of,
                "collectedAt": points[-1]["collectedAt"] if points else None,
                "lastAttemptAt": attempt_at, "status": status,
                "expectedLagDays": spec.expected_lag, "error": error,
            }
            catalog.append({
                "id": key, "label": spec.label, "category": spec.category, "unit": spec.unit,
                "definition": spec.definition, "sourceUrl": spec.source.url, "access": spec.source.access,
                "license": spec.source.license, "frequency": spec.frequency,
                "available": bool(points), "status": status, "limitation": spec.limitation or (
                    "아직 이 출처에서 성공적으로 수집한 관측값이 없습니다." if not points else ""
                ),
            })
        payload = {
            "schemaVersion": 1, "generatedAt": self.at, "series": series,
            "catalog": catalog, "diagnostics": list(self.diagnostics.values()),
        }
        atomic_json(self.directory / "dashboard.json", payload)
        return payload
