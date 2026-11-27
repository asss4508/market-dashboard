import { badge, byId, create, direction, empty, koreaDate, quantity, signed, sourceLink, timestamp, toDay, valid } from "./ui/dom.mjs";
import { chartCard, clearSharedDate, destroyPlots } from "./ui/charts.mjs";
import { renderEtf } from "./ui/etf.mjs";
import { CREDIT, FLOWS, FX, HEADLINES, PAGES, SCORE_LABELS, comparisonLabel, fetchData, flowLine, loadOriginalData, selectIndex } from "./ui/market.mjs";
import { renderBacktest, renderConclusion, renderContributors, renderCorrelations, renderMetrics, renderScores, renderSeriesTable, renderStatus } from "./ui/research-view.mjs";

const presets = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "3Y": 36, "5Y": 60, "10Y": 120, ALL: null };
const emptyDashboard = { schemaVersion: 1, generatedAt: null, series: {}, catalog: [], diagnostics: [] };
const state = {
  page: "overview", preset: "1Y", range: null, bounds: null, indexed: false,
  dashboard: emptyDashboard, etf: null, intraday: null, research: null, analytics: null,
  config: null, errors: [], etfError: null, busy: true, flowWindow: 20,
};
const allChartSpecs = [
  { key: "kospi", title: "코스피", ids: ["kospi"], technical: true },
  { key: "kosdaq", title: "코스닥", ids: ["kosdaq"], technical: true },
  { key: "margin", title: "신용거래융자 잔고", ids: CREDIT },
  { key: "deposit", title: "투자자예탁금 추이", ids: ["deposit"] },
  { key: "reverse", title: "일별 반대매매 금액", ids: ["forced_sales"] },
  { key: "flow", title: "투자자별 매매동향", ids: FLOWS, cumulative: true, subtitle: "코스피+코스닥 합산 · 조회 구간 누적 순매수" },
  { key: "us10y", title: "미국 10년물 국채금리", ids: ["us10y"] },
  { key: "fx", title: "원화 환율", ids: FX, exclusive: true },
];

function readPreference(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function setPreference(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Preferences remain available in this tab. */ }
}

const systemTheme = matchMedia("(prefers-color-scheme: dark)");
let theme = readPreference("kr-market-theme");

function renderTheme() {
  const dark = theme === "dark" || theme !== "light" && systemTheme.matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  byId("theme-icon").textContent = dark ? "☀" : "☾";
  byId("theme-label").textContent = dark ? "라이트 모드" : "다크 모드";
  byId("theme-toggle").setAttribute("aria-label", dark ? "라이트 모드로 전환" : "다크 모드로 전환");
}

function findSeries(id) {
  const { dashboard, research } = state;
  let selected = id;
  if (id === "kospi") selected = research?.benchmark?.id || selectIndex(dashboard, id);
  if (id === "kosdaq") selected = selectIndex(dashboard, id);
  return dashboard.series[selected] || dashboard.series[id];
}

function whyMissing(id) {
  const series = findSeries(id);
  const entry = state.dashboard.catalog.find((item) => item.id === (series?.id || id));
  return series?.error || entry?.limitation || "검증된 관측치를 확보하지 못했습니다.";
}

function appendHeadline(id, label) {
  const series = findSeries(id);
  const current = series?.points?.at(-1);
  const previous = series?.points?.at(-2);
  const tile = create("article", { className: "market-tile", "data-series": id, "aria-label": label });
  const dataStatus = current ? series.status : "missing";
  tile.append(create("div", { className: "tile-top" }, create("h2", { className: "tile-name", text: label }),
    dataStatus !== "current" && badge(dataStatus || "missing")));
  const value = current ? quantity(current.value) : "N/A";
  tile.append(create("p", { className: "tile-value" }, value, current?.value != null && series.unit && create("small", { text: " " + series.unit })));
  if (current && previous) {
    const amount = current.value - previous.value;
    const change = series.unit === "%" ? signed(amount, "%p", 3)
      : previous.value ? signed(amount / previous.value * 100, "%") : signed(amount, series.unit);
    const mark = amount > 0 ? "▲ " : amount < 0 ? "▼ " : "";
    const comparison = comparisonLabel(current.date, previous.date, series.frequency);
    tile.append(create("p", { className: "tile-move " + direction(amount), title: "비교 기준일 " + previous.date + " → " + current.date,
      text: (change === "0%" || amount === 0 ? "보합" : mark + change) + " · " + comparison }));
  } else {
    tile.append(create("p", { className: "tile-missing", text: current ? "비교 관측치 없음" : whyMissing(id), title: whyMissing(id) }));
  }
  tile.append(create("div", { className: "tile-meta" },
    create("span", { text: current?.date ? current.date + " 기준" : "관측일 N/A" }),
    series?.source && sourceLink(series.source.name, series.source.url)));
  return tile;
}

function actualLine(id, index, spec) {
  const line = findSeries(id);
  const points = spec.points?.[id] || line?.points || [];
  const isFx = spec.exclusive;
  const labels = { eurkrw: "원/유로", jpykrw100: "원/엔(100엔)", cnykrw: "원/위안" };
  return {
    ...line, id, points, color: spec.colors?.[index] || index + 1,
    label: spec.labels?.[id] || (isFx && labels[id]) || line?.label || id,
    cumulative: spec.cumulative,
    hidden: isFx && index > 0,
  };
}

function normalizeChartSpec(spec) {
  const sources = spec.ids || [];
  const data = spec.lines || sources.map((id, index) => actualLine(id, index, spec));
  if (spec.exclusive && data.filter((line) => line.points.length).every((line) => line.hidden)) {
    const first = data.find((line) => line.points.length);
    if (first) first.hidden = false;
  }
  const reasons = [...new Set(sources.filter((id) => !findSeries(id)?.points?.length).map(whyMissing))];
  const limitations = data.flatMap((line) => {
    if (line.error) return [line.label + " · " + line.error];
    if (line.status === "delayed" && line.asOf) return [line.label + " · " + line.asOf + " 이후 새 관측 미확보"];
    if (!line.points.length && sources.includes(line.id)) return [line.label + " N/A"];
    return [];
  });
  return {
    ...spec, lines: data,
    missing: spec.missing || (reasons.length ? "N/A · " + reasons.join(" ") : null),
    footnote: [spec.footnote, ...limitations].filter(Boolean).join(" · "),
  };
}

function chart(spec) {
  const view = { range: state.range, indexed: state.indexed };
  return chartCard(normalizeChartSpec(spec), {
    view, technical: state.analytics, dialog: openDialog, onZoom: applyCustomRange,
  });
}

function spec(key, title, ids, options = {}) {
  return { key, title, ids, ...options };
}

function featureCharts(key, title, ids, options = {}) {
  const chartLines = (state.research?.features || []).filter((item) => ids.includes(item.id)).map((item, index) => ({
    id: item.id, label: item.label, points: item.history || [], unit: item.unit, color: index + 1,
  }));
  return chart({ key, title, lines: chartLines, ...options });
}

function overview() {
  const featureIds = ["rsi", "disparity60", "rv20", "trend200", "momentum20", "creditDeposit", "foreign20", "institution20"];
  return [
    renderConclusion(state.research, { freshness: freshnessNotice() }),
    chart(spec("overview-kospi", "코스피 종가", ["kospi"], { hero: true, span: "span-8", technical: true })),
    renderScores(state.research),
    chart(spec("overview-fx", "주요 원화 환율", FX, { exclusive: true, span: "span-12" })),
    renderContributors(state.research),
    renderMetrics("시장 핵심 통계", state.research?.features || [], featureIds),
  ];
}

function flows() {
  const width = state.flowWindow;
  const periods = create("div", { className: "segmented", role: "group", "aria-label": "누적 기간" });
  for (const days of [5, 20, 60]) {
    const option = create("button", { type: "button", text: days + "일", "aria-pressed": String(width === days) });
    option.addEventListener("click", () => {
      state.flowWindow = days;
      renderView();
      byId("flow-window").querySelector('[aria-pressed="true"]')?.focus();
    });
    periods.append(option);
  }
  const panel = create("article", { className: "card card-pad span-12 action-row", id: "flow-window" },
    create("h3", { text: "이동 누적 기간" }), periods);
  const points = Object.fromEntries(FLOWS.map((id) => [id, flowLine(findSeries(id), width)]));
  const turnoverIds = ["kospi_turnover", "kosdaq_turnover"];
  const capIds = ["kospi_marketcap", "kosdaq_marketcap"];
  const foreignEcos = ["foreign_net_ecos", "foreign_net_kospi", "foreign_net_kosdaq"].filter((id) => findSeries(id));
  return [
    chart(spec("flow-daily", "일별 순매수", FLOWS, { allowIndexed: false, subtitle: "코스피+코스닥 합산" })),
    chart(spec("flow-cumulative", "조회 구간 누적 순매수", FLOWS, { cumulative: true, subtitle: "코스피+코스닥 합산" })),
    panel,
    chart(spec("flow-rolling", width + "거래일 이동 누적 순매수", FLOWS, { points, allowIndexed: false, subtitle: "코스피+코스닥 합산" })),
    chart(spec("flow-turnover", "시장별 거래대금", turnoverIds)),
    foreignEcos.length ? chart(spec("flow-ecos", "외국인 순매수 · ECOS", foreignEcos, { allowIndexed: false, span: "span-12" })) : null,
    renderSeriesTable("수급·거래 자료", [...FLOWS, ...foreignEcos, ...turnoverIds, ...capIds], state.dashboard),
    renderMetrics("수급 분포", state.research?.features || [],
      ["foreign20", "institution20", "individual20", "foreign20Turnover", "institution20Turnover"]),
  ];
}

function liquidity() {
  return [
    chart(spec("liquidity-deposit", "투자자예탁금", ["deposit"])),
    chart(spec("liquidity-margin", "신용거래융자 잔고", CREDIT)),
    chart(spec("liquidity-forced", "일별 반대매매 금액", ["forced_sales"])),
    featureCharts("liquidity-leverage", "신용융자 / 투자자예탁금", ["creditDeposit"]),
    chart(spec("liquidity-cma", "CMA·MMF 잔고", ["cma", "mmf"])),
    renderSeriesTable("유동성 자료", ["deposit", ...CREDIT, "forced_sales", "cma", "mmf", "kr_m2", "kr_rp"], state.dashboard),
    renderMetrics("유동성 분포", state.research?.features || [], ["creditGrowth20", "creditDeposit", "forcedSales5"]),
  ];
}

function breadth() {
  const counts = ["advancers", "decliners", "new_high52", "new_low52"];
  const average = ["above_ma20", "above_ma60", "above_ma120", "above_ma200"];
  const indices = ["equal_weight", "large_cap", "small_cap"];
  return [
    chart(spec("breadth-advance", "상승·하락 종목 수", counts.slice(0, 2))),
    chart(spec("breadth-high-low", "52주 신고가·신저가", counts.slice(2))),
    chart(spec("breadth-ma", "이동평균 상회 비율", average)),
    chart(spec("breadth-index", "동일가중·규모별 지수", indices)),
    renderSeriesTable("시장확산도 자료", [...counts, ...average, ...indices], state.dashboard),
  ];
}

function valuations() {
  const multiples = ["ttm_per", "forward_per", "pbr"];
  const rates = ["dividend_yield", "eps_revision"];
  const monthlyPer = "kospi_per_monthly";
  const monthlyDividend = "kospi_dividend_monthly";
  const monthlySubtitle = "ECOS 월별 공표 · 관측일은 보고월 말일";
  return [
    chart(spec("valuation-monthly-per", "월별 코스피 공표 PER", [monthlyPer], {
      subtitle: monthlySubtitle, footnote: "ECOS 공표값을 표시합니다. 세부 PER 산정 기준은 확인이 필요합니다.",
    })),
    chart(spec("valuation-monthly-dividend", "월별 코스피 공표 배당수익률", [monthlyDividend], { subtitle: monthlySubtitle })),
    renderSeriesTable("코스피 월별 공표 밸류에이션", [monthlyPer, monthlyDividend], state.dashboard),
    chart(spec("valuation-multiples", "PER · PBR", multiples)),
    chart(spec("valuation-rates", "배당수익률 · 이익 전망 변화", rates)),
    renderSeriesTable("밸류에이션 자료", [...multiples, ...rates], state.dashboard),
  ];
}

function derivatives() {
  const price = ["futures_price", "kospi200"];
  const oi = ["futures_oi", "futures_volume", "futures_net_foreign"];
  const options = ["option_call_oi", "option_put_oi", "option_call_volume", "option_put_volume"];
  const program = ["program_arb", "program_nonarb"];
  const monthlyFutures = "index_futures_volume_monthly";
  const monthlyOptions = ["index_option_call_volume_monthly", "index_option_put_volume_monthly"];
  const monthlyPcr = "index_option_volume_pcr_monthly";
  const monthlyVolume = {
    span: "span-4",
    subtitle: "ECOS 월별 체결 계약 수 · 만기 구분 없이 공표",
    footnote: "관측일은 보고월 말일입니다. 미결제약정은 별도 항목에서 확인할 수 있습니다.",
  };
  return [
    chart(spec("derivatives-monthly-futures", "월별 주가지수선물 거래량", [monthlyFutures], monthlyVolume)),
    chart(spec("derivatives-monthly-options", "월별 주가지수옵션 콜·풋 거래량", monthlyOptions, monthlyVolume)),
    chart(spec("derivatives-monthly-pcr", "월별 주가지수옵션 거래량 PCR", [monthlyPcr], {
      span: "span-4", allowIndexed: false,
      subtitle: "같은 달 풋 체결 계약 수 ÷ 콜 체결 계약 수",
      footnote: "관측일은 보고월 말일입니다. 월별 합계는 만기 구분 없이 공표됩니다.",
    })),
    renderSeriesTable("주가지수선물·옵션 월별 거래량", [monthlyFutures, ...monthlyOptions, monthlyPcr], state.dashboard),
    chart(spec("derivatives-price", "코스피 200 현물과 선물", price)),
    chart(spec("derivatives-oi", "선물 거래량·미결제약정·외국인 순매수", oi)),
    chart(spec("derivatives-oi-options", "콜·풋 미결제약정", options.slice(0, 2))),
    chart(spec("derivatives-vol-options", "콜·풋 거래량", options.slice(2))),
    chart(spec("derivatives-vix", "VKOSPI", ["vkospi"])),
    chart(spec("derivatives-program", "프로그램 차익 · 비차익 순매수", program, { allowIndexed: false })),
    renderSeriesTable("선물·옵션 자료", [...price, ...oi, ...options, "vkospi", ...program], state.dashboard),
  ];
}

function macro() {
  const rates = ["kr3y", "kr10y", "kr_cd91", "kr_aa3y", "kr_base_rate"];
  const us = ["us2y", "us10y"];
  const spreads = ["kr_term_spread", "kr_credit_spread", "kr_us10y_spread", "kr_cds"];
  const conditions = ["kr_m2", "kr_rp", "kr_cpi", "kr_gdp", "dxy", "usd_broad"];
  const known = (ids) => ids.filter((id) => state.dashboard.series[id]);
  return [
    chart(spec("macro-fx", "원화 환율", FX, { exclusive: true })),
    chart(spec("macro-dollar", "달러 지수", known(["dxy", "usd_broad"]))),
    chart(spec("macro-rates", "국내 금리", rates)),
    chart(spec("macro-usrates", "미국 국채금리", us)),
    chart(spec("macro-spread", "장단기·신용·한미 금리차", known(spreads), { allowIndexed: false })),
    chart(spec("macro-m2", "통화량 M2", ["kr_m2"])),
    renderCorrelations(state.research?.correlations || [], state.research?.features || []),
    renderSeriesTable("매크로 자료", [...FX, ...rates, ...us, ...known(spreads), ...known(conditions)], state.dashboard),
    renderMetrics("매크로 분포", state.research?.features || [], ["fxChange20", "creditSpread", "rv20"]),
  ];
}

const pagesById = {
  overview, flows, liquidity, breadth, valuation: valuations, derivatives, macro,
  backtest: () => renderBacktest(state.research, {}, true),
  etf: () => renderEtf(state.etf, state.etfError),
  charts: () => allChartSpecs.map(chart),
};

function renderView() {
  const panel = byId("view");
  destroyPlots(panel);
  clearSharedDate();
  const page = PAGES[state.page];
  byId("page-title").textContent = page.label;
  byId("page-description").textContent = page.description;
  panel.setAttribute("aria-labelledby", "tab-" + state.page);
  panel.setAttribute("aria-busy", String(state.busy));
  byId("time-toolbar").hidden = state.page === "etf" || state.page === "backtest";
  byId("scale-mode").hidden = byId("time-toolbar").hidden;
  byId("config-open").hidden = state.page !== "overview" && state.page !== "backtest";
  byId("view-modes").hidden = byId("scale-mode").hidden && byId("config-open").hidden;
  if (state.busy) {
    const waiting = empty("데이터를 불러오는 중입니다.");
    waiting.classList.add("span-12");
    panel.replaceChildren(waiting);
  } else {
    panel.replaceChildren(...[pagesById[state.page]()].flat().filter(Boolean));
  }
  renderRangeControls();
}

function fullBounds() {
  const active = Object.values(state.dashboard.series).filter((series) => series.points.length);
  if (!active.length) return { from: koreaDate(), to: koreaDate() };
  return {
    from: active.map((line) => line.points[0].date).sort()[0],
    to: active.map((line) => line.points.at(-1).date).sort().at(-1),
  };
}

function monthCutoff(end, months) {
  const base = new Date(end + "T00:00:00Z");
  const targetMonth = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - months, 1));
  const lastDay = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)).getUTCDate();
  targetMonth.setUTCDate(Math.min(base.getUTCDate(), lastDay));
  return targetMonth.toISOString().slice(0, 10);
}

function selectRange(id) {
  if (!state.bounds) return;
  state.preset = id;
  const { from, to } = state.bounds;
  const dates = presets[id] ? [from, monthCutoff(to, presets[id])].sort() : [from];
  state.range = { from: dates.at(-1), to };
  renderView();
}

function applyCustomRange(from, to) {
  if (!state.bounds || from > to || !valid(toDay(from)) || !valid(toDay(to))) return;
  const f = from < state.bounds.from ? state.bounds.from : from;
  const t = to > state.bounds.to ? state.bounds.to : to;
  if (f > t) return;
  state.preset = null;
  state.range = { from: f, to: t };
  byId("date-form").hidden = true;
  byId("range-edit").setAttribute("aria-expanded", "false");
  renderView();
}

function renderRangeControls() {
  for (const button of byId("range-buttons").children) {
    button.setAttribute("aria-pressed", String(button.dataset.range === state.preset));
    button.disabled = !state.range;
  }
  byId("period-label").textContent = state.range ? state.range.from + " ~ " + state.range.to : "";
  byId("range-edit").disabled = !state.range;
}

function openDialog(title, content) {
  const drawer = byId("drawer");
  const body = byId("dialog-body");
  destroyPlots(body);
  byId("dialog-title").textContent = title;
  body.replaceChildren(content);
  if (!drawer.open) drawer.showModal();
}

function configFromStorage(defaults) {
  const config = structuredClone(defaults);
  let saved;
  try { saved = JSON.parse(readPreference("kr-market-weights")); } catch { return config; }
  for (const [id, weights] of Object.entries(config.weights)) {
    for (const key of Object.keys(weights)) {
      const value = saved?.[id]?.[key];
      if (valid(value) && value >= 0 && value <= 100) weights[key] = value;
    }
    if (!Object.values(weights).some((value) => value > 0)) config.weights[id] = { ...defaults.weights[id] };
  }
  return config;
}

function rebuildAnalysis() {
  if (!state.analytics || !state.config) return;
  try {
    state.research = state.analytics.buildResearch(state.dashboard, state.config);
  } catch {
    state.research = null;
    const message = "연구 지표 계산 중 오류가 발생했습니다.";
    if (!state.errors.includes(message)) state.errors.push(message);
  }
}

function openSettings() {
  if (!state.config) {
    openDialog("가중치 설정", empty("연구 모듈을 아직 불러올 수 없습니다."));
    return;
  }
  const labels = Object.fromEntries((state.research?.features || []).map((item) => [item.id, item.label]));
  const form = create("form", { className: "config-form" }, create("p", { className: "meta",
    text: "가중치는 확보된 지표 내에서 비례 적용합니다. 입력한 값은 이 브라우저에 저장됩니다." }));
  const inputs = new Map();
  for (const [id, weights] of Object.entries(state.config.weights)) {
    const grid = create("div", { className: "config-grid" });
    const values = new Map();
    for (const [key, value] of Object.entries(weights)) {
      const input = create("input", { type: "number", min: 0, max: 100, step: "any", required: true, value });
      grid.append(create("label", { className: "field" }, labels[key] || key, input));
      values.set(key, input);
    }
    inputs.set(id, values);
    form.append(create("fieldset", { className: "field-group config-section" }, create("legend", { text: SCORE_LABELS[id] || id }), grid));
  }
  const note = create("p", { className: "field-error", role: "status" });
  const reset = create("button", { type: "button", className: "button", text: "기본값 불러오기" });
  const apply = create("button", { type: "submit", className: "button primary", text: "적용" });
  form.append(note, create("div", { className: "action-row" }, apply, reset));
  reset.addEventListener("click", () => {
    for (const [id, values] of inputs) {
      for (const [key, input] of values) input.value = state.analytics.DEFAULT_CONFIG.weights[id][key];
    }
    note.textContent = "";
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const weights = {};
    for (const [id, values] of inputs) {
      weights[id] = Object.fromEntries([...values].map(([key, input]) => [key, input.valueAsNumber]));
      if (!Object.values(weights[id]).some((value) => value > 0)) {
        note.textContent = (SCORE_LABELS[id] || id) + " 점수의 가중치를 하나 이상 입력하세요.";
        return;
      }
    }
    state.config = { ...state.config, weights };
    setPreference("kr-market-weights", JSON.stringify(weights));
    rebuildAnalysis();
    byId("drawer").close();
    renderShellData();
    renderView();
  });
  openDialog("가중치 설정", form);
}

function renderMethods() {
  const notes = state.research?.notes || [];
  const node = create("div", {},
    create("h3", { text: "관측일과 데이터 가용성" }),
    create("p", { text: "시장 수치는 일별 계열의 최근 관측값입니다. 지수는 출처 하나의 이력을 사용합니다. 관측일, 시도 시각, 출처와 라이선스는 데이터 상태에서 확인할 수 있습니다." }),
    create("h3", { text: "차트 조작" }),
    create("p", { text: "차트에 마우스를 올리거나 초점을 둔 채 방향키를 눌러 공통 날짜를 비교할 수 있습니다. 드래그 확대를 켜고 차트에서 구간을 선택하면 조회 기간이 바뀝니다. 기준 100은 사용 가능한 첫 값을 100으로 환산합니다." }),
    create("h3", { text: "점수와 백테스트" }),
    create("p", { text: "점수는 확보된 지표의 과거 분포와 가중치를 이용한 시장 관측값입니다. 백테스트의 표본 수, 가용시점 가정, 불확실성 범위는 백테스트 메뉴에 있습니다." }),
    ...(Array.isArray(notes) ? notes.filter((note) => typeof note === "string").map((note) => create("p", {
      className: "meta", text: note.replaceAll("판단 보류", "분석 자료 부족").replaceAll("판단보류", "분석 자료 부족"),
    })) : []),
  );
  const status = create("button", { type: "button", className: "text-button", text: "지표별 출처 및 수집 상태" });
  status.addEventListener("click", openStatus);
  node.append(status);
  return node;
}

function openStatus() {
  openDialog("데이터 상태", renderStatus(state.dashboard, {
    errors: state.errors, intraday: state.intraday, freshness: freshnessNotice(),
  }));
}

const koreaCalendar = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" });

function freshnessNotice() {
  const today = koreaDate();
  const todayDay = toDay(today);
  const generatedAt = Date.parse(state.dashboard.generatedAt);
  const fileDate = valid(generatedAt) ? koreaCalendar.format(new Date(generatedAt)) : null;
  const indexDate = findSeries("kospi")?.points?.at(-1)?.date;
  const checks = [["파일 생성일", fileDate, 2], ["코스피 최근 관측일", indexDate, 4]];
  const aged = checks.flatMap(([label, date, limit]) => {
    const age = date ? todayDay - toDay(date) : 0;
    return age > limit ? [label + " " + date + " (" + age + "일 전)"] : [];
  });
  return aged.length ? "갱신 지연 여부 확인 · " + today + " (한국 날짜) 기준 " + aged.join(" · ") : null;
}

function renderDataWarnings() {
  const statuses = HEADLINES.map(([id]) => findSeries(id)?.status);
  const attention = statuses.filter((status) => status !== "current" && status !== "closed").length;
  const messages = [freshnessNotice(), ...state.errors].filter(Boolean);
  const publication = byId("last-updated");
  publication.classList.toggle("warning-text", attention > 0 || messages.length > 0);
  const warning = byId("load-warning");
  warning.hidden = !messages.length;
  warning.textContent = messages.join(" ");
}

function renderShellData() {
  byId("market-tiles").replaceChildren(...HEADLINES.map(([id, label]) => appendHeadline(id, label)));
  byId("last-updated").textContent = state.dashboard.generatedAt
    ? "파일 생성 " + timestamp(state.dashboard.generatedAt) + " KST" : "기존 보관 자료";
  renderDataWarnings();
}

function selectPage(page, changeUrl) {
  state.page = Object.hasOwn(PAGES, page) ? page : "overview";
  if (changeUrl && location.hash !== "#" + state.page) history.replaceState(null, "", "#" + state.page);
  for (const tab of byId("navigation").children) {
    const active = tab.dataset.page === state.page;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active) tab.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  renderView();
}

function initializeControls() {
  const tabs = byId("navigation");
  for (const [id, page] of Object.entries(PAGES)) {
    const tab = create("button", { type: "button", role: "tab", id: "tab-" + id, text: page.label,
      className: "nav-button" + (id === "etf" ? " etf-nav" : ""),
      "data-page": id, "aria-controls": "view" });
    tab.addEventListener("click", () => selectPage(id, true));
    tabs.append(tab);
  }
  tabs.addEventListener("keydown", (event) => {
    const buttons = [...tabs.children];
    const index = buttons.indexOf(event.target);
    const move = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (index < 0 || (!move && event.key !== "Home" && event.key !== "End")) return;
    event.preventDefault();
    const target = move ? (index + move + buttons.length) % buttons.length : event.key === "Home" ? 0 : buttons.length - 1;
    selectPage(buttons[target].dataset.page, true);
    buttons[target].focus();
  });
  window.addEventListener("hashchange", () => selectPage(location.hash.slice(1), false));

  for (const id of Object.keys(presets)) {
    const button = create("button", { type: "button", text: id, "data-range": id, "aria-pressed": String(id === state.preset) });
    button.addEventListener("click", () => selectRange(id));
    byId("range-buttons").append(button);
  }
  const dateForm = byId("date-form");
  byId("range-edit").addEventListener("click", () => {
    dateForm.hidden = !dateForm.hidden;
    byId("range-edit").setAttribute("aria-expanded", String(!dateForm.hidden));
    if (dateForm.hidden) return;
    for (const name of ["from", "to"]) {
      dateForm.elements[name].min = state.bounds.from;
      dateForm.elements[name].max = state.bounds.to;
      dateForm.elements[name].value = state.range[name];
    }
    byId("date-error").textContent = "";
    dateForm.elements.from.focus();
  });
  dateForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const from = dateForm.elements.from.value;
    const to = dateForm.elements.to.value;
    if (from > to) {
      byId("date-error").textContent = "종료일은 시작일과 같거나 뒤여야 합니다.";
      return;
    }
    applyCustomRange(from, to);
    byId("range-edit").focus();
  });

  byId("scale-mode").addEventListener("click", (event) => {
    const scale = event.target.dataset.scale;
    if (!scale) return;
    state.indexed = scale === "indexed";
    for (const button of byId("scale-mode").children) button.setAttribute("aria-pressed", String(button.dataset.scale === scale));
    renderView();
  });
  byId("theme-toggle").addEventListener("click", () => {
    theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    setPreference("kr-market-theme", theme);
    renderTheme();
    renderView();
  });
  systemTheme.addEventListener("change", () => {
    if (theme) return;
    renderTheme();
    renderView();
  });
  byId("data-status").addEventListener("click", openStatus);
  byId("load-warning").setAttribute("role", "status");
  window.addEventListener("focus", () => {
    if (!state.busy) renderDataWarnings();
  });
  byId("config-open").addEventListener("click", openSettings);
  byId("method-open").addEventListener("click", () => openDialog("산식과 데이터 출처", renderMethods()));
  byId("drawer").addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    byId("drawer").close();
  });
  byId("drawer").addEventListener("close", () => {
    const body = byId("dialog-body");
    destroyPlots(body);
    body.replaceChildren();
    clearSharedDate();
  });
  renderTheme();
  selectPage(location.hash.slice(1), false);
}

async function main() {
  initializeControls();
  const [dashboard, etf, intraday, analytics] = await Promise.all([
    fetchData("data/dashboard.json", (data) => data?.schemaVersion === 1 && data.series && Array.isArray(data.catalog)
      && Array.isArray(data.diagnostics)),
    fetchData("data/etf-changes.json", (data) => data?.schemaVersion === 1 && Array.isArray(data.etfs)),
    fetchData("data/intraday-status.json", (data) => data?.schemaVersion === 1 && typeof data.status === "string"),
    import("./lib/analytics.mjs").catch(() => null),
  ]);
  state.dashboard = dashboard.value || await loadOriginalData();
  state.etf = etf.value;
  state.intraday = intraday.value;
  state.etfError = etf.error;
  state.analytics = analytics;
  state.errors = [dashboard.error && dashboard.error + " 기존 보관 자료를 표시합니다.",
    etf.error, intraday.error, !analytics && "연구 모듈을 불러오지 못했습니다.",
    !globalThis.Chart && "차트 모듈을 불러오지 못했습니다."].filter(Boolean);
  if (analytics) {
    state.config = configFromStorage(analytics.DEFAULT_CONFIG);
    rebuildAnalysis();
  }
  state.bounds = fullBounds();
  state.busy = false;
  renderShellData();
  selectRange(state.preset);
}

main().catch(() => {
  const warning = byId("load-warning");
  warning.hidden = false;
  warning.textContent = "대시보드 표시 중 오류가 발생했습니다. 페이지를 새로고침해 다시 불러와 주세요.";
  byId("view").setAttribute("aria-busy", "false");
});
