import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertPortableProjectPath,
  resolveProjectPath,
  toPortableProjectPath,
} from "./artifact-paths.mjs";

export function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function describeManifestFile(root, filePath, options = {}) {
  const resolvedFile = path.resolve(filePath);
  const referencePath = path.resolve(options.referencePath || resolvedFile);
  let reference;
  let inProject = true;
  try {
    reference = toPortableProjectPath(root, referencePath);
  } catch {
    inProject = false;
    reference = path.basename(referencePath);
  }

  return {
    file: reference,
    location: inProject ? "project" : "external",
    bytes: fs.statSync(resolvedFile).size,
    sha256: sha256File(resolvedFile),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateDescriptor(root, descriptor, field, options = {}) {
  assert(descriptor && typeof descriptor === "object" && !Array.isArray(descriptor), `${field} must be an object`);
  assert(Number.isInteger(descriptor.bytes) && descriptor.bytes >= 0, `${field}.bytes must be a non-negative integer`);
  assert(typeof descriptor.sha256 === "string" && /^[a-f0-9]{64}$/iu.test(descriptor.sha256), `${field}.sha256 must be a sha256 hex string`);

  if (descriptor.location === "external") {
    assert(typeof descriptor.file === "string" && descriptor.file.length > 0, `${field}.file must be a non-empty filename`);
    assert(path.basename(descriptor.file) === descriptor.file, `${field}.file must not expose an external path`);
    return { warning: `${field} is external and cannot be re-hashed from the manifest alone` };
  }

  assert(descriptor.location === "project", `${field}.location must be project or external`);
  assertPortableProjectPath(descriptor.file, `${field}.file`);
  const actualPath = options.actualPath || resolveProjectPath(root, descriptor.file, `${field}.file`);
  assert(fs.existsSync(actualPath), `${field}.file does not exist: ${descriptor.file}`);
  const stat = fs.statSync(actualPath);
  assert(stat.isFile(), `${field}.file is not a file: ${descriptor.file}`);
  assert(stat.size === descriptor.bytes, `${field}.bytes does not match ${descriptor.file}`);
  assert(sha256File(actualPath) === descriptor.sha256.toLowerCase(), `${field}.sha256 does not match ${descriptor.file}`);
  return {};
}

export function validateRenderManifest(root, manifest, options = {}) {
  const warnings = [];
  assert(manifest && typeof manifest === "object" && !Array.isArray(manifest), "render manifest root must be an object");
  assert(manifest.schemaVersion === 1, "render manifest schemaVersion must be 1");
  assert(manifest.kind === "book-video-render", "render manifest kind must be book-video-render");
  assert(typeof manifest.createdAt === "string" && Number.isFinite(Date.parse(manifest.createdAt)), "render manifest createdAt must be an ISO date");
  assert(manifest.episode && typeof manifest.episode === "object", "render manifest episode must be an object");
  assert(typeof manifest.episode.name === "string" && manifest.episode.name.trim(), "render manifest episode.name is required");
  assert(typeof manifest.episode.slug === "string" && manifest.episode.slug.trim(), "render manifest episode.slug is required");
  assert(typeof manifest.episode.scriptVersion === "string" && manifest.episode.scriptVersion.trim(), "render manifest episode.scriptVersion is required");

  const descriptors = [
    [manifest.output, "output"],
    [manifest.audioMix?.bgm, "audioMix.bgm"],
    [manifest.audioMix?.introVoice, "audioMix.introVoice"],
    [manifest.audioMix?.bodyVoice, "audioMix.bodyVoice"],
    [manifest.audioMix?.scrollSfx, "audioMix.scrollSfx"],
    [manifest.inputs?.brief, "inputs.brief"],
    [manifest.inputs?.script, "inputs.script"],
    [manifest.inputs?.timings, "inputs.timings"],
    ...((manifest.inputs?.images || []).map((item, index) => [item, `inputs.images[${index}]`])),
  ];
  assert(Array.isArray(manifest.inputs?.images) && manifest.inputs.images.length === 4, "render manifest must describe exactly four images");
  for (const [descriptor, field] of [
    [manifest.output, "output"],
    [manifest.audioMix?.introVoice, "audioMix.introVoice"],
    [manifest.audioMix?.bodyVoice, "audioMix.bodyVoice"],
    [manifest.audioMix?.scrollSfx, "audioMix.scrollSfx"],
    [manifest.inputs?.brief, "inputs.brief"],
    [manifest.inputs?.script, "inputs.script"],
    [manifest.inputs?.timings, "inputs.timings"],
    ...manifest.inputs.images.map((item, index) => [item, `inputs.images[${index}]`]),
  ]) {
    assert(descriptor?.location === "project", `${field}.location must be project`);
  }

  for (const [descriptor, field] of descriptors) {
    const actualPath = options.fileOverrides?.[descriptor?.file];
    const result = validateDescriptor(root, descriptor, field, { actualPath });
    if (result.warning) warnings.push(result.warning);
  }

  assertPortableProjectPath(manifest.inputs.introTemplate, "inputs.introTemplate");
  const introTemplatePath = resolveProjectPath(root, manifest.inputs.introTemplate, "inputs.introTemplate");
  assert(fs.existsSync(introTemplatePath) && fs.statSync(introTemplatePath).isDirectory(), "inputs.introTemplate must reference an existing directory");
  assert(manifest.output.video?.width === 720 && manifest.output.video?.height === 960, "render manifest output must be 720x960");
  assert(manifest.output.audio && Number(manifest.output.audio.channels) > 0, "render manifest output must have audio");
  assert(Number.isFinite(manifest.output.durationSeconds) && manifest.output.durationSeconds > 0, "render manifest duration must be positive");
  if (manifest.render?.maximumDurationSeconds !== null) {
    assert(
      Number.isFinite(manifest.render?.maximumDurationSeconds)
      && manifest.output.durationSeconds <= manifest.render.maximumDurationSeconds + 0.05,
      "render manifest duration exceeds the configured maximum",
    );
  }

  const imageHashes = manifest.inputs.images.map((item) => item.sha256.toLowerCase());
  assert(new Set(imageHashes).size === imageHashes.length, "render manifest contains duplicate image content");
  return { warnings };
}

export function readAndValidateRenderManifest(root, manifestPath, options = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/u, ""));
  const result = validateRenderManifest(root, manifest, options);
  if (!options.skipManifestPathCheck) {
    assert(/\.mp4$/iu.test(manifest.output.file), "output.file must end with .mp4");
    const expectedManifestPath = resolveProjectPath(
      root,
      manifest.output.file.replace(/\.mp4$/iu, ".manifest.json"),
      "output manifest path",
    );
    assert(path.resolve(manifestPath) === expectedManifestPath, `manifest filename does not match output.file: ${manifestPath}`);
  }
  return { manifest, ...result };
}
