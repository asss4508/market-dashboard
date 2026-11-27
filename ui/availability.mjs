import { badge, cardHeading, create, empty, sourceLink, table, timestamp, valid } from "./dom.mjs";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function observation(line) {
  let date = null;
  for (const point of line?.points || []) {
    if (valid(point.value) && datePattern.test(point.date) && (!date || point.date > date)) date = point.date;
  }
  return { available: Boolean(date), date: date || (datePattern.test(line?.asOf || "") ? line.asOf : null) };
}

function stateFor(line, observed) {
  if (line?.error) return { code: "error", label: line.lastAttemptAt ? "수집 실패" : "수집 오류 기록" };
  if (observed.available && !line.lastAttemptAt) return { code: "delayed", label: "보관 자료만 있음" };
  if (observed.available) return line.status === "delayed"
    ? { code: "delayed", label: "갱신 지연" } : { code: "available", label: "자료 확보" };
  return { code: "missing", label: line?.lastAttemptAt ? "관측치 미확보" : "원천 자료 미확보" };
}

function sourceDetails(line, entry) {
  const primary = line?.source || {};
  const registered = entry?.source || {};
  const catalogUrl = entry?.sourceUrl || registered.url;
  const different = primary.url && catalogUrl && primary.url !== catalogUrl;
  const sources = [{
    name: primary.name || registered.name || "공식 출처",
    url: primary.url || catalogUrl,
    access: primary.access || (!different && (entry?.access || registered.access)),
    license: primary.license || (!different && (entry?.license || registered.license)),
  }];
  if (different) sources.push({ name: registered.name || "등록 출처", url: catalogUrl,
    access: entry?.access || registered.access, license: entry?.license || registered.license });
  return sources.map((source) => create("div", {},
    create("small", {}, sourceLink("공식 원문 · " + source.name, source.url)),
    source.access && create("small", { text: "접근 방식 · " + source.access }),
    source.license && create("small", { text: "이용 조건(등록 정보) · " + source.license }),
    !source.url && create("small", { text: "공식 원문 링크 미등록" }),
  ));
}

export function renderAvailability(title, ids, dashboard, options = {}) {
  const catalog = new Map((dashboard?.catalog || []).map((entry) => [entry.id, entry]));
  const rows = [...new Set(ids || [])].map((id) => {
    const line = dashboard?.series?.[id];
    const entry = catalog.get(id);
    const observed = observation(line);
    const state = stateFor(line, observed);
    const attempt = line?.lastAttemptAt;
    const attemptText = attempt ? timestamp(attempt) : "시도 기록 없음";
    const attemptCell = create("span", { className: "no-wrap", text: attemptText === "N/A" ? "시각 확인 필요" : attemptText });
    if (attempt && attemptText !== "N/A") attemptCell.append(create("small", { text: "KST · 수집 시도 시각" }));
    const stateCell = create("span", {}, badge(state.code, state.label),
      line?.error && create("small", { text: line.error }),
      observed.available && !attempt && create("small", { text: "최근 수집 시도 기록 없이 보관된 관측값입니다." }),
      !observed.available && !attempt && create("small", { text: "수집 시도 기록이 없습니다. 필요한 원천은 오른쪽에서 확인할 수 있습니다." }));
    const requirements = [entry?.requiredData, entry?.limitation, entry?.nextAction]
      .filter((value) => typeof value === "string" && value.trim());
    const action = create("div", {},
      ...[...new Set(requirements.length ? requirements : [observed.available
        ? "관측일을 기준으로 자료 범위를 확인하고, 원천의 후속 공표 자료와 수집 연결 상태를 확인해야 합니다."
        : "필요한 원천 자료와 수집 연결 상태를 확인해야 합니다."])]
        .map((text) => create("p", { text })),
      ...sourceDetails(line, entry));
    return [
      create("span", {}, create("strong", { text: line?.label || entry?.label || id }),
        entry?.definition && create("small", { text: entry.definition })),
      create("span", { className: "no-wrap", text: observed.date || "관측값 없음" }),
      attemptCell,
      stateCell,
      action,
    ];
  });
  return create("article", { className: "card span-12 availability-card" },
    cardHeading(title, options.message || "관측일은 실제 수치의 기준일입니다. 마지막 수집 시각이 최근이어도 관측값이 갱신됐다는 뜻은 아닙니다."),
    rows.length ? table(["지표", "관측일", "마지막 수집 시도", "상태", "필요 자료 · 다음 조치 · 공식 출처"], rows,
      { label: title }) : empty("표시할 지표가 없습니다."));
}
