import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { removeDirectory } from "./filesystem.mjs";

export const TEMP_METADATA_FILENAME = ".book-video-temp.json";
export const TEMP_RETENTION_HOURS = Object.freeze({
  active: 24,
  preview: 24,
  failed: 72,
});

function toIso(timestamp) {
  return new Date(timestamp).toISOString();
}

function expiryFrom(now, retentionHours) {
  return toIso(now + retentionHours * 60 * 60 * 1000);
}

function tempRootFor(root) {
  return path.resolve(root, "tmp");
}

function assertInsideTempRoot(root, workspacePath) {
  const tempRoot = tempRootFor(root);
  const resolved = path.resolve(workspacePath);
  const relative = path.relative(tempRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Temporary workspace must be a child of ${tempRoot}`);
  }
  return resolved;
}

function sanitizeSegment(value) {
  return String(value || "job")
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "job";
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function metadataPath(workspacePath) {
  return path.join(workspacePath, TEMP_METADATA_FILENAME);
}

function readMetadata(workspacePath) {
  const filePath = metadataPath(workspacePath);
  if (!fs.existsSync(filePath)) return null;
  try {
    const metadata = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return metadata?.managedBy === "book-video" && metadata?.schemaVersion === 1 ? metadata : null;
  } catch {
    return null;
  }
}

function writeMetadata(workspacePath, metadata) {
  const filePath = metadataPath(workspacePath);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(metadata, null, 2)}\n`);
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
}

export function createTempWorkspace(root, options = {}) {
  const now = options.now ?? Date.now();
  const retentionHours = options.retentionHours ?? TEMP_RETENTION_HOURS.active;
  pruneProjectTempArtifacts(root, { now });

  const tempRoot = tempRootFor(root);
  fs.mkdirSync(tempRoot, { recursive: true });
  const stamp = toIso(now).replace(/[-:.TZ]/gu, "").slice(0, 14);
  const name = [
    sanitizeSegment(options.kind || "work"),
    sanitizeSegment(options.label || "job"),
    stamp,
    process.pid,
    randomUUID().slice(0, 8),
  ].join("-");
  const workspacePath = path.join(tempRoot, name);
  fs.mkdirSync(workspacePath);

  const metadata = {
    schemaVersion: 1,
    managedBy: "book-video",
    kind: String(options.kind || "work"),
    label: String(options.label || "job"),
    owner: String(options.owner || "unknown"),
    pid: process.pid,
    status: "active",
    createdAt: toIso(now),
    updatedAt: toIso(now),
    expiresAt: expiryFrom(now, retentionHours),
    details: options.details || {},
  };
  try {
    writeMetadata(workspacePath, metadata);
  } catch (error) {
    removeDirectory(workspacePath);
    throw error;
  }
  return workspacePath;
}

export function requireManagedTempWorkspace(root, workspacePath) {
  const resolved = assertInsideTempRoot(root, workspacePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Temporary workspace does not exist: ${resolved}`);
  }
  if (!readMetadata(resolved)) {
    throw new Error(`Temporary workspace is not managed by this project: ${resolved}`);
  }
  return resolved;
}

export function updateTempWorkspace(root, workspacePath, options = {}) {
  const resolved = requireManagedTempWorkspace(root, workspacePath);
  const current = readMetadata(resolved);
  const now = options.now ?? Date.now();
  const retentionHours = options.retentionHours;
  const next = {
    ...current,
    status: options.status || current.status,
    updatedAt: toIso(now),
    expiresAt: retentionHours === undefined ? current.expiresAt : expiryFrom(now, retentionHours),
    details: { ...(current.details || {}), ...(options.details || {}) },
  };
  writeMetadata(resolved, next);
  return next;
}

export function removeTempWorkspace(root, workspacePath) {
  const resolved = requireManagedTempWorkspace(root, workspacePath);
  removeDirectory(resolved);
}

export function pruneExpiredTempWorkspaces(root, options = {}) {
  const tempRoot = tempRootFor(root);
  const now = options.now ?? Date.now();
  const result = { removed: [], retained: [], unmanaged: [] };
  if (!fs.existsSync(tempRoot)) return result;

  for (const entry of fs.readdirSync(tempRoot, { withFileTypes: true })) {
    const entryPath = path.join(tempRoot, entry.name);
    if (!entry.isDirectory()) {
      result.unmanaged.push(entry.name);
      continue;
    }
    const metadata = readMetadata(entryPath);
    if (!metadata) {
      result.unmanaged.push(entry.name);
      continue;
    }
    const expiresAt = Date.parse(metadata.expiresAt || "");
    const expired = Number.isFinite(expiresAt) && expiresAt <= now;
    const active = metadata.status === "active";
    if ((!options.allManaged && !expired) || (options.allManaged && active && !expired)) {
      result.retained.push(entry.name);
      continue;
    }
    result.removed.push(entry.name);
    if (!options.dryRun) removeDirectory(entryPath);
  }
  return result;
}

export function pruneKnownAtomicTempFiles(root, options = {}) {
  const now = options.now ?? Date.now();
  const olderThanHours = options.olderThanHours ?? 24;
  const cutoff = now - olderThanHours * 60 * 60 * 1000;
  const result = { removed: [], retained: [] };
  const locations = [
    { directory: path.resolve(root), pattern: /^\.env\.(\d+)\.tmp$/u },
    { directory: path.resolve(root, "data"), pattern: /^book-pipeline\.csv\.(\d+)\.tmp$/u },
    { directory: path.resolve(root, "assets", "models", "whisper"), pattern: /^ggml-base\.bin\.(\d+)\.tmp$/u },
  ];

  for (const { directory, pattern } of locations) {
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = pattern.exec(entry.name);
      if (!match) continue;
      const filePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, filePath);
      if (isProcessAlive(Number(match[1])) || fs.statSync(filePath).mtimeMs > cutoff) {
        result.retained.push(relativePath);
        continue;
      }
      result.removed.push(relativePath);
      if (!options.dryRun) fs.rmSync(filePath, { force: true });
    }
  }
  return result;
}

export function pruneProjectTempArtifacts(root, options = {}) {
  return {
    workspaces: pruneExpiredTempWorkspaces(root, options),
    atomicFiles: pruneKnownAtomicTempFiles(root, options),
  };
}
