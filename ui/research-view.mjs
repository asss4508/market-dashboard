import { badge, cardHeading, create, direction, empty, format, quantity, signed, sourceLink, table, timestamp, valid } from "./dom.mjs";
import { SCORE_LABELS } from "./market.mjs";

function trgm(value) {
  return String(value || "").replaceAll("_", " ");
}

function interval(values, unit = "%") {
  return values?.length === 2 && values.every(valid) ? quantity(values[0], unit) + " ~ " + quantity(values[1], unit) : "N/A";
}

export function renderScores(research) {
  const panel = create("article", { className: "card card-pad score-panel span-4" }, create("h3", { text: "시장 국면과 점수" }));
  const regime = research?.regime;
  const label = regime?.label || "N/A";
  const riskScore = Math.max(research?.scores?.stress?.value ?? -1, research?.scores?.overheat?.value ?? -1);
  const riskLevel = riskScore >= 75 ? "high" : riskScore >= 60 ? "caution" : riskScore >= 0 ? "low" : "unrated";
  panel.append(create("div", { className: "regime-card", "data-risk": riskLevel },
    create("small", { text: "시장 국면" + (research?.asOf ? " · " + research.asOf : "") }),
    create("strong", { text: label }),
    create("p", { className: "meta", text: regime?.reason || "지수 기준일에 사용할 분석 자료를 확보하지 못했습니다." }),
    research?.previousRegime?.label && create("p", { className: "meta", text: "직전 관측일 · " + research.previousRegime.label }),
  ));
  const scores = create("div", { className: "score-list" });
  for (const [id, name] of Object.entries(SCORE_LABELS)) {
    const score = research?.scores?.[id];
    const value = score?.value;
    const level = id === "momentum" ? "momentum" : value >= 75 ? "high" : value >= 60 ? "guard" : "normal";
    const item = create("section", { className: "score", "data-level": level },
      create("h4", { text: name }),
      create("div", { className: "score-value" }, format(value, 1), valid(value) && create("small", { text: "/100" })),
    );
    if (valid(value)) {
      const bar = create("span");
      bar.style.width = Math.max(0, Math.min(100, value)) + "%";
      item.append(create("div", { className: "score-track", role: "meter", "aria-label": name,
        "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": value }, bar));
    }
    const coverage = score ? "사용 " + score.used + "/" + score.total + " · 가중치 커버리지 " + quantity(score.coveragePct, "%", 0)
      : "계산 자료 대기";
    item.append(create("p", { className: "meta", text: [coverage, score?.reason].filter(Boolean).join(" · ") }));
    scores.append(item);
  }
  panel.append(scores);
  return panel;
}

export function renderContributors(research) {
  const card = create("article", { className: "card card-pad span-5" }, create("h3", { text: "상위 5개 점수 기여 지표" }));
  const entries = (research?.contributors || []).slice(0, 5);
  if (!entries.length) {
    card.append(create("p", { className: "meta", text: "점수에 반영할 수 있는 관측치가 부족합니다." }));
    return card;
  }
  const items = entries.map((item) => create("li", {},
    create("strong", { text: item.label }),
    create("span", { className: "bar-value " + direction(item.contribution), text: signed(item.contribution, "점", 1) }),
    create("small", { text: [
      SCORE_LABELS[item.group] || item.group,
      quantity(item.value, item.unit),
      item.date,
      valid(item.percentile) ? "백분위 " + format(item.percentile, 1) : null,
    ].filter(Boolean).join(" · ") }),
  ));
  card.append(create("ul", { className: "contrib-list" }, items));
  return card;
}

export function renderDiagnosis(research) {
  const card = create("article", { className: "card card-pad span-7" }, create("h3", { text: "시장 진단" }));
  const diagnosis = research?.diagnosis || [];
  if (!diagnosis.length) {
    card.append(create("p", { className: "meta", text: "자료를 바탕으로 계산된 시장 진단이 없습니다." }));
    return card;
  }
  card.append(create("ul", { className: "diagnosis-list" }, diagnosis.map((item) => create("li", {},
    create("strong", {}, item.title, item.kind === "limitation" && [" ", badge("caution", "자료 한계")]),
    create("p", { text: item.text }),
  ))));
  return card;
}

export function renderMetrics(title, features, selection = null) {
  const entries = selection ? features.filter((feature) => selection.includes(feature.id)) : features;
  const headers = ["지표", "관측일", "값", "5일 Δ", "20일 Δ", "1년 평균", "1년 표준편차", "1년 백분위 / Z", "3년 백분위 / Z", "5년 백분위 / Z"];
  const rows = entries.map((entry) => [
    entry.label, entry.date || "N/A", quantity(entry.value, entry.unit),
    signed(entry.change5, entry.unit), signed(entry.change20, entry.unit),
    quantity(entry.mean, entry.unit), quantity(entry.sd, entry.unit),
    ...[252, 756, 1260].map((days) => format(entry.ranks?.[days], 1) + " / " + format(entry.zs?.[days], 2)),
  ]);
  return create("article", { className: "card span-12" },
    cardHeading(title, "5일·20일 변화는 관측 단위 차이입니다. 백분위와 Z점수의 기간은 252·756·1,260개 관측치입니다."),
    rows.length ? table(headers, rows, { numeric: [2, 3, 4, 5, 6, 7, 8, 9], label: title }) : empty("N/A · 계산된 시계열 지표가 없습니다."),
  );
}

export function renderSeriesTable(title, ids, dashboard) {
  const map = new Map(dashboard.catalog.map((entry) => [entry.id, entry]));
  const headers = ["지표", "최근 값", "관측일", "상태", "정의 및 출처"];
  const rows = ids.map((id) => {
    const line = dashboard.series[id];
    const entry = map.get(id);
    const point = line?.points?.at(-1);
    return [
      create("strong", { text: line?.label || entry?.label || trgm(id) }),
      quantity(point?.value, line?.unit),
      point?.date || "N/A",
      create("span", {}, badge(line?.status || "missing"),
        (line?.error || entry?.limitation) && create("small", { text: line?.error || entry?.limitation })),
      create("span", {},
        sourceLink(line?.source?.name || "자료 출처", line?.source?.url || entry?.sourceUrl),
        (line?.definition || entry?.definition) && create("small", { text: line?.definition || entry?.definition })),
    ];
  });
  return create("article", { className: "card span-12" }, cardHeading(title),
    table(headers, rows, { numeric: [1], label: title }));
}

export function renderCorrelations(items, features) {
  const title = "점수 구성 지표의 상관";
  const header = cardHeading(title, "최근 252개 코스피 관측일에 같은 날짜의 지표 수준을 짝지어 계산합니다.");
  const card = create("article", { className: "card span-12" }, header);
  if (!items.length) {
    card.append(empty("N/A · 공통 관측치가 부족합니다."));
    return card;
  }
  const labels = new Map(features.map((feature) => [feature.id, feature.label]));
  card.append(table(["비교 지표 A", "비교 지표 B", "상관계수", "공통 표본", "상태"],
    items.map((item) => [labels.get(item.left) || item.left, labels.get(item.right) || item.right,
      format(item.r, 3), format(item.n, 0),
      item.flag ? badge("caution", "중복 주의") : valid(item.r) ? "계산됨" : "표본 부족"]),
    { numeric: [2, 3], label: title }));
  return card;
}

export function renderBacktest(research, labels, showAll) {
  const data = research?.backtest;
  if (!data?.groups?.length) return create("article", { className: "card span-12" },
    cardHeading("조건부 코스피 수익률"), empty("N/A · 백테스트 산출 자료가 없습니다."));
  const header = ["조건", "보유 기간", "표본", "평균", "중앙값", "상승 비율", "평균 95% CI", "상승 95% CI", "최대 낙폭", "표준편차", "전체 평균", "초과 수익"];
  const oosHeader = ["조건", "보유 기간", "표본", "평균", "상승 비율", "Brier 점수", "기준 Brier", "검증 구간"];
  const rows = [];
  const oos = [];
  for (const group of data.groups) {
    for (const row of group.horizons) {
      const condition = create("span", {}, create("strong", { text: group.label || labels[group.id] || group.id }),
        group.condition && create("small", { text: group.condition }));
      rows.push([condition, row.horizon + " 거래일", format(row.n, 0), quantity(row.mean, "%"),
        quantity(row.median, "%"), quantity(row.upProbability, "%"), interval(row.ci), interval(row.upCi),
        quantity(row.maxDrawdown, "%"), quantity(row.sd, "%"), quantity(row.baselineMean, "%"), quantity(row.excess, "%p")]);
      if (row.oos) {
        oos.push([group.label, row.horizon + " 거래일", format(row.oos.n, 0), quantity(row.oos.mean, "%"),
          quantity(row.oos.upProbability, "%"), format(row.oos.brier, 4), format(row.oos.baselineBrier, 4),
          Array.isArray(row.oos.folds) ? format(row.oos.folds.length, 0) : format(row.oos.folds, 0)]);
      }
    }
  }
  const info = create("article", { className: "card span-12" },
    cardHeading("백테스트 전제"),
    create("ul", { className: "table-note-list" }, (data.assumptions || []).map((line) => create("li", { text: line }))));
  return [
    create("article", { className: "card span-12" },
      cardHeading("조건부 코스피 수익률", research.benchmark?.label
        ? "분석 기준 · " + research.benchmark.label + " · " + (research.asOf || "N/A") : null),
      table(header, rows, { numeric: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11], label: "코스피 조건부 수익률" })),
    create("details", { className: "card etf-criteria span-12", open: showAll },
      create("summary", { text: "워크포워드 검증" }),
      oos.length ? table(oosHeader, oos, { numeric: [2, 3, 4, 5, 6, 7], label: "워크포워드 검증 결과" })
        : empty("N/A · 검증할 표본이 부족합니다.")),
    info,
  ];
}

export function renderStatus(dashboard, extra) {
  const content = create("div");
  content.append(create("p", { className: "meta", text: "대시보드 파일 생성 " + timestamp(dashboard.generatedAt) + " KST" }));
  if (extra.freshness) content.append(create("p", { className: "notice warning", text: extra.freshness }));
  if (extra.intraday?.message) content.append(create("p", { className: "meta", text: "장중 데이터 · " + extra.intraday.message }));
  const errors = [...(extra.errors || []), ...dashboard.diagnostics.map((item) => item.id + " · " + item.message
    + (item.at ? " · " + timestamp(item.at) + " KST" : ""))].filter(Boolean);
  if (errors.length) {
    content.append(create("h3", { text: "수집 및 불러오기 상태" }),
      create("ul", { className: "table-note-list" }, errors.map((text) => create("li", { text }))));
  }

  const input = create("input", { type: "search", placeholder: "지표명, 범위, 출처" });
  const rows = create("div");
  content.append(create("h3", { text: "시장 데이터 출처와 관측일" }),
    create("label", { className: "field" }, "지표 검색", input), rows);

  function update() {
    const key = input.value.trim().toLowerCase();
    const catalog = dashboard.catalog.filter((item) => {
      const line = dashboard.series[item.id];
      return [item.id, item.label, item.category, line?.scope, line?.source?.name].some((value) => value?.toLowerCase().includes(key));
    });
    const entries = catalog.map((item) => {
      const line = dashboard.series[item.id];
      return [
        create("span", {}, item.label, create("small", { text: item.category })),
        line?.asOf || "N/A",
        create("span", {}, badge(line?.status || item.status || "missing"),
          (line?.error || item.limitation) && create("small", { text: line?.error || item.limitation })),
        create("span", {}, sourceLink(line?.source?.name || "출처", item.sourceUrl || line?.source?.url),
          create("small", { text: [item.access, item.license].filter(Boolean).join(" · ") })),
        create("span", {}, timestamp(line?.collectedAt),
          line?.lastAttemptAt && create("small", { text: "시도 " + timestamp(line.lastAttemptAt) })),
      ];
    });
    rows.replaceChildren(entries.length ? table(["지표", "관측일", "상태", "출처와 이용 범위", "수집 (KST)"],
      entries, { label: "데이터 수집 상태" }) : empty("검색 결과가 없습니다."));
  }
  input.addEventListener("input", update);
  update();
  return content;
}
