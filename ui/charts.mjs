import { byId, create, dateString, downloadCsv, empty, format, quantity, sourceLink, toDay, valid } from "./dom.mjs";

const colors = () => getComputedStyle(document.documentElement);
const instances = new Set();
const chartPreferences = new Map();
let sharedDay = null;
let drag = null;
let plannedDraw = null;

function preferences(key, series) {
  if (!chartPreferences.has(key)) {
    chartPreferences.set(key, {
      hidden: new Set(series.filter((line) => line.hidden).map((line) => line.id)),
      overlays: new Set(),
      technicalOpen: false,
      brush: false,
    });
  }
  return chartPreferences.get(key);
}

function resetPointer() {
  sharedDay = null;
  drag = null;
}

export function destroyPlots(container) {
  for (const plot of instances) {
    if (container.contains(plot.chart.canvas)) {
      if (drag?.plot === plot) resetPointer();
      plot.chart.destroy();
      instances.delete(plot);
    }
  }
}

function formatReadout(plot) {
  if (sharedDay === null || sharedDay < plot.chart.scales.x.min || sharedDay > plot.chart.scales.x.max) {
    plot.readout.textContent = " ";
    return;
  }
  const values = plot.chart.data.datasets.flatMap((line, i) => {
    if (!plot.chart.isDatasetVisible(i)) return [];
    const point = line.points.get(sharedDay);
    return point == null ? [] : [line.label + " " + quantity(point, line.displayUnit, line.digits)];
  });
  plot.readout.textContent = dateString(sharedDay) + " · " + (values.join("  /  ") || "해당 날짜 관측 없음");
}

const crosshair = {
  id: "sharedDate",
  afterDraw(chart) {
    const area = chart.chartArea;
    const scale = chart.scales.x;
    if (!area || !scale) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.left, area.top, area.width, area.height);
    ctx.clip();
    if (drag?.plot.chart === chart) {
      const left = scale.getPixelForValue(Math.min(drag.start, drag.end));
      const right = scale.getPixelForValue(Math.max(drag.start, drag.end));
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = colors().getPropertyValue("--accent");
      ctx.fillRect(left, area.top, right - left, area.height);
      ctx.globalAlpha = 1;
    }
    if (sharedDay !== null && sharedDay >= scale.min && sharedDay <= scale.max) {
      const x = scale.getPixelForValue(sharedDay);
      ctx.strokeStyle = colors().getPropertyValue("--subtle");
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.stroke();
      chart.data.datasets.forEach((dataset, index) => {
        const value = dataset.points.get(sharedDay);
        if (!chart.isDatasetVisible(index) || !valid(value)) return;
        const y = chart.scales.y.getPixelForValue(value);
        ctx.fillStyle = dataset.borderColor;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    ctx.restore();
  },
};

function redraw() {
  if (plannedDraw !== null) return;
  plannedDraw = requestAnimationFrame(() => {
    plannedDraw = null;
    for (const plot of instances) {
      plot.chart.draw();
      formatReadout(plot);
    }
  });
}

function closestDay(days, target) {
  if (!days.length) return null;
  let left = 0;
  let right = days.length - 1;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (days[middle] < target) left = middle + 1;
    else right = middle;
  }
  return left > 0 && target - days[left - 1] < days[left] - target ? days[left - 1] : days[left];
}

function pointerDay(chart, event) {
  const rect = chart.canvas.getBoundingClientRect();
  const pos = (event.clientX - rect.left) * chart.width / rect.width;
  const x = Math.max(chart.chartArea.left, Math.min(chart.chartArea.right, pos));
  return Math.round(chart.scales.x.getValueForPixel(x));
}

function wirePlot(plot, onZoom) {
  const canvas = plot.chart.canvas;
  canvas.addEventListener("pointermove", (event) => {
    const raw = pointerDay(plot.chart, event);
    if (drag?.plot === plot) drag.end = raw;
    sharedDay = closestDay(plot.days, raw);
    redraw();
  });
  canvas.addEventListener("pointerleave", () => {
    if (drag) return;
    sharedDay = null;
    redraw();
  });
  canvas.addEventListener("pointerdown", (event) => {
    if (!onZoom || !plot.state.brush || event.button !== 0) return;
    const raw = pointerDay(plot.chart, event);
    drag = { plot, start: raw, end: raw };
    canvas.setPointerCapture(event.pointerId);
    redraw();
  });
  canvas.addEventListener("pointerup", (event) => {
    if (drag?.plot !== plot) return;
    const { start } = drag;
    const end = pointerDay(plot.chart, event);
    resetPointer();
    if (Math.abs(end - start) >= 2) onZoom(dateString(Math.min(start, end)), dateString(Math.max(start, end)));
    redraw();
  });
  canvas.addEventListener("pointercancel", () => {
    resetPointer();
    redraw();
  });
  canvas.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      resetPointer();
      redraw();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nearest = closestDay(plot.days, sharedDay ?? plot.days.at(-1));
    const index = plot.days.indexOf(nearest);
    const move = event.key === "ArrowLeft" ? -1 : 1;
    sharedDay = plot.days[Math.max(0, Math.min(plot.days.length - 1, index + move))];
    redraw();
  });
  canvas.addEventListener("blur", () => {
    sharedDay = null;
    redraw();
  });
}

function displayData(lines, dateRange, opts) {
  const visibleLines = lines.filter((line) => !line.overlay && !opts.state.hidden.has(line.id));
  let indexedFrom = dateRange.from;
  if (opts.indexed && visibleLines.length > 1) {
    const observations = visibleLines.map((line) => new Set(line.points
      .filter((point) => point.date >= dateRange.from && point.date <= dateRange.to && point.value > 0)
      .map((point) => point.date)));
    const common = [...observations[0]].find((date) => observations.every((dates) => dates.has(date)));
    if (common) indexedFrom = common;
  }

  const normalizedById = new Map();
  const pointsById = new Map();
  for (const line of lines) {
    let points = line.points.filter((point) => point.date >= indexedFrom && point.date <= dateRange.to);
    if (line.cumulative) {
      let total = 0;
      points = points.map((point) => {
        if (!valid(point.value)) return point;
        total += point.value;
        return { ...point, value: total };
      });
    }
    pointsById.set(line.id, points);
    if (!opts.indexed) continue;
    const base = points.find((point) => valid(point.value))?.value;
    if (base > 0) normalizedById.set(line.id, base);
  }

  const datesByFrequency = new Map();
  for (const line of lines) {
    const key = line.frequency || "daily";
    if (opts.state.hidden.has(line.id)) continue;
    if (!datesByFrequency.has(key)) datesByFrequency.set(key, new Set());
    for (const point of pointsById.get(line.id)) {
      datesByFrequency.get(key).add(toDay(point.date));
    }
  }

  return lines.map((line, index) => {
    const base = normalizedById.get(line.baseId || line.id);
    const raw = pointsById.get(line.id);
    const byDate = new Map(raw.map((point) => [toDay(point.date), valid(point.value) ? point.value : null]));
    const grid = datesByFrequency.get(line.frequency || "daily") || new Set();
    const days = [...new Set([...byDate.keys(), ...grid])].sort((a, b) => a - b);
    const points = new Map(days.map((day) => {
      const value = byDate.get(day);
      return [day, valid(value) ? (base ? value / base * 100 : value) : null];
    }));
    const lineColor = colors().getPropertyValue("--series-" + (line.color || index % 8 + 1)).trim();
    const displayUnit = base ? "" : line.unit;
    return {
      id: line.id,
      label: line.label,
      displayUnit,
      digits: base ? 2 : line.digits ?? 2,
      raw,
      points,
      data: [...points].map(([x, y]) => ({ x, y })),
      hidden: opts.state.hidden.has(line.id),
      borderColor: lineColor,
      backgroundColor: lineColor,
      borderDash: line.overlay ? [5, 4] : [],
      borderWidth: line.overlay ? 1.2 : 1.7,
      pointRadius: days.length === 1 ? 3 : 0,
      spanGaps: false,
      fill: !line.overlay && opts.hero && index === 0 ? { target: "start", above: lineColor + "20" } : false,
    };
  });
}

function plotOptions(view, dataset) {
  const tokens = colors();
  const muted = tokens.getPropertyValue("--muted").trim();
  const grid = tokens.getPropertyValue("--grid").trim();
  const dates = view.range;
  const xMin = toDay(dates.from);
  const xMax = Math.max(xMin + 1, toDay(dates.to));
  const width = xMax - xMin;
  const digits = dataset.some((ds) => ds.digits > 2) ? 3 : 2;
  const font = { family: tokens.getPropertyValue("--numeric").trim(), size: 12 };
  return {
    animation: false, responsive: true, maintainAspectRatio: false, parsing: false, events: [],
    color: muted,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: {
        type: "linear", min: xMin, max: xMax,
        grid: { display: false }, border: { color: grid },
        ticks: {
          color: muted, font, maxTicksLimit: 7, precision: 0, maxRotation: 0,
          callback: (day) => width < 160 ? dateString(day).slice(5) : dateString(day).slice(2, 7),
        },
      },
      y: {
        grid: { color: grid }, border: { display: false },
        ticks: { color: muted, font, maxTicksLimit: 6, callback: (value) => format(value, digits) },
      },
    },
    font,
  };
}

function lineSummary(lines) {
  const group = create("div", { className: "chart-meta" });
  for (const line of lines) {
    if (line.hidden) continue;
    const last = line.points.findLast((point) => valid(point.value));
    group.append(create("span", {},
      create("strong", { className: "chart-latest", text: quantity(last?.value, line.unit, line.digits) }),
      " · " + line.label + (last?.date ? " · " + last.date : ""),
      line.source?.name && [" · ", sourceLink(line.source.name, line.source.url)],
    ));
  }
  return group;
}

export function chartCard(spec, options) {
  const { view, dialog, onZoom, technical } = options;
  const state = preferences(spec.key, spec.lines);
  const card = create("article", { className: "card chart-card " + (spec.hero ? "hero-chart " : "") + (spec.span || "span-6") });
  const title = create("div", {}, create("h3", { text: spec.title }));
  if (spec.subtitle) title.append(create("p", { className: "meta", text: spec.subtitle }));
  const actions = create("div", { className: "action-row" });
  card.append(create("div", { className: "card-head" }, title, actions));
  const actual = spec.lines.filter((line) => line.points.some((point) => valid(point.value)));
  if (!actual.length) {
    card.append(empty(spec.missing || "N/A · 조회할 관측치가 없습니다."));
    return card;
  }

  const canIndex = spec.allowIndexed !== false && !actual.some((line) => line.cumulative);
  const summary = lineSummary(actual.filter((line) => !state.hidden.has(line.id)).map((line) => ({ ...line, hidden: false })));
  title.append(summary);
  if (!globalThis.Chart) {
    card.append(empty("차트 모듈을 불러오지 못했습니다. 수치와 출처는 위에서 확인할 수 있습니다."));
    return card;
  }

  const readout = create("div", { className: "chart-readout" }, " ");
  const canvas = create("canvas", { role: "img", tabindex: 0, "aria-label": spec.title + " 시계열 차트. 방향키로 날짜를 이동합니다." });
  const wrap = create("div", { className: "chart-wrap" }, canvas);
  const legend = create("div", { className: "chart-legend", role: "group", "aria-label": "표시할 계열" });
  const controls = create("div", { className: "chart-controls" }, legend);
  const indicators = create("div");
  const rangeNote = create("p", { className: "chart-data-window meta" });
  const periodEmpty = empty("조회 기간에 표시할 관측치가 없습니다.");
  const buttonExport = create("button", { className: "button", type: "button", text: "CSV", title: "표시 중인 차트 데이터 다운로드" });
  const buttonBrush = onZoom && create("button", { className: "button", type: "button", text: "드래그 확대", "aria-pressed": String(state.brush) });
  const buttonExpand = dialog && !spec.noExpand && create("button", { className: "button", type: "button", text: "크게 보기" });
  actions.append(...[buttonExport, buttonBrush, buttonExpand].filter(Boolean));
  wrap.classList.toggle("drag-enabled", state.brush && Boolean(onZoom));
  let plot;
  let lastDataset = [];

  function renderPlot() {
    if (!card.isConnected) return;
    const activeLines = actual.filter((line) => !state.hidden.has(line.id));
    const baseLine = activeLines[0];
    const overlayLines = baseLine && technical
      ? [20, 60, 120, 200].map((n, i) => [n, i + 3]).filter(([n]) => state.overlays.has("ma" + n)).map(([n, color]) => ({
        id: "ma" + n, label: "MA" + n, overlay: true, baseId: baseLine.id, color,
        points: technical.movingAverage(baseLine.points, n), unit: baseLine.unit, frequency: baseLine.frequency,
      })) : [];
    const presetIndexed = view.indexed && canIndex;
    const visibleWindow = [...activeLines, ...overlayLines].map((line) => line.points.filter((point) =>
      point.date >= view.range.from && point.date <= view.range.to && valid(point.value)));
    const indexingUsable = presetIndexed && visibleWindow.slice(0, activeLines.length)
      .every((points) => points.length === 0 || points[0].value > 0);
    const dataset = displayData([...actual, ...overlayLines], view.range, {
      state, indexed: indexingUsable, hero: spec.hero,
    });
    const days = [...new Set(dataset.filter((ds) => !ds.hidden).flatMap((ds) =>
      ds.data.flatMap((point) => valid(point.y) ? [point.x] : [])))].sort((a, b) => a - b);
    lastDataset = dataset;
    buttonExport.disabled = !days.length;
    if (buttonBrush) buttonBrush.disabled = !days.length;
    wrap.hidden = !days.length;
    readout.hidden = !days.length;
    periodEmpty.hidden = Boolean(days.length);
    const mode = view.indexed && !indexingUsable ? "원래 단위 · 기준 100 적용 불가" : indexingUsable ? "기준 100" : "원래 단위";
    rangeNote.textContent = days.length ? mode + " · 관측 " + dateString(days[0]) + " ~ " + dateString(days.at(-1)) : "";
    rangeNote.hidden = !days.length;
    if (plot) {
      plot.chart.data.datasets = dataset;
      plot.days = days;
      plot.chart.update("none");
    } else if (days.length) {
      const chart = new globalThis.Chart(canvas, {
        type: "line",
        data: { datasets: dataset },
        options: plotOptions(view, dataset),
        plugins: [crosshair],
      });
      plot = { chart, days, state, readout };
      instances.add(plot);
      wirePlot(plot, onZoom);
    }
    const currentSummary = lineSummary(activeLines.map((line) => ({ ...line, hidden: false })));
    summary.replaceChildren(...currentSummary.childNodes);
    formatIndicators();
  }

  function formatIndicators() {
    destroyPlots(indicators);
    indicators.replaceChildren();
    if (!spec.technical || !technical) return;
    const base = actual.find((line) => !state.hidden.has(line.id));
    if (!base) return;
    const techOptions = { ...options, dialog: null, onZoom: null };
    if (state.overlays.has("rsi")) {
      const points = technical.rsi(base.points, 14);
      indicators.append(chartCard({
        key: spec.key + "-rsi-" + base.id, title: base.label + " RSI(14)",
        lines: [{ id: "rsi", label: "RSI", points, color: 4, unit: "점" }],
        allowIndexed: false, noExpand: true,
      }, techOptions));
    }
    if (state.overlays.has("macd")) {
      const points = technical.macd(base.points);
      const labels = { macd: "MACD", signal: "시그널", histogram: "히스토그램" };
      indicators.append(chartCard({
        key: spec.key + "-macd-" + base.id, title: base.label + " MACD(12, 26, 9)",
        lines: Object.entries(labels).map(([id, label], index) => ({
          id, label, points: points.map((point) => ({ date: point.date, value: point[id] })),
          color: index + 2, unit: base.unit, digits: 3,
        })),
        allowIndexed: false, noExpand: true,
      }, techOptions));
    }
  }

  for (const [index, line] of actual.entries()) {
    const check = create("input", { type: spec.exclusive ? "radio" : "checkbox", name: spec.exclusive ? "fx-" + spec.key : null,
      checked: !state.hidden.has(line.id) });
    const dot = create("span", { className: "legend-dot", "aria-hidden": "true" });
    dot.style.background = "var(--series-" + (line.color || index % 8 + 1) + ")";
    check.addEventListener("change", () => {
      if (spec.exclusive) state.hidden = new Set(actual.filter((entry) => entry.id !== line.id).map((entry) => entry.id));
      else if (check.checked) state.hidden.delete(line.id);
      else state.hidden.add(line.id);
      renderPlot();
    });
    if (actual.length > 1) legend.append(create("label", {}, check, dot, line.label));
  }

  card.append(controls);
  if (spec.technical && technical) {
    const details = create("details", { className: "ta-controls", open: state.technicalOpen });
    const switches = create("div", { className: "check-group", role: "group", "aria-label": "기술적 지표" });
    for (const [key, label] of [["ma20", "MA20"], ["ma60", "MA60"], ["ma120", "MA120"], ["ma200", "MA200"], ["rsi", "RSI"], ["macd", "MACD"]]) {
      const check = create("input", { type: "checkbox", checked: state.overlays.has(key) });
      check.addEventListener("change", () => {
        if (check.checked) state.overlays.add(key);
        else state.overlays.delete(key);
        renderPlot();
      });
      switches.append(create("label", {}, check, label));
    }
    details.append(create("summary", { text: "기술적 지표" }), switches);
    details.addEventListener("toggle", () => { state.technicalOpen = details.open; });
    card.append(details);
  }
  card.append(readout, wrap, periodEmpty, rangeNote, indicators);
  if (spec.footnote) card.append(create("p", { className: "footnote", text: spec.footnote }));

  buttonBrush?.addEventListener("click", () => {
    state.brush = !state.brush;
    buttonBrush.setAttribute("aria-pressed", String(state.brush));
    wrap.classList.toggle("drag-enabled", state.brush);
  });
  buttonExpand?.addEventListener("click", () => {
    const modalKey = spec.key + "-modal";
    chartPreferences.set(modalKey, { ...state, hidden: new Set(state.hidden), overlays: new Set(state.overlays) });
    const modal = chartCard({ ...spec, key: modalKey, hero: false, noExpand: true },
      { ...options, onZoom: null, dialog: null });
    modal.classList.add("chart-modal");
    dialog(spec.title, modal);
  });
  buttonExport.addEventListener("click", () => {
    const columns = lastDataset.filter((ds) => !ds.hidden);
    const data = new Map();
    for (const [index, column] of columns.entries()) {
      for (const point of column.data) {
        if (!valid(point.y)) continue;
        if (!data.has(point.x)) data.set(point.x, Array(columns.length).fill(null));
        data.get(point.x)[index] = point.y;
      }
    }
    const header = ["날짜", ...columns.map((line) => line.label + (line.displayUnit ? " (" + line.displayUnit + ")" : ""))];
    const rows = [...data].sort(([a], [b]) => a - b).map(([day, values]) => [dateString(day), ...values]);
    downloadCsv(spec.key + "-" + view.range.from + "_" + view.range.to + ".csv", [header, ...rows]);
  });
  queueMicrotask(renderPlot);
  return card;
}

export function clearSharedDate() {
  resetPointer();
  redraw();
}
