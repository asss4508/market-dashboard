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
  renderStat("margin-kospi", rows, "kospi_margin", { unit: "조원" });
  renderStat("margin-kosdaq", rows, "kosdaq_margin", { unit: "조원" });
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
  renderStat("deposit", rows, "deposit", { unit: "조원" });
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

function cumulativeSum(values) {
  let sum = 0;
  return values.map((v) => {
    sum += v || 0;
    return sum;
  });
}

async function renderFlowChart() {
  const rows = await loadJSON("data/investor_flow.json");
  if (!rows.length) return emptyState("chart-flow", "데이터 준비 중입니다");
  trackLatest(rows);

  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const cutoff = oneYearAgo.toISOString().slice(0, 10);
  const recent = rows.filter((r) => r.date >= cutoff);

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
  trackLatest(rows);
  renderStat("us10y", rows, "yield", { unit: "%", deltaUnit: "%p", showPct: false });
  const chart = new Chart(document.getElementById("chart-us10y"), {
    type: "line",
    data: {
      labels: rows.map((r) => r.date),
      datasets: [baseLineDataset("미국 10년물 금리", rows.map((r) => r.yield), palette[1]())],
    },
    options: baseOptions(),
  });
  registerChart("us10y", chart, "미국 10년물 국채금리");
}

async function renderFxChart() {
  const rows = await loadJSON("data/fx.json");
  if (!rows.length) return emptyState("chart-fx", "데이터 준비 중입니다");
  trackLatest(rows);
  renderStat("fx-usd", rows, "usd_krw", { unit: "원" });
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
    renderFlowChart(),
    renderUs10yChart(),
    renderFxChart(),
  ]);
  const el = document.getElementById("last-updated");
  el.textContent = latestDate ? `최신 데이터: ${latestDate}` : "데이터 없음";
}

main();
