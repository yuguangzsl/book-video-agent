import path from "node:path";

function isWithinRoot(root, filePath) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function assertPortableProjectPath(value, field = "path") {
  if (typeof value !== "string" || !value) throw new Error(`${field} must be a non-empty string`);
  if (value.includes("\\")) throw new Error(`${field} must use forward slashes: ${value}`);
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) {
    throw new Error(`${field} must be project-relative: ${value}`);
  }
  if (value === "." || path.posix.normalize(value) !== value || value.startsWith("../")) {
    throw new Error(`${field} must be a normalized project-relative path: ${value}`);
  }
  return value;
}

export function resolveProjectPath(root, value, field = "path") {
  const portablePath = assertPortableProjectPath(value, field);
  const resolved = path.resolve(root, ...portablePath.split("/"));
  if (!isWithinRoot(root, resolved)) throw new Error(`${field} escapes the project root: ${value}`);
  return resolved;
}

export function toPortableProjectPath(root, filePath, field = "path") {
  const resolved = path.resolve(filePath);
  if (!isWithinRoot(root, resolved)) throw new Error(`${field} is outside the project root: ${resolved}`);
  return path.relative(path.resolve(root), resolved).split(path.sep).join("/");
}

export function formatMarkdownLocalPath(filePath) {
  const portableAbsolutePath = path.resolve(filePath).split(path.sep).join("/");
  return `<${portableAbsolutePath}>`;
}
