"""Verified ECOS derivative statistics and explicit gaps in daily coverage.

ECOS StatisticItemList tables 901Y057 and 901Y058 were checked on 2026-11-27.
Daily-average observations below are published MONTHLY, not daily history.
The FSC derivatives/index APIs are deliberately not public fallback sources:
https://www.data.go.kr/data/15094802/openapi.do
https://www.data.go.kr/data/15094807/openapi.do
Both prohibit unauthorized redistribution to third parties.
"""


# Table, item, divisor. ECOS monetary observations use millions of KRW;
# divide by 1,000,000 to publish trillions of KRW.
ECOS_DERIVATIVE_SERIES = {
    "index_futures_daily_average_monthly": ("901Y057", "S25B", 1),
    "index_futures_notional_monthly": ("901Y057", "S25C", 1_000_000),
    "index_option_call_daily_average_monthly": ("901Y058", "S26BB", 1),
    "index_option_put_daily_average_monthly": ("901Y058", "S26CB", 1),
    "index_option_call_turnover_monthly": ("901Y058", "S26BC", 1_000_000),
    "index_option_put_turnover_monthly": ("901Y058", "S26CC", 1_000_000),
}

ECOS_DERIVATIVE_UNITS = {
    "index_futures_daily_average_monthly": "계약",
    "index_futures_notional_monthly": "백만원",
    "index_option_call_daily_average_monthly": "계약",
    "index_option_put_daily_average_monthly": "계약",
    "index_option_call_turnover_monthly": "백만원",
    "index_option_put_turnover_monthly": "백만원",
}

MONTHLY_AVERAGE_LIMITATION = (
    "해당 월의 거래일당 평균 거래량을 월별로 공표한 통계입니다. "
    "일별 관측값이나 미결제약정이 아니며 상품별·만기별 구성은 제공되지 않습니다."
)

DERIVATIVE_INDICATORS = {
    "index_futures_daily_average_monthly": {
        "label": "주가지수선물 일평균 거래량 · 월", "unit": "계약",
        "scope": "주가지수선물 합계",
        "definition": "ECOS 월별 공표 주가지수선물 거래일당 평균 계약수",
        "limitation": MONTHLY_AVERAGE_LIMITATION,
    },
    "index_futures_notional_monthly": {
        "label": "주가지수선물 계약금액 · 월", "unit": "조원",
        "scope": "주가지수선물 합계",
        "definition": "ECOS 주가지수선물 월별 계약금액(백만원을 조원으로 변환)",
        "limitation": "선물 계약의 명목금액입니다. 증거금·투입자금·미결제약정 금액이 아니며 상품별·만기별 구성은 제공되지 않습니다.",
    },
    "index_option_call_daily_average_monthly": {
        "label": "주가지수 콜옵션 일평균 거래량 · 월", "unit": "계약",
        "scope": "주가지수옵션 합계",
        "definition": "ECOS 월별 공표 주가지수 CALL 옵션 거래일당 평균 계약수",
        "limitation": MONTHLY_AVERAGE_LIMITATION,
    },
    "index_option_put_daily_average_monthly": {
        "label": "주가지수 풋옵션 일평균 거래량 · 월", "unit": "계약",
        "scope": "주가지수옵션 합계",
        "definition": "ECOS 월별 공표 주가지수 PUT 옵션 거래일당 평균 계약수",
        "limitation": MONTHLY_AVERAGE_LIMITATION,
    },
    "index_option_call_turnover_monthly": {
        "label": "주가지수 콜옵션 거래대금 · 월", "unit": "조원",
        "scope": "주가지수옵션 합계",
        "definition": "ECOS 주가지수 CALL 옵션 월별 거래대금(백만원을 조원으로 변환)",
        "limitation": "월별 옵션 거래대금입니다. 매수·매도 방향이나 투자자별 포지션을 나타내지 않습니다.",
    },
    "index_option_put_turnover_monthly": {
        "label": "주가지수 풋옵션 거래대금 · 월", "unit": "조원",
        "scope": "주가지수옵션 합계",
        "definition": "ECOS 주가지수 PUT 옵션 월별 거래대금(백만원을 조원으로 변환)",
        "limitation": "월별 옵션 거래대금입니다. 매수·매도 방향이나 투자자별 포지션을 나타내지 않습니다.",
    },
    "index_option_turnover_pcr_monthly": {
        "label": "주가지수옵션 거래대금 P/C · 월", "unit": "배",
        "scope": "주가지수옵션 합계",
        "definition": "같은 기준월 ECOS PUT 옵션 거래대금 / CALL 옵션 거래대금",
        "limitation": "월별 풋/콜 거래대금 비율입니다. 계약수 P/C·미결제약정 P/C·일별 P/C와 구분하며 딜러 포지션을 추정하지 않습니다.",
    },
}

_DAILY_RIGHTS = (
    "금융위원회·KRX 일별 원천은 제3자 공개 재배포 승인이 필요합니다. "
    "개인 API 이용 승인만으로 공개 사이트에 제공할 수 없습니다. "
)

DERIVATIVE_LIMITATIONS = {
    "vkospi": _DAILY_RIGHTS + "연결된 ECOS 통계에는 VKOSPI가 없어 일별 실현변동성이나 옵션 거래량으로 대체하지 않습니다.",
    "futures_price": _DAILY_RIGHTS + "종목별 시가·고가·저가·종가와 계약 만기·연결 기준도 필요합니다. 월별 거래량은 가격을 대체하지 못합니다.",
    "futures_oi": _DAILY_RIGHTS + "동일 상품·만기의 미결제약정이 필요합니다. ECOS 월별 계약수는 거래량이므로 미결제약정으로 사용하지 않습니다.",
    "futures_volume": _DAILY_RIGHTS + "ECOS는 주가지수선물 합계의 월별 거래량·일평균만 제공하여 코스피 200 선물의 일별 거래량과 구분합니다.",
    "futures_net_foreign": _DAILY_RIGHTS + "투자자 구분별 일별 매수·매도 계약수가 필요합니다. 전체 거래량으로 외국인 순매수를 추정하지 않습니다.",
    "option_call_oi": _DAILY_RIGHTS + "콜옵션의 동일 상품·만기·행사가별 미결제약정이 필요합니다. 월별 체결 계약수로 보유 포지션을 추정하지 않습니다.",
    "option_put_oi": _DAILY_RIGHTS + "풋옵션의 동일 상품·만기·행사가별 미결제약정이 필요합니다. 월별 체결 계약수로 보유 포지션을 추정하지 않습니다.",
    "option_call_volume": _DAILY_RIGHTS + "ECOS 콜옵션 월별 거래량·일평균은 주가지수옵션 합계이며 코스피 200 옵션 일별 거래량과 범위·주기가 다릅니다.",
    "option_put_volume": _DAILY_RIGHTS + "ECOS 풋옵션 월별 거래량·일평균은 주가지수옵션 합계이며 코스피 200 옵션 일별 거래량과 범위·주기가 다릅니다.",
}


def derive_monthly_turnover_pcr(dashboard):
    """Use only matching months; a missing/zero CALL amount has no ratio."""
    # A later source revision to zero must also remove a previously valid ratio.
    dashboard.observations["index_option_turnover_pcr_monthly"] = {}
    dashboard.combine(
        "index_option_turnover_pcr_monthly",
        "index_option_put_turnover_monthly",
        "index_option_call_turnover_monthly",
        lambda put, call: put / call if call > 0 else float("nan"),
    )
