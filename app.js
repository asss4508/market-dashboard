const css = getComputedStyle(document.documentElement);
const color = (name) => css.getPropertyValue(name).trim();

const palette = {
  1: () => color("--series-1"),
  2: () => color("--series-2"),
  3: () => color("--series-3"),
  4: () => color("--series-4"),
  5: () => color("--series-5"),
  6: () => color("--series-6"),
  7: () => color("--series-7"),
  8: () => color("--series-8"),
};

Chart.defaults.font.family = "-apple-system, 'Segoe UI', 'Malgun Gothic', sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.color = color("--muted");
Chart.defaults.borderColor = color("--grid");

async function loadJSON(path) {
  try {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    return [];
  }
}

function baseLineDataset(label, data, seriesColor) {
  return {
    label,
    data,
    borderColor: seriesColor,
    backgroundColor: seriesColor,
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointHitRadius: 10,
    tension: 0,
    spanGaps: true,
  };
}

function baseOptions(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: color("--panel"),
        titleColor: color("--text"),
        bodyColor: color("--text-secondary"),
        borderColor: color("--border"),
        borderWidth: 1,
        padding: 10,
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 8,
          callback: function (value) {
            const label = this.getLabelForValue(value);
            return typeof label === "string" ? label.slice(2, 7) : label;
          },
        },
      },
      y: {
        grid: { color: color("--grid") },
        border: { display: false },
        ticks: { color: color("--muted") },
      },
    },
    ...extra,
  };
}

function emptyState(canvasId, message) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color("--muted");
  ctx.font = "13px -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(message, canvas.width / 2, canvas.height / 2);
}

function wireToggles(cardId, chart, targetToIndex) {
  document.querySelectorAll(`#${cardId} .toggles input[type=checkbox]`).forEach((box) => {
    box.addEventListener("change", () => {
      const idx = targetToIndex[box.dataset.target];
      if (idx === undefined) return;
      const meta = chart.getDatasetMeta(idx);
      meta.hidden = !box.checked;
      chart.update();
    });
  });
}

let latestDate = null;
function trackLatest(rows) {
  if (!rows.length) return;
  const d = rows[rows.length - 1].date;
  if (!latestDate || d > latestDate) latestDate = d;
}

// 데이터 소스가 조용히 며칠씩 실패해도(예: 지난번 FRED 타임아웃) 화면만
// 봐서는 전혀 티가 안 나던 문제를 막기 위한 경고 배지.
function daysSince(dateStr) {
  const then = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - then) / 86_400_000);
}

function showStaleWarning(cardId, message) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const header = card.querySelector(".card-header");
  if (!header || header.querySelector(".stat-warn")) return;
  const warn = document.createElement("span");
  warn.className = "stat-warn";
  warn.textContent = `⚠ ${message}`;
  header.appendChild(warn);
}

function checkDailyStaleness(cardId, rows, thresholdDays = 4) {
  if (!rows.length) return;
  const latest = rows[rows.length - 1].date;
  const gap = daysSince(latest);
  if (gap > thresholdDays) showStaleWarning(cardId, `${gap}일째 갱신 안됨`);
}

// FRED(미국채)·KOFIA(신용융자/예탁금/반대매매)는 소스 자체가 며칠씩 늦게
// 발표하는 경우가 흔해서, 주말+발표 지연이 겹치는 월요일마다 오탐이
// 뜨지 않도록 코스피/코스닥/원달러보다 여유 있게 잡는다.
const FRED_STALE_THRESHOLD_DAYS = 7;
const KOFIA_STALE_THRESHOLD_DAYS = 7;

const chartRegistry = {};
function registerChart(key, chart, title) {
  chartRegistry[key] = { chart, title };
}

function renderStat(prefix, rows, field, opts = {}) {
  const { unit = "", deltaUnit = unit, showPct = true } = opts;
  const valid = rows.filter((r) => typeof r[field] === "number");
  const valueEl = document.getElementById(`${prefix}-value`);
  const deltaEl = document.getElementById(`${prefix}-delta`);
  if (!valueEl || !deltaEl) return;
  if (valid.length === 0) {
    valueEl.textContent = "데이터 없음";
    return;
  }
  const last = valid[valid.length - 1][field];
  valueEl.textContent = `${last.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}${unit}`;
  if (valid.length < 2) return;
  const prev = valid[valid.length - 2][field];
  const diff = last - prev;
  if (diff === 0) {
    deltaEl.textContent = "보합";
    deltaEl.className = "stat-delta flat";
    return;
  }
  const pct = (diff / prev) * 100;
  const dir = diff > 0 ? "up" : "down";
  const arrow = diff > 0 ? "▲" : "▼";
  const pctPart = showPct ? ` (${diff > 0 ? "+" : ""}${pct.toFixed(2)}%)` : "";
  deltaEl.textContent = `${arrow} ${Math.abs(diff).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}${deltaUnit}${pctPart}`;
  deltaEl.className = `stat-delta ${dir}`;
}

function renderAsOf(prefix, rows) {
  const el = document.getElementById(`${prefix}-asof`);
  if (!el || !rows.length) return;
  el.textContent = `${rows[rows.length - 1].date.slice(2)} 기준`;
}

async function renderKospiKosdaqCharts() {
  const rows = await loadJSON("data/kospi_kosdaq.json");
  if (!rows.length) {
    emptyState("chart-kospi", "데이터 준비 중입니다");
    emptyState("chart-kosdaq", "데이터 준비 중입니다");
    return;
  }
  trackLatest(rows);
  renderStat("kospi", rows, "kospi");
  renderStat("kosdaq", rows, "kosdaq");
  checkDailyStaleness("card-kospi", rows);
  checkDailyStaleness("card-kosdaq", rows);

  const kospiChart = new Chart(document.getElementById("chart-kospi"), {
    type: "line",
    data: {
      labels: rows.map((r) => r.date),
      datasets: [baseLineDataset("코스피", rows.map((r) => r.kospi), palette[1]())],
    },
    options: baseOptions(),
  });
  registerChart("kospi", kospiChart, "코스피");

  const kosdaqChart = new Chart(document.getElementById("chart-kosdaq"), {
    type: "line",
    data: {
      labels: rows.map((r) => r.date),
      datasets: [baseLineDataset("코스닥", rows.map((r) => r.kosdaq), palette[2]())],
    },
    options: baseOptions(),
  });
  registerChart("kosdaq", kosdaqChart, "코스닥");
}

async function renderMarginChart() {
  const rows = await loadJSON("data/margin_balance.json");
  if (!rows.length) return emptyState("chart-margin", "데이터 준비 중입니다");
  trackLatest(rows);
  renderAsOf("margin", rows);
  renderStat("margin-kospi", rows, "kospi_margin", { unit: "조원" });
  renderStat("margin-kosdaq", rows, "kosdaq_margin", { unit: "조원" });
  checkDailyStaleness("card-margin", rows, KOFIA_STALE_THRESHOLD_DAYS);
  const chart = new Chart(document.getElementById("chart-margin"), {
    type: "line",
    data: {
      labels: rows.map((r) => r.date),
      datasets: [
        baseLineDataset("코스피 융자", rows.map((r) => r.kospi_margin), palette[1]()),
        baseLineDataset("코스닥 융자", rows.map((r) => r.kosdaq_margin), palette[2]()),
      ],
    },
    options: baseOptions(),
  });
  registerChart("margin", chart, "신용거래융자 잔고");
}

async function renderDepositChart() {
  const rows = await loadJSON("data/investor_deposit.json");
  if (!rows.length) return emptyState("chart-deposit", "데이터 준비 중입니다");
  trackLatest(rows);
  renderAsOf("deposit", rows);
  renderStat("deposit", rows, "deposit", { unit: "조원" });
  checkDailyStaleness("card-deposit", rows, KOFIA_STALE_THRESHOLD_DAYS);
  const chart = new Chart(document.getElementById("chart-deposit"), {
    type: "line",
    data: {
      labels: rows.map((r) => r.date),
      datasets: [baseLineDataset("투자자예탁금", rows.map((r) => r.deposit), palette[4]())],
    },
    options: baseOptions(),
  });
  registerChart("deposit", chart, "투자자예탁금 추이");
}

async function renderReverseChart() {
  const rows = await loadJSON("data/reverse_trade.json");
  if (!rows.length) return emptyState("chart-reverse", "데이터 준비 중입니다");
  trackLatest(rows);
  const cutoff = lastYearCutoff();
  const recent = rows.filter((r) => r.date >= cutoff);
  renderAsOf("reverse", recent);
  renderStat("reverse", recent, "amount", { unit: "억원" });
  checkDailyStaleness("card-reverse", rows, KOFIA_STALE_THRESHOLD_DAYS);
  const chart = new Chart(document.getElementById("chart-reverse"), {
    type: "line",
    data: {
      labels: recent.map((r) => r.date),
      datasets: [baseLineDataset("반대매매금액", recent.map((r) => r.amount), palette[6]())],
    },
    options: baseOptions(),
  });
  registerChart("reverse", chart, "일별 반대매매 금액");
}

function cumulativeSum(values) {
  let sum = 0;
  return values.map((v) => {
    sum += v || 0;
    return sum;
  });
}

function lastYearCutoff() {
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  return oneYearAgo.toISOString().slice(0, 10);
}

function last30YearsCutoff() {
  const thirtyYearsAgo = new Date();
  thirtyYearsAgo.setFullYear(thirtyYearsAgo.getFullYear() - 30);
  return thirtyYearsAgo.toISOString().slice(0, 10);
}

async function renderFlowChart() {
  const rows = await loadJSON("data/investor_flow.json");
  if (!rows.length) return emptyState("chart-flow", "데이터 준비 중입니다");
  trackLatest(rows);

  const cutoff = lastYearCutoff();
  const recent = rows.filter((r) => r.date >= cutoff);
  checkDailyStaleness("card-flow", rows);

  const chart = new Chart(document.getElementById("chart-flow"), {
    type: "line",
    data: {
      labels: recent.map((r) => r.date),
      datasets: [
        baseLineDataset("기관", cumulativeSum(recent.map((r) => r.institution_net)), palette[1]()),
        baseLineDataset("외국인", cumulativeSum(recent.map((r) => r.foreign_net)), palette[2]()),
        baseLineDataset("개인", cumulativeSum(recent.map((r) => r.individual_net)), palette[3]()),
      ],
    },
    options: baseOptions(),
  });
  wireToggles("card-flow", chart, { "flow-inst": 0, "flow-foreign": 1, "flow-individual": 2 });
  registerChart("flow", chart, "투자자별 매매동향 (최근 1년 누적)");
}

async function renderUs10yChart() {
  const rows = await loadJSON("data/us10y.json");
  if (!rows.length) return emptyState("chart-us10y", "데이터 준비 중입니다");
  const cutoff = last30YearsCutoff();
  const recent = rows.filter((r) => r.date >= cutoff);
  trackLatest(recent);
  renderStat("us10y", recent, "yield", { unit: "%", deltaUnit: "%p", showPct: false });
  checkDailyStaleness("card-us10y", rows, FRED_STALE_THRESHOLD_DAYS);
  const chart = new Chart(document.getElementById("chart-us10y"), {
    type: "line",
    data: {
      labels: recent.map((r) => r.date),
      datasets: [baseLineDataset("미국 10년물 금리", recent.map((r) => r.yield), palette[1]())],
    },
    options: baseOptions(),
  });
  registerChart("us10y", chart, "미국 10년물 국채금리 (최근 30년)");
}

async function renderFxChart() {
  const rows = await loadJSON("data/fx.json");
  if (!rows.length) return emptyState("chart-fx", "데이터 준비 중입니다");
  trackLatest(rows);
  renderStat("fx-usd", rows, "usd_krw", { unit: "원" });
  checkDailyStaleness("card-fx", rows);
  const chart = new Chart(document.getElementById("chart-fx"), {
    type: "line",
    data: {
      labels: rows.map((r) => r.date),
      datasets: [baseLineDataset("달러", rows.map((r) => r.usd_krw), palette[1]())],
    },
    options: baseOptions(),
  });
  registerChart("fx", chart, "원/달러 환율");
}

// 코스피/코스닥/원달러/미국10년물은 평일 10분마다 별도 워크플로가 갱신하는
// 장중 현재가 스냅샷. 기존 일별 종가 차트는 건드리지 않고, 카드에 작은
// "실시간" 배지로만 얹어서 보여준다.
const LIVE_STAT_SPECS = [
  ["kospi", "kospi", "", "card-kospi"],
  ["kosdaq", "kosdaq", "", "card-kosdaq"],
  ["us10y", "us10y", "%", "card-us10y"],
  ["fx-usd", "usd_krw", "원", "card-fx"],
];

async function renderLiveStats() {
  const snap = await loadJSON("data/intraday.json");
  if (!snap || !snap.updated_at) return;
  const time = new Date(snap.updated_at).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  for (const [prefix, key, unit] of LIVE_STAT_SPECS) {
    const el = document.getElementById(`${prefix}-live`);
    if (!el || typeof snap[key] !== "number") continue;
    const formatted = snap[key].toLocaleString("ko-KR", { maximumFractionDigits: 2 });
    el.textContent = `실시간 ${formatted}${unit} · ${time} 기준`;
  }

  // 주말엔 워크플로가 원래 안 돌아 오래된 게 정상이라, 평일에만 경고
  const isWeekday = ![0, 6].includes(new Date().getDay());
  const staleMinutes = Math.floor((Date.now() - new Date(snap.updated_at).getTime()) / 60_000);
  if (isWeekday && staleMinutes > 180) {
    for (const [, , , cardId] of LIVE_STAT_SPECS) {
      showStaleWarning(cardId, `실시간 갱신 ${Math.floor(staleMinutes / 60)}시간째 안됨`);
    }
  }
}

let modalChart = null;
function openChartModal(key) {
  const entry = chartRegistry[key];
  if (!entry) return;
  const { chart, title } = entry;
  document.getElementById("modal-title").textContent = title;
  document.getElementById("chart-modal").classList.add("open");

  if (modalChart) modalChart.destroy();
  const datasets = chart.data.datasets.map((ds, i) => ({
    ...ds,
    hidden: chart.getDatasetMeta(i).hidden || false,
  }));
  modalChart = new Chart(document.getElementById("modal-canvas"), {
    type: chart.config.type,
    data: { labels: chart.data.labels, datasets },
    options: baseOptions({
      plugins: {
        legend: { display: false },
        tooltip: baseOptions().plugins.tooltip,
      },
    }),
  });
}

function closeChartModal() {
  document.getElementById("chart-modal").classList.remove("open");
  if (modalChart) {
    modalChart.destroy();
    modalChart = null;
  }
}

function wireModal() {
  document.querySelectorAll("main .card[data-chart-key] .card-title").forEach((el) => {
    el.addEventListener("click", () => {
      const key = el.closest(".card").dataset.chartKey;
      openChartModal(key);
    });
  });
  document.getElementById("modal-close").addEventListener("click", closeChartModal);
  document.getElementById("chart-modal").addEventListener("click", (e) => {
    if (e.target.id === "chart-modal") closeChartModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeChartModal();
  });
}

async function main() {
  wireModal();
  await Promise.all([
    renderKospiKosdaqCharts(),
    renderMarginChart(),
    renderDepositChart(),
    renderReverseChart(),
    renderFlowChart(),
    renderUs10yChart(),
    renderFxChart(),
    renderLiveStats(),
  ]);
  const el = document.getElementById("last-updated");
  el.textContent = latestDate ? `최신 데이터: ${latestDate}` : "데이터 없음";

  // 탭을 열어둔 동안에는 서버 쪽 10분 주기와 별개로 화면도 주기적으로 새로고침
  setInterval(renderLiveStats, 60_000);
}

main();
