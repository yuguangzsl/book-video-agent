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
  if (quoted) throw new Error("script.csv contains an unterminated quoted field");
  values.push(current);
  return values;
}

export function readScriptRows(scriptPath, scriptVersion = "") {
  const lines = fs.readFileSync(scriptPath, "utf8").trim().split(/\r?\n/u);
  const headers = parseCsvLine(lines.shift() || "");
  for (const required of ["version", "order", "text"]) {
    if (!headers.includes(required)) throw new Error(`${scriptPath}: missing ${required} column`);
  }
  const rows = lines
    .filter(Boolean)
    .map((line) => {
      const values = parseCsvLine(line);
      return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    })
    .filter((row) => !scriptVersion || row.version === scriptVersion)
    .sort((a, b) => Number(a.order) - Number(b.order));
  if (scriptVersion && rows.length === 0) throw new Error(`No script rows found for version ${scriptVersion}`);
  return rows;
}
