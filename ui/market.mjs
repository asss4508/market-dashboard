import { koreaDate, toDay, valid } from "./dom.mjs";

export const PAGES = {
  overview: { label: "전체 개요", description: "지금의 시장 판단과 그 근거, 판단이 달라질 조건을 먼저 확인합니다." },
  flows: { label: "투자자 수급", description: "코스피·코스닥의 기관, 외국인, 개인 순매수 흐름과 거래대금을 비교합니다." },
  liquidity: { label: "유동성", description: "예탁금, 신용융자, 반대매매로 시장 자금과 레버리지 흐름을 확인합니다." },
  breadth: { label: "시장확산도", description: "상승·하락 종목 수, 신고·신저가, 이동평균 상회 비율과 규모별 지수를 비교합니다." },
  valuation: { label: "밸류에이션", description: "이익과 순자산 대비 가격, 배당수익률, 이익 전망의 변화를 확인합니다." },
  derivatives: { label: "선물·옵션", description: "코스피 200 선물, 옵션, 프로그램매매와 변동성의 흐름을 관찰합니다." },
  macro: { label: "매크로", description: "환율, 국채·회사채 금리, 통화량과 주식시장의 관계를 확인합니다." },
  backtest: { label: "백테스트", description: "지표 조건이 성립한 날 이후 코스피 수익률 분포와 표본을 확인합니다." },
  etf: { label: "ETF 변화", description: "코스닥 액티브 ETF 5종의 공표 기준일별 구성 종목과 비중을 비교합니다." },
  charts: { label: "전체 차트", description: "지수, 신용융자, 예탁금, 반대매매, 투자자 수급, 미국채, 환율 차트를 모았습니다." },
};

export const FX = ["usdkrw", "eurkrw", "jpykrw100", "cnykrw"];
export const FLOWS = ["institution_net", "foreign_net", "individual_net"];
export const CREDIT = ["credit_kospi", "credit_kosdaq"];
export const HEADLINES = [
  ["kospi", "코스피", 1],
  ["kosdaq", "코스닥", 2],
  ["usdkrw", "원/달러", 3],
  ["vkospi", "VKOSPI", 4],
  ["kr3y", "국고채 3년", 5],
  ["kr10y", "국고채 10년", 6],
];

export const SCORE_LABELS = { overheat: "과열", stress: "스트레스", momentum: "모멘텀" };

export function comparisonLabel(currentDate, previousDate, frequency) {
  const current = /^(\d{4})-(\d{2})-(\d{2})$/.exec(currentDate || "");
  const previous = /^(\d{4})-(\d{2})-(\d{2})$/.exec(previousDate || "");
  if (!previous) return "비교 기준일 없음";
  if (frequency === "monthly" && current) {
    const months = (Number(current[1]) - Number(previous[1])) * 12 + Number(current[2]) - Number(previous[2]);
    if (months === 1) return "전월 대비";
    return previous[1] + "." + previous[2] + " 대비";
  }
  const year = current && current[1] === previous[1] ? "" : previous[1] + ".";
  return year + previous[2] + "." + previous[3] + " 대비";
}

const krx = { name: "한국거래소 · 기존 보관 이력", url: "https://data.krx.co.kr/", access: "기존 보관 이력" };
const kofia = { name: "금융투자협회", url: "https://freesis.kofia.or.kr/", access: "기존 공개 통계" };
const ecos = { name: "한국은행 ECOS", url: "https://ecos.bok.or.kr/", access: "기존 ECOS 통계" };
const fred = { name: "FRED", url: "https://fred.stlouisfed.org/series/DGS10", access: "FRED DGS10" };
const legacy = [
  ["kospi_kosdaq", krx, 4, [["kospi", "코스피", "pt", "코스피"], ["kosdaq", "코스닥", "pt", "코스닥"]]],
  ["margin_balance", kofia, 7, [["credit_kospi", "코스피 신용융자", "조원", "코스피", "kospi_margin"],
    ["credit_kosdaq", "코스닥 신용융자", "조원", "코스닥", "kosdaq_margin"]]],
  ["investor_deposit", kofia, 7, [["deposit", "투자자예탁금", "조원", "국내 증시"]]],
  ["reverse_trade", kofia, 7, [["forced_sales", "반대매매 금액", "억원", "국내 증시", "amount"]]],
  ["investor_flow", krx, 4, [["institution_net", "기관 순매수", "억원", "코스피+코스닥"],
    ["foreign_net", "외국인 순매수", "억원", "코스피+코스닥"], ["individual_net", "개인 순매수", "억원", "코스피+코스닥"]]],
  ["us10y", fred, 7, [["us10y", "미 국채 10년", "%", "미국 국채", "yield"]]],
  ["fx", ecos, 4, [["usdkrw", "원/달러", "원", "미국 달러 1단위", "usd_krw"], ["eurkrw", "원/유로", "원", "유로 1단위", "eur_krw"],
    ["jpykrw100", "원/엔(100엔)", "원", "일본 엔 100단위", "jpy_krw"], ["cnykrw", "원/위안", "원", "중국 위안 1단위", "cny_krw"]]],
];

export async function fetchData(path, validate) {
  try {
    const response = await fetch(path, { cache: "no-cache" });
    if (!response.ok) throw new Error(String(response.status));
    const value = await response.json();
    if (!validate(value)) throw new Error("schema");
    return { value, error: null };
  } catch (error) {
    const code = error.message;
    return { value: null, error: path.split("/").at(-1) + "을(를) 불러오지 못했습니다."
      + (/^\d{3}$/.test(code) ? " (HTTP " + code + ")" : "") };
  }
}

export async function loadOriginalData() {
  const results = await Promise.all(legacy.map(([file]) => fetchData("data/" + file + ".json", Array.isArray)));
  const fallback = { schemaVersion: 1, generatedAt: null, series: {}, catalog: [], diagnostics: [] };
  const today = toDay(koreaDate());
  for (const [index, [file, source, expectedLagDays, specs]] of legacy.entries()) {
    const { value, error } = results[index];
    for (const [id, label, unit, scope, key = id] of specs) {
      const points = (value || []).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && valid(row[key]))
        .map((row) => ({ date: row.date, value: row[key], availableAt: null, collectedAt: null }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const asOf = points.at(-1)?.date || null;
      const status = asOf ? (today - toDay(asOf) > expectedLagDays ? "delayed" : "current") : "missing";
      const definition = scope + " · 기존 일별 자료";
      fallback.series[id] = { id, label, unit, frequency: "daily", scope, definition, source,
        points, asOf, status, expectedLagDays, collectedAt: null, lastAttemptAt: null, error };
      fallback.catalog.push({ id, label, unit, status, sourceUrl: source.url, category: "기존 차트",
        definition, access: source.access, limitation: error || "기존 보관 자료", available: points.length > 0 });
    }
    if (error) fallback.diagnostics.push({ id: file, code: "load_failed", message: error, at: null });
  }
  return fallback;
}

export function selectIndex(dashboard, prefix) {
  const variants = [prefix, prefix + "_ecos", prefix + "_naver", prefix + "_yahoo"]
    .map((id) => dashboard.series[id]).filter((line) => line?.points?.length);
  const long = variants.filter((line) => line.points.length >= 252);
  const candidates = long.length ? long : variants;
  return candidates.sort((a, b) => (b.asOf || "").localeCompare(a.asOf || "") || b.points.length - a.points.length)[0]?.id || prefix;
}

export function flowLine(line, length, cumulative = false) {
  if (!line?.points?.length) return [];
  let total = 0;
  return line.points.map((point, index, rows) => {
    total += point.value;
    if (index >= length) total -= rows[index - length].value;
    const value = index + 1 >= length ? total : null;
    return { date: point.date, value: cumulative ? total : value };
  });
}
