import fs from "node:fs";

export function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  values.push(current);
  return values;
}

export function readCsvFile(filePath, options = {}) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "").trim();
  if (!text) return { headers: [], rows: [] };
  const lines = text.split(/\r?\n/u);
  const headers = parseCsvLine(lines.shift() || "");
  for (const required of options.requiredHeaders || []) {
    if (!headers.includes(required)) throw new Error(`${filePath}: missing ${required} column`);
  }
  const rows = lines.filter(Boolean).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
  return { headers, rows };
}

export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

export function formatCsvRow(values) {
  return values.map(csvEscape).join(",");
}

export function serializeCsv(headers, rows) {
  return `${[
    formatCsvRow(headers),
    ...rows.map((row) => formatCsvRow(headers.map((header) => row[header] ?? ""))),
  ].join("\n")}\n`;
}
