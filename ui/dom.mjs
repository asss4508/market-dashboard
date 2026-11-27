export const byId = (id) => document.getElementById(id);
export const valid = Number.isFinite;

export function create(tag, attrs = {}, ...content) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "checked") node.checked = value;
    else if (key === "disabled") node.disabled = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const item of content.flat()) {
    if (item != null && item !== false) node.append(item);
  }
  return node;
}

export function sourceLink(label, url) {
  if (!url || !/^https?:\/\//i.test(url)) return create("span", { text: label });
  return create("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: label });
}

export const timeZone = "Asia/Seoul";
const localDateTime = new Intl.DateTimeFormat("ko-KR", {
  timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

export function timestamp(value) {
  if (!value || !valid(Date.parse(value))) return "N/A";
  return localDateTime.format(new Date(value));
}

const numberFormatters = [0, 1, 2, 3, 4].map((digits) => new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: digits,
}));

export function format(value, digits = 2) {
  return valid(value) ? numberFormatters[digits].format(value) : "N/A";
}

export function quantity(value, unit = "", digits = 2) {
  if (!valid(value)) return "N/A";
  return format(value, digits) + (unit ? (unit === "%" || unit === "%p" ? "" : " ") + unit : "");
}

export function signed(value, unit = "", digits = 2) {
  if (!valid(value)) return "N/A";
  return (value > 0 ? "+" : "") + quantity(value, unit, digits);
}

export function direction(value) {
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "flat";
}

export const STATUS = {
  current: "최근 관측", delayed: "지연", missing: "미확보", closed: "휴장",
  partial: "비교 대기", error: "수집 오류", ready: "비교 가능", available: "비교 가능",
};

export function badge(status, label = STATUS[status] || status) {
  return create("span", { text: label, className: "pill " + status });
}

export const DAY = 86_400_000;
export const toDay = (str) => Math.round(Date.parse(str) / DAY);
export const dateString = (day) => new Date(day * DAY).toISOString().slice(0, 10);
export const koreaDate = () => new Intl.DateTimeFormat("sv-SE", { timeZone }).format(new Date());

export function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map((value) => {
    if (value == null) return "";
    if (typeof value === "number") return valid(value) ? String(value) : "";
    const input = String(value);
    const safe = /^[=+\-@\t\r]/.test(input) ? "'" + input : input;
    return '"' + safe.replaceAll('"', '""') + '"';
  }).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
  const link = create("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function table(headers, rows, options = {}) {
  const label = options.label ?? "데이터 표";
  const header = create("thead", {}, create("tr", {}, headers.map((title, i) =>
    create("th", { scope: "col", className: options.numeric?.includes(i) ? "num" : "", text: title })
  )));
  const body = create("tbody", {}, rows.map((row) => create("tr", {},
    row.map((value, i) => create("td", { className: options.numeric?.includes(i) ? "num" : "" }, value))
  )));
  const grid = create("table", { "aria-label": label }, header, body);
  return create("div", { className: "table-scroll" + (options.className ? " " + options.className : ""), tabindex: "0" }, grid);
}

export function cardHeading(title, subtitle) {
  return create("div", { className: "card-head" },
    create("div", {}, create("h3", { text: title }), subtitle && create("p", { className: "meta", text: subtitle })));
}

export function empty(message) {
  return create("div", { className: "empty-state", text: message });
}
