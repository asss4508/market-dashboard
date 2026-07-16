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
        ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
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

function renderLegend(el, items) {
  el.innerHTML = items
    .map((it) => `<span><span class="dot" style="background:${it.color}"></span>${it.label}</span>`)
    .join("");
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

async function renderIndexChart() {
  const rows = await loadJSON("data/kospi_kosdaq.json");
  if (!rows.length) return emptyState("chart-index", "데이터 준비 중입니다");
  trackLatest(rows);
  const chart = new Chart(document.getElementById("chart-index"), {
    type: "line",
    data: {
      labels: rows.map((r) => r.date),
      datasets: [
        baseLineDataset("코스피", rows.map((r) => r.kospi), palette[1]()),
        baseLineDataset("코스닥", rows.map((r) => r.kosdaq), palette[2]()),
      ],
    },
    options: baseOptions(),
  });
  wireToggles("card-index", chart, { "index-kospi": 0, "index-kosdaq": 1 });
}

async function renderMarginChart() {
  const rows = await loadJSON("data/margin_balance.json");
  if (!rows.length) return emptyState("chart-margin", "데이터 준비 중입니다");
  trackLatest(rows);
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
  wireToggles("card-margin", chart, { "margin-kospi": 0, "margin-kosdaq": 1 });
}

// 코스피지수와 예탁금은 단위가 달라 동일 축에 놓을 수 없으므로,
// 시작일을 100으로 맞춘 지수화 값으로 변환해 단일 축에 표시한다 (dual-axis 금지 규칙).
function indexTo100(values) {
  const base = values.find((v) => typeof v === "number" && !Number.isNaN(v));
  if (!base) return values;
  return values.map((v) => (typeof v === "number" ? (v / base) * 100 : null));
}

async function renderDepositChart() {
  const rows = await loadJSON("data/investor_deposit.json");
  if (!rows.length) return emptyState("chart-deposit", "데이터 준비 중입니다");
  trackLatest(rows);
  const kospiIdx = indexTo100(rows.map((r) => r.kospi));
  const depositIdx = indexTo100(rows.map((r) => r.deposit));
  const legendEl = document.querySelector("#card-deposit .legend") || (() => {
    const el = document.createElement("div");
    el.className = "legend";
    document.getElementById("chart-deposit").closest(".chart-wrap").before(el);
    return el;
  })();
  renderLegend(legendEl, [
    { color: palette[1](), label: "코스피지수 (2018.01=100)" },
    { color: palette[4](), label: "투자자예탁금 (2018.01=100)" },
  ]);
  new Chart(document.getElementById("chart-deposit"), {
    type: "line",
    data: {
      labels: rows.map((r) => r.date),
      datasets: [
        baseLineDataset("코스피지수", kospiIdx, palette[1]()),
        baseLineDataset("투자자예탁금", depositIdx, palette[4]()),
      ],
    },
    options: baseOptions(),
  });
}

async function renderFlowChart() {
  const rows = await loadJSON("data/investor_flow.json");
  if (!rows.length) return emptyState("chart-flow", "데이터 준비 중입니다");
  trackLatest(rows);
  const chart = new Chart(document.getElementById("chart-flow"), {
    type: "line",
    data: {
      labels: rows.map((r) => r.date),
      datasets: [
        baseLineDataset("기관", rows.map((r) => r.institution_net), palette[1]()),
        baseLineDataset("외국인", rows.map((r) => r.foreign_net), palette[2]()),
        baseLineDataset("개인", rows.map((r) => r.individual_net), palette[3]()),
      ],
    },
    options: baseOptions(),
  });
  wireToggles("card-flow", chart, { "flow-inst": 0, "flow-foreign": 1, "flow-individual": 2 });
}

async function renderUs10yChart() {
  const rows = await loadJSON("data/us10y.json");
  if (!rows.length) return emptyState("chart-us10y", "데이터 준비 중입니다");
  trackLatest(rows);
  new Chart(document.getElementById("chart-us10y"), {
    type: "line",
    data: {
      labels: rows.map((r) => r.date),
      datasets: [baseLineDataset("미국 10년물 금리", rows.map((r) => r.yield), palette[1]())],
    },
    options: baseOptions(),
  });
}

async function renderFxChart() {
  const rows = await loadJSON("data/fx.json");
  if (!rows.length) return emptyState("chart-fx", "데이터 준비 중입니다");
  trackLatest(rows);
  const chart = new Chart(document.getElementById("chart-fx"), {
    type: "line",
    data: {
      labels: rows.map((r) => r.date),
      datasets: [
        baseLineDataset("달러", rows.map((r) => r.usd_krw), palette[1]()),
        baseLineDataset("엔(100)", rows.map((r) => r.jpy_krw), palette[2]()),
        baseLineDataset("유로", rows.map((r) => r.eur_krw), palette[3]()),
        baseLineDataset("위안", rows.map((r) => r.cny_krw), palette[4]()),
      ],
    },
    options: baseOptions(),
  });
  const meta2 = chart.getDatasetMeta(2);
  meta2.hidden = true;
  const meta3 = chart.getDatasetMeta(3);
  meta3.hidden = true;
  chart.update();
  wireToggles("card-fx", chart, { "fx-usd": 0, "fx-jpy": 1, "fx-eur": 2, "fx-cny": 3 });
}

async function main() {
  await Promise.all([
    renderIndexChart(),
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
