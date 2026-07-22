import fs from "node:fs";

export function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`${filePath}: invalid JSON (${error.message})`, { cause: error });
  }
}
