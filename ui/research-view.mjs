import { badge, cardHeading, create, direction, empty, format, quantity, signed, sourceLink, table, timestamp, valid } from "./dom.mjs";
import { SCORE_LABELS } from "./market.mjs";

function trgm(value) {
  return String(value || "").replaceAll("_", " ");
}

function interval(values, unit = "%") {
  return values?.length === 2 && values.every(valid) ? quantity(values[0], unit) + " ~ " + quantity(values[1], unit) : "N/A";
}

export function renderScores(research) {
  const panel = create("article", { className: "card card-pad score-panel span-4" }, create("h3", { text: "현재 신호" }),
    create("p", { className: "meta", text: "기준일 " + (research?.conclusion?.asOf || research?.asOf || "미확인") + " · 점수는 100점 기준" }));
  const scores = create("div", { className: "score-list" });
  const basis = create("details", { className: "score-basis" }, create("summary", { text: "계산 근거" }),
    create("p", { className: "meta", text: "반영 지표 수와 가중치 비중은 계산에 사용한 자료의 범위이며, 예측 정확도가 아닙니다." }));
  const basisItems = create("ul");
  for (const [id, name] of Object.entries(SCORE_LABELS)) {
    const score = research?.scores?.[id];
    const explanation = research?.conclusion?.scoreLabels?.[id];
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
    item.append(create("p", { className: "score-meaning" },
      create("strong", { text: explanation?.label || (valid(value) ? "분석값 확인" : "자료 부족") }),
      create("span", { text: explanation?.text || score?.reason || "점수 해석에 필요한 분석 자료를 확인하고 있습니다." })));
    const coverage = score ? "설정 지표 " + score.total + "개 중 " + score.used + "개 반영 · 설정 가중치의 " + quantity(score.coveragePct, "%", 0) + " 반영"
      : "계산 자료 미확보";
    basisItems.append(create("li", {}, create("strong", { text: name }),
      create("p", { text: [coverage, score?.reason].filter(Boolean).join(" · ") })));
    scores.append(item);
  }
  basis.append(basisItems);
  panel.append(scores, basis);
  return panel;
}

export function renderConclusion(research, options = {}) {
  const conclusion = research?.conclusion;
  const recorded = Boolean(options.freshness || research?.stale);
  const asOf = conclusion?.asOf || research?.analysisThrough || research?.asOf;
  const card = create("article", { className: "card decision-card span-12", "data-tone": conclusion?.tone || "data", "aria-labelledby": "decision-headline" });
  const top = create("div", { className: "decision-topline" },
    create("p", { className: "decision-eyebrow", text: recorded ? "기록된 분석" : "지금의 판단" }),
    create("p", { className: "decision-date", text: asOf ? (recorded ? "기록된 분석 기준일 · " : "분석 기준일 · ") + asOf : "분석 기준일 미확인" }));
  card.append(top);
  const warning = options.freshness || (research?.stale ? "분석 기준일 이후 자료가 반영되지 않았습니다. 아래 판단은 기록된 기준일의 자료에 근거합니다." : null);
  if (warning) card.append(create("p", { className: "notice warning decision-freshness", text: warning }));
  card.append(create("h3", { id: "decision-headline", text: conclusion?.headline || "시장 판단을 위한 분석 자료가 부족합니다." }));
  if (conclusion?.stance) card.append(create("p", { className: "decision-stance", text: conclusion.stance }));
  card.append(create("p", { className: "decision-summary", text: conclusion?.summary || "지표별 관측일과 확보 상태를 확인한 뒤 분석을 갱신해야 합니다." }));

  const evidence = conclusion?.evidence || [];
  if (evidence.length) card.append(create("div", { className: "decision-evidence", "aria-label": "판단 근거" }, evidence.map((item) =>
    create("section", { className: "decision-fact" },
      create("h4", { text: item.label }),
      create("p", { className: "decision-fact-value", text: valid(item.value) ? quantity(item.value, item.unit) : item.value || "자료 부족" }),
      create("p", { className: "decision-fact-meaning", text: item.meaning }),
      item.date && create("p", { className: "meta", text: item.date + " 기준" }))
  )));

  const watch = conclusion?.watch || [];
  if (watch.length) card.append(create("div", { className: "decision-watch", "aria-label": "판단이 달라질 조건" }, watch.slice(0, 2).map((item) =>
    create("section", {}, create("h4", { text: item.label }), create("p", { text: item.text }))
  )));

  const backtest = conclusion?.backtest;
  const limitations = conclusion?.limitations || [];
  const details = backtest || limitations.length || watch.length > 2 ? create("details", { className: "decision-details" },
    create("summary", { text: "과거 결과와 분석 범위" })) : null;
  if (watch.length > 2) details.append(create("div", { className: "decision-watch decision-watch-extra" }, watch.slice(2).map((item) =>
    create("section", {}, create("h4", { text: item.label }), create("p", { text: item.text }))
  )));
  if (backtest) {
    const historical = create("section", { className: "decision-history", "aria-label": "같은 조건의 과거 결과" },
      create("h4", { text: "같은 조건의 과거 결과" }),
      create("p", { className: "meta", text: (backtest.label || "") + (backtest.condition ? " · " + backtest.condition : "") + " · 이후 " + backtest.horizon + " 거래일" }));
    const statistics = [
      ["표본 수", format(backtest.n, 0) + "개"],
      ["과거 상승 비율", quantity(backtest.upProbability, "%")],
      ["상승 비율 95% 신뢰구간", interval(backtest.upCi)],
      ["평균 수익률", signed(backtest.mean, "%")],
      ["전체 기간 평균", signed(backtest.baselineMean, "%")],
      ["전체 평균 대비", signed(backtest.excess, "%p")],
    ];
    historical.append(create("dl", { className: "decision-statistics" }, statistics.map(([label, value]) =>
      create("div", {}, create("dt", { text: label }), create("dd", { text: value })))));
    historical.append(create("p", { className: "decision-history-note", text: "과거에 이 조건이 성립한 표본의 결과이며, 앞으로의 상승 확률이 아닙니다." }));
    if (backtest.note) historical.append(create("p", { className: "meta", text: backtest.note }));
    if (backtest.oos) historical.append(create("p", { className: "meta", text: backtest.oos.n > 0
      ? "워크포워드 검증 · 표본 " + format(backtest.oos.n, 0) + "개 · 과거 상승 비율 " + quantity(backtest.oos.upProbability, "%")
        + " · 평균 수익률 " + signed(backtest.oos.mean, "%")
      : "워크포워드 검증에 필요한 학습·검증 표본이 부족해 검증 성과를 제시하지 않습니다." }));
    details.append(historical);
  }
  if (limitations.length) details.append(create("p", { className: "decision-limitations", text: "해석의 범위 · " + limitations.join(" ") }));
  if (details) card.append(details);
  if (conclusion?.basisNote) card.append(create("p", { className: "decision-basis-note", text: conclusion.basisNote }));
  return card;
}

export function renderContributors(research) {
  const card = create("details", { className: "card calculation-details span-12" }, create("summary", { text: "점수 산식과 기여 지표" }));
  const content = create("div", { className: "calculation-content" },
    create("p", { className: "meta", text: "각 지표의 과거 분포상 위치에 설정 가중치를 적용해 점수를 계산합니다. 아래 수치는 점수에 더해진 기여도이며, 향후 수익률의 예측값이 아닙니다." }),
    create("h4", { text: "상위 5개 점수 기여 지표" }));
  card.append(content);
  const entries = (research?.contributors || []).slice(0, 5);
  if (!entries.length) {
    content.append(create("p", { className: "meta", text: "점수에 반영할 수 있는 관측치가 부족합니다." }));
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
  content.append(create("ul", { className: "contrib-list" }, items));
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
