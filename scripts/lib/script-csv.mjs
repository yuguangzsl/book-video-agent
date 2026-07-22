import { parseCsvLine, readCsvFile } from "./csv.mjs";

export { parseCsvLine };

export function readScriptRows(scriptPath, scriptVersion = "") {
  const { rows: csvRows } = readCsvFile(scriptPath, { requiredHeaders: ["version", "order", "text"] });
  const rows = csvRows
    .filter((row) => !scriptVersion || row.version === scriptVersion)
    .sort((a, b) => Number(a.order) - Number(b.order));
  if (scriptVersion && rows.length === 0) throw new Error(`No script rows found for version ${scriptVersion}`);
  return rows;
}
