import fs from "node:fs";
import path from "node:path";

export function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath);
    else if (entry.isFile()) fs.copyFileSync(sourcePath, targetPath);
    else throw new Error(`Unsupported directory entry: ${sourcePath}`);
  }
}

export function removeDirectory(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

export function writeFileAtomically(filePath, content, options = {}) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tempPath, content, options);
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
}
