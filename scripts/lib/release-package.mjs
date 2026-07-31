import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  assertPortableProjectPath,
  resolveProjectPath,
  toPortableProjectPath,
} from "./artifact-paths.mjs";
import { readJsonFile } from "./json.mjs";
import { sha256File } from "./render-manifest.mjs";

export const RELEASE_PLATFORMS = ["douyin", "xiaohongshu"];

const PLATFORM_TITLE_LIMITS = {
  douyin: 30,
  xiaohongshu: 20,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncateText(value, maximumCharacters) {
  return [...String(value)].slice(0, maximumCharacters).join("");
}

function platformCopyFromPublish(publish, platform) {
  const common = publish.copy;
  const explicit = common.platforms?.[platform] || {};
  const maximumTitleCharacters = PLATFORM_TITLE_LIMITS[platform];
  const explicitTitle = String(explicit.title || "").trim();
  const title = explicitTitle || truncateText(common.selectedTitle, maximumTitleCharacters);
  return {
    title,
    titleSource: explicitTitle ? "publish.json" : (
      title === common.selectedTitle ? "common" : "common-truncated"
    ),
    maximumTitleCharacters,
    description: String(explicit.description || common.description).trim(),
    hashtags: [...(explicit.hashtags || common.hashtags)],
  };
}

function releaseRoot(root, episodeName) {
  return path.join(root, "episodes", episodeName, "releases");
}

function releaseDirectory(root, episodeName, releaseId) {
  return path.join(releaseRoot(root, episodeName), releaseId);
}

function releaseManifestPath(root, episodeName, releaseId) {
  return path.join(releaseDirectory(root, episodeName, releaseId), "release.json");
}

function releaseReadyPath(root, episodeName, releaseId) {
  return path.join(releaseDirectory(root, episodeName, releaseId), "READY");
}

function copyOrLinkFile(source, destination) {
  try {
    fs.linkSync(source, destination);
    return "hardlink";
  } catch {
    fs.copyFileSync(source, destination);
    return "copy";
  }
}

function releaseIdFor({ episodeName, scriptVersion, renderSha256, publication, policy }) {
  return createHash("sha256").update(JSON.stringify({
    episodeName,
    scriptVersion,
    renderSha256,
    publication,
    policy,
  }), "utf8").digest("hex");
}

function validatePlatformCopy(copy, platform, filePath) {
  const field = `${filePath}: publication.platforms.${platform}`;
  assert(isObject(copy), `${field} must be an object`);
  assert(typeof copy.title === "string" && copy.title.trim(), `${field}.title must be non-empty`);
  assert(
    [...copy.title].length <= PLATFORM_TITLE_LIMITS[platform],
    `${field}.title exceeds ${PLATFORM_TITLE_LIMITS[platform]} characters`,
  );
  assert(
    ["publish.json", "common", "common-truncated"].includes(copy.titleSource),
    `${field}.titleSource is invalid`,
  );
  assert(
    copy.maximumTitleCharacters === PLATFORM_TITLE_LIMITS[platform],
    `${field}.maximumTitleCharacters is invalid`,
  );
  assert(typeof copy.description === "string" && copy.description.trim(), `${field}.description must be non-empty`);
  assert(
    Array.isArray(copy.hashtags)
    && copy.hashtags.length >= 3
    && copy.hashtags.length <= 5
    && copy.hashtags.every((tag) => typeof tag === "string" && tag.trim()),
    `${field}.hashtags must contain 3-5 non-empty strings`,
  );
}

export function validateReleasePackageObject(root, release, filePath = "release.json", options = {}) {
  assert(isObject(release), `${filePath}: root must be an object`);
  assert(release.schemaVersion === 1, `${filePath}: schemaVersion must be 1`);
  assert(release.kind === "book-video-release", `${filePath}: kind must be book-video-release`);
  assert(/^[a-f0-9]{64}$/u.test(String(release.releaseId)), `${filePath}: releaseId must be a sha256 hex string`);
  assert(
    typeof release.createdAt === "string" && Number.isFinite(Date.parse(release.createdAt)),
    `${filePath}: createdAt must be an ISO date`,
  );
  assert(isObject(release.episode), `${filePath}: episode must be an object`);
  assert(typeof release.episode.name === "string" && release.episode.name.trim(), `${filePath}: episode.name is required`);
  assert(
    typeof release.episode.scriptVersion === "string" && release.episode.scriptVersion.trim(),
    `${filePath}: episode.scriptVersion is required`,
  );

  assert(isObject(release.video), `${filePath}: video must be an object`);
  assertPortableProjectPath(release.video.file, `${filePath}: video.file`);
  assert(/^[a-f0-9]{64}$/u.test(String(release.video.sha256)), `${filePath}: video.sha256 must be a sha256 hex string`);
  assert(Number.isInteger(release.video.bytes) && release.video.bytes > 0, `${filePath}: video.bytes must be positive`);
  assert(Number.isFinite(release.video.durationSeconds) && release.video.durationSeconds > 0, `${filePath}: video.durationSeconds must be positive`);
  assert(Number.isInteger(release.video.width) && release.video.width > 0, `${filePath}: video.width must be positive`);
  assert(Number.isInteger(release.video.height) && release.video.height > 0, `${filePath}: video.height must be positive`);
  assert(typeof release.video.videoCodec === "string" && release.video.videoCodec, `${filePath}: video.videoCodec is required`);
  assert(typeof release.video.audioCodec === "string" && release.video.audioCodec, `${filePath}: video.audioCodec is required`);

  assert(isObject(release.publication), `${filePath}: publication must be an object`);
  assert(isObject(release.publication.common), `${filePath}: publication.common must be an object`);
  assert(
    typeof release.publication.common.title === "string" && release.publication.common.title.trim(),
    `${filePath}: publication.common.title is required`,
  );
  assert(
    typeof release.publication.common.description === "string" && release.publication.common.description.trim(),
    `${filePath}: publication.common.description is required`,
  );
  assert(
    Array.isArray(release.publication.common.hashtags)
    && release.publication.common.hashtags.length >= 3
    && release.publication.common.hashtags.length <= 5
    && release.publication.common.hashtags.every((tag) => typeof tag === "string" && tag.trim()),
    `${filePath}: publication.common.hashtags must contain 3-5 non-empty strings`,
  );
  assert(isObject(release.publication.platforms), `${filePath}: publication.platforms must be an object`);
  for (const platform of RELEASE_PLATFORMS) {
    validatePlatformCopy(release.publication.platforms[platform], platform, filePath);
  }

  assert(isObject(release.policy), `${filePath}: policy must be an object`);
  for (const field of ["aiGenerated", "allowDownload", "commercialPromotion", "originalDeclaration", "monetization"]) {
    assert(typeof release.policy[field] === "boolean", `${filePath}: policy.${field} must be boolean`);
  }
  assert(release.policy.visibility === "public", `${filePath}: policy.visibility must be public`);
  assert(release.policy.timing === "immediate", `${filePath}: policy.timing must be immediate`);
  assert(release.policy.cover === "first-frame", `${filePath}: policy.cover must be first-frame`);
  assert(
    release.releaseId === releaseIdFor({
      episodeName: release.episode.name,
      scriptVersion: release.episode.scriptVersion,
      renderSha256: release.video.sha256,
      publication: release.publication,
      policy: release.policy,
    }),
    `${filePath}: releaseId does not match release content`,
  );

  const declaredVideoPath = resolveProjectPath(root, release.video.file, `${filePath}: video.file`);
  assert(
    path.dirname(declaredVideoPath) === path.dirname(path.resolve(filePath)),
    `${filePath}: video.file must be stored beside release.json`,
  );
  const resolvedVideoPath = options.videoPathOverride || declaredVideoPath;
  assert(fs.existsSync(resolvedVideoPath) && fs.statSync(resolvedVideoPath).isFile(), `${filePath}: release video is missing`);
  assert(fs.statSync(resolvedVideoPath).size === release.video.bytes, `${filePath}: release video size changed`);
  assert(sha256File(resolvedVideoPath) === release.video.sha256, `${filePath}: release video sha256 changed`);
  return { release, videoPath: resolvedVideoPath };
}

export function readReleasePackage(root, portableManifestPath) {
  const manifestPath = resolveProjectPath(root, portableManifestPath, "releaseManifestPath");
  assert(fs.existsSync(manifestPath), `Missing release manifest: ${manifestPath}`);
  const release = readJsonFile(manifestPath);
  const result = validateReleasePackageObject(root, release, manifestPath);
  const readyPath = path.join(path.dirname(manifestPath), "READY");
  assert(fs.existsSync(readyPath), `Missing release READY marker: ${readyPath}`);
  const ready = readJsonFile(readyPath);
  assert(ready?.schemaVersion === 1, `${readyPath}: schemaVersion must be 1`);
  assert(ready.releaseId === release.releaseId, `${readyPath}: releaseId mismatch`);
  assert(ready.renderSha256 === release.video.sha256, `${readyPath}: renderSha256 mismatch`);
  return {
    ...result,
    manifestPath,
    manifestPortablePath: toPortableProjectPath(root, manifestPath),
    readyPath,
  };
}

export function assertReleaseMatchesCompletedEpisode(root, releaseResult, completed) {
  const { release, videoPath } = releaseResult;
  assert(release.episode.name === completed.episodeName, "Release episode does not match completed episode");
  assert(
    release.episode.scriptVersion === completed.manifest.episode.scriptVersion,
    "Release scriptVersion does not match completed episode",
  );
  assert(release.video.sha256 === completed.manifest.output.sha256.toLowerCase(), "Release video hash does not match completed episode");
  assert(fs.statSync(videoPath).size === completed.manifest.output.bytes, "Release video size does not match completed episode");
  assert(release.publication.common.title === completed.publish.copy.selectedTitle, "Release title does not match publish.json");
  assert(release.publication.common.description === completed.publish.copy.description, "Release description does not match publish.json");
  return releaseResult;
}

export function createReleasePackage(root, completed, options = {}) {
  assert(completed?.publish, `Missing publish.json: ${completed?.publishPath || "unknown"}`);
  const renderSha256 = String(completed.manifest.output.sha256).toLowerCase();
  assert(/^[a-f0-9]{64}$/u.test(renderSha256), "Completed render sha256 is invalid");
  assert(sha256File(completed.outputPath) === renderSha256, "Completed render changed before release creation");
  const publish = completed.publish;
  const publication = {
    common: {
      title: publish.copy.selectedTitle,
      description: publish.copy.description,
      hashtags: [...publish.copy.hashtags],
    },
    platforms: Object.fromEntries(
      RELEASE_PLATFORMS.map((platform) => [platform, platformCopyFromPublish(publish, platform)]),
    ),
  };
  const policy = {
    cover: "first-frame",
    visibility: "public",
    timing: "immediate",
    allowDownload: false,
    aiGenerated: true,
    commercialPromotion: false,
    originalDeclaration: false,
    monetization: false,
  };
  const releaseId = releaseIdFor({
    episodeName: completed.episodeName,
    scriptVersion: completed.manifest.episode.scriptVersion,
    renderSha256,
    publication,
    policy,
  });

  const manifestPath = releaseManifestPath(root, completed.episodeName, releaseId);
  const portableManifestPath = toPortableProjectPath(root, manifestPath);
  const readyPath = releaseReadyPath(root, completed.episodeName, releaseId);
  if (fs.existsSync(manifestPath) || fs.existsSync(readyPath)) {
    return assertReleaseMatchesCompletedEpisode(root, readReleasePackage(root, portableManifestPath), completed);
  }

  const parent = releaseRoot(root, completed.episodeName);
  const targetDirectory = releaseDirectory(root, completed.episodeName, releaseId);
  assert(!fs.existsSync(targetDirectory), `Incomplete release directory requires review: ${targetDirectory}`);
  fs.mkdirSync(parent, { recursive: true });
  const temporaryDirectory = path.join(parent, `.${releaseId}.${process.pid}.${randomUUID()}.tmp`);
  fs.mkdirSync(temporaryDirectory);
  try {
    const temporaryVideoPath = path.join(temporaryDirectory, "video.mp4");
    const storage = copyOrLinkFile(completed.outputPath, temporaryVideoPath);
    assert(sha256File(temporaryVideoPath) === renderSha256, "Release video copy hash mismatch");
    const finalVideoPath = path.join(targetDirectory, "video.mp4");
    const release = {
      schemaVersion: 1,
      kind: "book-video-release",
      releaseId,
      createdAt: options.now instanceof Date
        ? options.now.toISOString()
        : String(options.now || new Date().toISOString()),
      episode: {
        name: completed.episodeName,
        scriptVersion: completed.manifest.episode.scriptVersion,
      },
      video: {
        file: toPortableProjectPath(root, finalVideoPath),
        sha256: renderSha256,
        bytes: completed.manifest.output.bytes,
        durationSeconds: completed.manifest.output.durationSeconds,
        width: completed.manifest.output.video.width,
        height: completed.manifest.output.video.height,
        videoCodec: completed.manifest.output.video.codec,
        audioCodec: completed.manifest.output.audio.codec,
        storage,
      },
      provenance: {
        renderManifest: {
          file: toPortableProjectPath(root, completed.manifestPath),
          sha256: sha256File(completed.manifestPath),
        },
        publishJson: {
          file: toPortableProjectPath(root, completed.publishPath),
          sha256: sha256File(completed.publishPath),
        },
      },
      publication,
      policy,
    };
    validateReleasePackageObject(root, release, manifestPath, {
      videoPathOverride: temporaryVideoPath,
    });
    fs.writeFileSync(
      path.join(temporaryDirectory, "release.json"),
      `${JSON.stringify(release, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(temporaryDirectory, "READY"),
      `${JSON.stringify({
        schemaVersion: 1,
        releaseId,
        renderSha256,
        readyAt: release.createdAt,
      }, null, 2)}\n`,
      "utf8",
    );
    fs.renameSync(temporaryDirectory, targetDirectory);
    return assertReleaseMatchesCompletedEpisode(root, readReleasePackage(root, portableManifestPath), completed);
  } finally {
    if (fs.existsSync(temporaryDirectory)) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
