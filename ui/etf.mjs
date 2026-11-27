import { badge, cardHeading, create, direction, downloadCsv, empty, quantity, signed, sourceLink, table, timestamp, valid } from "./dom.mjs";

const KINDS = {
  entry: "신규", increase: "확대", decrease: "축소", exit: "편출",
};
const state = { search: "", minimum: 0, funds: null, kinds: new Set(Object.keys(KINDS)) };
const PUBLISHED_WEIGHT = "공표 비중";

function checkOption(label, checked, handler) {
  const check = create("input", { type: "checkbox", checked });
  check.addEventListener("change", () => handler(check.checked));
  return create("label", {}, check, label);
}

function normalize(text) {
  return String(text ?? "").normalize("NFKC").trim().toLocaleLowerCase("ko-KR").replace(/\s+/g, "");
}

function usable(fund) {
  return fund.latest?.complete === true && fund.previous?.complete === true
    && fund.comparison?.from === fund.previous.date && fund.comparison?.to === fund.latest.date
    && fund.latest.date > fund.previous.date && Array.isArray(fund.comparison.changes);
}

function weightBasis(fund) {
  return fund.comparison?.weightBasis?.trim() || PUBLISHED_WEIGHT;
}

function basisLabel(fund) {
  const basis = weightBasis(fund);
  return create("span", { className: "etf-weight-basis" + (basis !== PUBLISHED_WEIGHT ? " recalculated" : ""), text: basis });
}

function dateStatus(fund, diagnostic) {
  if (fund.status === "link_only") return create("span", {}, badge("missing", "원문 연결"), create("small", { text: fund.statusReason || "공개 가능한 전체 보유내역 원천이 필요합니다." }));
  if (usable(fund)) {
    const flag = fund.status === "delayed" ? badge("delayed", "비교 가능 · 지연") : badge("current", "비교 가능");
    return create("span", {}, flag, diagnostic && create("small", { text: diagnostic }));
  }
  const text = diagnostic || (fund.latest?.complete ? "비교할 직전 전체 보유내역을 확보하는 중입니다." : "비교용 전체 구성 내역을 확보하지 못했습니다.");
  return create("span", {}, badge(fund.latest?.complete ? "partial" : "missing"), create("small", { text }));
}

function buildResults(title, side) {
  const rows = create("div");
  const count = create("span", { className: "etf-count", role: "status" });
  const card = create("article", { className: "card span-6 etf-list " + side },
    create("div", { className: "card-head" }, create("h3", { text: title }), count), rows);
  return { card, rows, count, title };
}

function renderRows(results, rows, emptyMessage) {
  results.count.textContent = rows.length.toLocaleString("ko-KR") + "건";
  results.rows.replaceChildren(rows.length ? table(
    ["종목", "ETF", "구분", "이전 → 현재", "변화폭"],
    rows.map(({ change, fund }) => [
      create("span", {}, change.name || change.code, create("small", { text: change.code })),
      create("span", { text: fund.name }),
      badge(change.kind, KINDS[change.kind]),
      quantity(change.previousWeight, "%", 4) + " → " + quantity(change.newWeight, "%", 4),
      create("strong", { className: direction(change.deltaPp), text: signed(change.deltaPp, "%p", 4) }),
    ]),
    { numeric: [3, 4], label: results.title },
  ) : empty(emptyMessage));
}

export function renderEtf(data, fetchError) {
  const funds = data?.etfs || [];
  if (!funds.length) {
    return create("article", { className: "card span-12" },
      cardHeading("ETF 구성 비교"),
      empty(fetchError || "N/A · ETF 공시 데이터가 아직 없습니다."));
  }
  if (state.funds === null) state.funds = new Set(funds.map((fund) => fund.id));
  const issuesById = new Map();
  for (const issue of data.errors || []) {
    if (!issuesById.has(issue.id)) issuesById.set(issue.id, []);
    issuesById.get(issue.id).push(issue.message || issue.code);
  }
  const filter = create("article", { className: "card card-pad span-12" });
  const search = create("input", { type: "search", value: state.search, placeholder: "종목명 또는 코드" });
  const threshold = create("input", { type: "number", min: 0, max: 100, step: "any", inputmode: "decimal", value: state.minimum });
  const kinds = create("div", { className: "check-group" });
  const reset = create("button", { className: "button", type: "button", text: "필터 초기화" });
  const csv = create("button", { className: "button", type: "button", text: "CSV" });
  const fundChoices = create("div", { className: "check-group" });
  const selectedDate = create("p", { className: "meta" });

  filter.append(create("div", { className: "etf-filter-grid" },
    create("label", { className: "field" }, "종목 검색", search),
    create("label", { className: "field" }, "최소 변화폭 (%p)", threshold),
    create("fieldset", { className: "field-group" }, create("legend", { text: "변화 분류" }), kinds),
    create("div", { className: "action-row" }, reset, csv)),
  create("fieldset", { className: "field-group etf-funds" }, create("legend", { text: "ETF 선택" }), fundChoices),
  selectedDate);

  const positive = buildResults("신규 · 비중 확대", "etf-positive");
  const negative = buildResults("비중 축소 · 편출", "etf-negative");
  const comparisonReady = funds.filter(usable);
  const allRows = comparisonReady.flatMap((fund) => fund.comparison.changes
    .filter((change) => Object.hasOwn(KINDS, change.kind)).map((change) => ({ fund, change })));
  let filtered = [];

  function update() {
    const searchKey = normalize(state.search);
    const selected = funds.filter((fund) => state.funds.has(fund.id));
    const ready = selected.filter(usable).length;
    selectedDate.textContent = "비교 가능 ETF " + ready + " / 선택 " + selected.length
      + " · 파일 생성 " + timestamp(data.generatedAt) + " KST";
    filtered = allRows.filter(({ fund, change }) => state.funds.has(fund.id) && state.kinds.has(change.kind)
      && (normalize(change.name).includes(searchKey) || normalize(change.code).includes(searchKey))
      && (state.minimum === 0 || (valid(change.deltaPp) && Math.abs(change.deltaPp) >= state.minimum)));
    filtered.sort((a, b) => (Math.abs(b.change.deltaPp ?? 0) - Math.abs(a.change.deltaPp ?? 0))
      || (a.change.name || a.change.code).localeCompare(b.change.name || b.change.code, "ko"));
    const message = !selected.length ? "ETF를 한 개 이상 선택하세요."
      : !ready ? "선택한 ETF의 두 기준일 완전한 보유내역이 필요합니다."
      : "표시할 종목이 없습니다.";
    renderRows(positive, filtered.filter(({ change }) => change.kind === "entry" || change.kind === "increase"), message);
    renderRows(negative, filtered.filter(({ change }) => change.kind === "exit" || change.kind === "decrease"), message);
    csv.disabled = !filtered.length;
  }

  function rebuildOptions() {
    kinds.replaceChildren(...Object.entries(KINDS).map(([key, label]) => checkOption(label, state.kinds.has(key), (checked) => {
      if (checked) state.kinds.add(key);
      else state.kinds.delete(key);
      update();
    })));
    fundChoices.replaceChildren(...funds.map((fund) => {
      const ready = usable(fund);
      const dates = ready ? fund.comparison.from + " → " + fund.comparison.to : fund.status === "link_only" ? "원문 연결" : (fund.latest?.date || "N/A") + " · 비교 대기";
      const label = create("span", {}, fund.name, create("small", { className: "fund-dates", text: dates }), ready && basisLabel(fund));
      return checkOption(label, state.funds.has(fund.id), (checked) => {
        if (checked) state.funds.add(fund.id);
        else state.funds.delete(fund.id);
        update();
      });
    }));
  }

  search.addEventListener("input", () => {
    state.search = search.value;
    update();
  });
  threshold.addEventListener("input", () => {
    if (!threshold.validity.valid) return;
    state.minimum = threshold.valueAsNumber || 0;
    update();
  });
  reset.addEventListener("click", () => {
    state.search = "";
    state.minimum = 0;
    state.funds = new Set(funds.map((fund) => fund.id));
    state.kinds = new Set(Object.keys(KINDS));
    search.value = "";
    threshold.value = "0";
    rebuildOptions();
    update();
  });
  csv.addEventListener("click", () => downloadCsv("etf-holdings-changes.csv", [
    ["종목코드", "종목명", "ETF", "ETF 코드", "분류", "이전 기준일", "현재 기준일", "비중 기준", "이전 비중 (%)", "현재 비중 (%)", "변화 (%p)", "CU당 수량 변화"],
    ...filtered.map(({ fund, change }) => [change.code, change.name, fund.name, fund.ticker, KINDS[change.kind],
      fund.comparison.from, fund.comparison.to, weightBasis(fund), change.previousWeight, change.newWeight, change.deltaPp, change.quantityChange]),
  ]));

  const dates = create("article", { className: "card span-12" },
    cardHeading("ETF별 비교 기준일", "펀드마다 공개된 보유내역의 기준일이 다를 수 있습니다."),
    table(["ETF", "이전 기준일", "현재 기준일", "비중 기준", "비교 상태", "자료 출처"], funds.map((fund) => [
      create("span", {}, fund.name, create("small", { text: [fund.issuer, fund.ticker].filter(Boolean).join(" · ") })),
      fund.previous?.date || "N/A",
      fund.latest?.date || "N/A",
      usable(fund) ? basisLabel(fund) : "N/A",
      dateStatus(fund, issuesById.get(fund.id)?.join(" · ")),
      sourceLink(fund.sourceName || fund.issuer || "자료 출처", fund.sourceUrl),
    ]), { label: "ETF별 기준일과 자료 출처", className: "etf-source-table" }));
  const note = create("div", { className: "notice span-12" },
    "변화폭은 두 기준일의 ETF 구성 비중 차이입니다. 가격 변동도 비중에 반영되므로 실제 매매 여부를 확인하려면 운용 내역이 필요합니다.");
  const hasRecalculatedWeight = comparisonReady.some((fund) => weightBasis(fund) !== PUBLISHED_WEIGHT);
  const criteria = create("details", { className: "card etf-criteria span-12" },
    create("summary", { text: "편입·편출 및 수량 기준" }),
    create("p", { className: "notice" }, "신규와 편출은 같은 ETF의 두 전체 보유 목록에서 종목이 나타나거나 사라진 경우입니다. CSV 수량은 ETF의 1설정단위(CU)당 보유 수량 차이입니다. 확인 가능한 비중이 없으면 N/A로 표시합니다."),
    hasRecalculatedWeight && create("p", { className: "notice" },
      "대체 출처를 사용한 ETF의 비중은 두 기준일 각각의 현금을 포함한 전체 평가액을 분모로 삼아 같은 산식으로 재계산합니다."));
  rebuildOptions();
  update();
  return [filter, note, positive.card, negative.card, dates, criteria];
}
