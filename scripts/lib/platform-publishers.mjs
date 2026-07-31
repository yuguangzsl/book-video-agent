const PLATFORM_CONFIG = {
  douyin: {
    host: "creator.douyin.com",
    accountUrl: "https://creator.douyin.com/creator-micro/home",
    prepareUrl: "https://creator.douyin.com/creator-micro/content/upload",
    manageUrl: "https://creator.douyin.com/creator-micro/content/manage",
  },
  xiaohongshu: {
    host: "creator.xiaohongshu.com",
    prepareUrl: "https://creator.xiaohongshu.com/publish/publish?from=homepage&target=video",
    manageUrl: "https://creator.xiaohongshu.com/new/note-manager",
  },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function platformCopyFor(brief, platform) {
  const copy = brief.platformCopy?.[platform] || brief.copy;
  assert(copy && typeof copy === "object", `Missing publication copy for ${platform}`);
  assert(typeof copy.title === "string" && copy.title.trim(), `Missing publication title for ${platform}`);
  assert(typeof copy.description === "string" && copy.description.trim(), `Missing publication description for ${platform}`);
  assert(Array.isArray(copy.hashtags), `Missing publication hashtags for ${platform}`);
  return copy;
}

function normalizedTags(brief, platform) {
  return platformCopyFor(brief, platform).hashtags
    .map((tag) => String(tag).replace(/^#/u, "").trim())
    .filter(Boolean);
}

function normalizedTopicName(value) {
  return String(value || "").replace(/^#+/u, "").trim();
}

export function topicCandidateMatches(text, topic) {
  const expected = normalizedTopicName(topic);
  if (!expected) return false;
  const lines = String(text || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const hashtagLines = lines.filter((line) => line.startsWith("#"));
  if (hashtagLines.length > 1) return false;
  const topicLine = hashtagLines[0] || lines[0] || "";
  const normalizedLine = normalizedTopicName(topicLine);
  return (
    normalizedLine === expected
    || normalizedLine.startsWith(`${expected} `)
    || normalizedLine.startsWith(`${expected}\t`)
  );
}

export function descriptionHasExactTopic(text, topic) {
  const expected = normalizedTopicName(topic);
  if (!expected) return false;
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const normalizedText = String(text || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u2060\ufeff]/gu, " ");
  return new RegExp(`(?:^|\\s)#${escaped}(?=$|[\\s#])`, "u").test(normalizedText);
}

export function descriptionContainsTopicName(text, topic) {
  const expected = normalizedTopicName(topic);
  if (!expected) return false;
  return String(text || "")
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .includes(expected);
}

async function bodyText(page) {
  return page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
}

function assertOfficialUrl(platform, url) {
  const config = PLATFORM_CONFIG[platform];
  const parsed = new URL(url);
  assert(parsed.protocol === "https:" && parsed.hostname === config.host, `Refusing non-official ${platform} page: ${url}`);
}

async function isVisible(locator) {
  if (!await locator.count()) return false;
  return locator.first().isVisible().catch(() => false);
}

async function firstVisible(page, selectors, timeout = 0) {
  const deadline = Date.now() + timeout;
  do {
    for (const selector of selectors) {
      const candidates = page.locator(selector);
      const count = Math.min(await candidates.count(), 20);
      for (let index = 0; index < count; index += 1) {
        const locator = candidates.nth(index);
        if (await isVisible(locator)) return locator;
      }
    }
    if (!timeout) return null;
    await delay(500);
  } while (Date.now() < deadline);
  return null;
}

async function firstAttached(page, selectors, timeout = 0) {
  const deadline = Date.now() + timeout;
  do {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.count()) return locator;
    }
    if (!timeout) return null;
    await delay(500);
  } while (Date.now() < deadline);
  return null;
}

async function requireAccount(page, account, platform, timeout = 30000) {
  const expected = [account?.name, account?.id].map((value) => String(value || "").trim()).filter(Boolean);
  assert(expected.length > 0, `${platform} account name or id is required`);
  const deadline = Date.now() + timeout;
  do {
    const text = await bodyText(page);
    const signal = expected.find((value) => text.includes(value));
    if (signal) return signal;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(`${platform} page does not show the expected account (${expected.join(" / ")})`);
}

async function controlState(control) {
  const tagName = await control.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
  if (tagName === "input") {
    const type = await control.getAttribute("type");
    if (type === "checkbox" || type === "radio") return control.isChecked();
  }
  const ariaChecked = await control.getAttribute("aria-checked");
  if (ariaChecked === "true") return true;
  if (ariaChecked === "false") return false;
  const dataChecked = await control.getAttribute("data-checked");
  if (dataChecked === "true") return true;
  if (dataChecked === "false") return false;
  const className = String(await control.getAttribute("class") || "");
  if (/(checked|active|selected|--on)\b/iu.test(className) && !/(unchecked|inactive|unselected)\b/iu.test(className)) return true;
  return null;
}

async function findSettingControl(page, labelPattern) {
  const labels = page.getByText(labelPattern);
  const count = Math.min(await labels.count(), 20);
  for (let index = 0; index < count; index += 1) {
    const label = labels.nth(index);
    if (!await label.isVisible().catch(() => false)) continue;
    const candidates = [
      label.locator("xpath=ancestor-or-self::label[1]").locator('input[type="checkbox"], input[type="radio"], [role="switch"]').first(),
      label.locator("xpath=ancestor::*[self::div or self::label][1]").locator('input[type="checkbox"], input[type="radio"], [role="switch"], .semi-switch, .d-switch').first(),
      label.locator("xpath=ancestor::*[self::div or self::label][2]").locator('input[type="checkbox"], input[type="radio"], [role="switch"], .semi-switch, .d-switch').first(),
    ];
    for (const candidate of candidates) {
      if (await candidate.count()) return { label, control: candidate };
    }
  }
  return null;
}

async function setBooleanSetting(page, labelPattern, desired, options = {}) {
  const match = await findSettingControl(page, labelPattern);
  if (!match) {
    if (options.required) throw new Error(`Required setting not found: ${labelPattern}`);
    return { available: false };
  }
  const before = await controlState(match.control);
  if (before === null) {
    if (options.required) throw new Error(`Could not read required setting state: ${labelPattern}`);
    return { available: true, state: "unknown" };
  }
  if (before !== desired) {
    await match.control.click({ force: true });
    await delay(300);
  }
  const after = await controlState(match.control);
  assert(after === desired, `Failed to set ${labelPattern} to ${desired}`);
  return { available: true, state: after };
}

async function findChoiceGroup(page, groupLabel, optionLabels, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do {
    const labels = page.getByText(groupLabel, { exact: true });
    const count = Math.min(await labels.count(), 20);
    for (let index = 0; index < count; index += 1) {
      const label = labels.nth(index);
      if (!await label.isVisible().catch(() => false)) continue;
      for (let depth = 1; depth <= 6; depth += 1) {
        const group = label.locator(`xpath=ancestor::*[self::div or self::section][${depth}]`);
        if (!await group.count()) continue;
        let containsEveryOption = true;
        for (const optionLabel of optionLabels) {
          if (!await group.getByText(optionLabel, { exact: true }).count()) {
            containsEveryOption = false;
            break;
          }
        }
        if (containsEveryOption) return group;
      }
    }
    await delay(250);
  } while (Date.now() < deadline);
  return null;
}

async function choiceControl(option) {
  const candidates = [
    option.locator("xpath=ancestor-or-self::*[@role='radio'][1]"),
    option.locator("xpath=ancestor-or-self::label[1]"),
    option.locator("xpath=ancestor-or-self::*[contains(@class,'radio')][1]"),
    option.locator("xpath=ancestor-or-self::*[contains(@class,'choice')][1]"),
  ];
  for (const candidate of candidates) {
    if (await candidate.count()) return candidate.first();
  }
  return option;
}

async function choiceSelected(option) {
  const control = await choiceControl(option);
  const directState = await controlState(control);
  if (directState !== null) return directState;
  const input = control.locator('input[type="radio"], input[type="checkbox"]').first();
  if (await input.count()) return input.isChecked();
  return null;
}

async function selectDouyinChoice(page, groupLabel, optionLabel, optionLabels, stateValue) {
  const group = await findChoiceGroup(page, groupLabel, optionLabels);
  assert(group, `Douyin setting group was not found: ${groupLabel}`);
  const options = group.getByText(optionLabel, { exact: true });
  const count = Math.min(await options.count(), 20);
  let option = null;
  for (let index = 0; index < count; index += 1) {
    const candidate = options.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      option = candidate;
      break;
    }
  }
  assert(option, `Douyin setting option was not found: ${groupLabel} -> ${optionLabel}`);
  const control = await choiceControl(option);
  if (await choiceSelected(option) !== true) {
    await control.click();
    await delay(300);
  }
  assert(
    await choiceSelected(option) === true,
    `Douyin setting option was not retained: ${groupLabel} -> ${optionLabel}`,
  );
  return {
    available: true,
    state: stateValue,
    selectedLabel: optionLabel,
  };
}

async function fillEditable(locator, value) {
  await locator.click();
  await locator.press("Control+A");
  await locator.press("Delete");
  await locator.fill(value).catch(async () => {
    await locator.pressSequentially(value, { delay: 3 });
  });
}

function descriptionEditorSelectors(platform) {
  if (platform === "douyin") {
    return [
      'div.zone-container[contenteditable="true"]',
      '[contenteditable="true"][data-placeholder*="描述"]',
    ];
  }
  if (platform === "xiaohongshu") {
    return [
      '[contenteditable="true"][data-placeholder*="正文"]',
      '[contenteditable="true"]',
      'p[data-placeholder*="输入正文描述"]',
    ];
  }
  throw new Error(`Unsupported publication platform: ${platform}`);
}

async function currentDescriptionEditor(page, platform, timeout = 30000) {
  const editor = await firstVisible(page, descriptionEditorSelectors(platform), timeout);
  assert(editor, `${platform} description editor was not found`);
  return editor;
}

function topicCandidateSelectors(platform) {
  const shared = [
    '[role="listbox"] [role="option"]',
    '[class*="topic-item"]',
    '[class*="mention-item"]',
    '[class*="topic"] [class*="item"]',
    '[class*="mention"] [class*="item"]',
    '[class*="suggest"] [class*="item"]',
  ];
  if (platform === "douyin") {
    return [
      ".semi-popover-content [role='option']",
      ".semi-popover-content .semi-list-item",
      ...shared,
    ];
  }
  if (platform === "xiaohongshu") {
    return [
      ".d-popover [role='option']",
      ".d-popover [class*='item']",
      ...shared,
    ];
  }
  throw new Error(`Unsupported publication platform: ${platform}`);
}

async function topicCandidateOutsideEditor(candidate) {
  const editableAncestor = candidate.locator('xpath=ancestor-or-self::*[@contenteditable="true"]');
  return (await editableAncestor.count()) === 0;
}

async function topicSuggestionRow(candidate) {
  const row = candidate.locator(
    "xpath=ancestor-or-self::*[@role='option' or self::li or contains(@class,'item') or contains(@class,'option')][1]",
  );
  if (await row.count()) return row.first();
  return candidate;
}

async function findTopicCandidate(page, platform, topic, timeout = 10000) {
  const deadline = Date.now() + timeout;
  const selectors = topicCandidateSelectors(platform);
  do {
    for (const selector of selectors) {
      const candidates = page.locator(selector);
      const count = Math.min(await candidates.count(), 30);
      for (let index = 0; index < count; index += 1) {
        const candidate = await topicSuggestionRow(candidates.nth(index));
        if (!await candidate.isVisible().catch(() => false)) continue;
        if (!await topicCandidateOutsideEditor(candidate)) continue;
        const text = await candidate.innerText().catch(() => "");
        if (topicCandidateMatches(text, topic)) return candidate;
      }
    }

    const exactCandidates = page.getByText(`#${topic}`, { exact: true });
    const exactCount = Math.min(await exactCandidates.count(), 20);
    for (let index = 0; index < exactCount; index += 1) {
      const candidate = exactCandidates.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      if (!await topicCandidateOutsideEditor(candidate)) continue;
      if (topicCandidateMatches(await candidate.innerText().catch(() => ""), topic)) return candidate;
    }
    await delay(250);
  } while (Date.now() < deadline);
  return null;
}

async function findXiaohongshuTopicButton(page, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do {
    const candidates = page.getByText("话题", { exact: true });
    const count = Math.min(await candidates.count(), 20);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      if (!await topicCandidateOutsideEditor(candidate)) continue;
      return candidate;
    }
    await delay(250);
  } while (Date.now() < deadline);
  return null;
}

async function enterTopicQuery(page, editor, platform, topic) {
  await editor.press("End");
  if (platform === "douyin") {
    await editor.pressSequentially(`#${topic}`, { delay: 40 });
    return;
  }

  const topicButton = await findXiaohongshuTopicButton(page);
  assert(topicButton, "Xiaohongshu topic picker button was not found");
  await topicButton.click();
  await delay(250);

  const search = await firstVisible(page, [
    'input[placeholder*="搜索话题"]',
    'input[placeholder*="输入话题"]',
    'input[placeholder*="话题名称"]',
    '[role="dialog"] input',
    '[class*="topic"] input',
  ], 1500);
  if (search) {
    await search.fill(topic);
    return;
  }

  const focused = page.locator(":focus");
  if (await focused.count() === 1 && await focused.isVisible().catch(() => false)) {
    const acceptsText = await focused.evaluate((element) => (
      element.matches("input, textarea, [contenteditable='true']")
    )).catch(() => false);
    if (acceptsText) {
      await focused.pressSequentially(topic, { delay: 40 });
      return;
    }
  }

  const currentEditor = await currentDescriptionEditor(page, platform);
  await currentEditor.press("End");
  const description = await currentEditor.innerText();
  if (!description.endsWith("#")) await currentEditor.pressSequentially("#", { delay: 40 });
  await currentEditor.pressSequentially(topic, { delay: 40 });
}

async function fillDescriptionAndSelectTopics(page, editor, brief, platform) {
  const copy = platformCopyFor(brief, platform);
  const topics = normalizedTags(brief, platform);
  await fillEditable(editor, `${copy.description}\n\n`);
  const selected = [];
  const evidence = [];
  let currentEditor = editor;

  for (const topic of topics) {
    await enterTopicQuery(page, currentEditor, platform, topic);
    const candidate = await findTopicCandidate(page, platform, topic);
    assert(candidate, `${platform} official topic suggestion was not found for #${topic}`);
    const suggestion = String(await candidate.innerText().catch(() => "")).trim();
    assert(topicCandidateMatches(suggestion, topic), `${platform} topic candidate was not an exact match for #${topic}`);
    await candidate.click();
    await delay(250);

    currentEditor = await currentDescriptionEditor(page, platform);
    const description = await currentEditor.innerText();
    assert(
      descriptionContainsTopicName(description, topic),
      `${platform} topic selection did not remain in the description: #${topic}`,
    );
    selected.push(`#${topic}`);
    evidence.push({ topic: `#${topic}`, suggestion });
    await currentEditor.press("End");
    await currentEditor.press("Space");
  }

  assert(selected.length === topics.length, `${platform} did not associate every requested topic`);
  return {
    requested: topics.map((topic) => `#${topic}`),
    selected,
    source: "official suggestion",
    evidence,
  };
}

async function assertPublishButtonReady(locator, platform, timeout = 30000) {
  assert(locator, `${platform} publish button was not found`);
  const deadline = Date.now() + timeout;
  do {
    const visible = await locator.isVisible().catch(() => false);
    const disabled = await locator.isDisabled().catch(() => false);
    const attrDisabled = await locator.getAttribute("disabled");
    const submitDisabled = await locator.getAttribute("submit-disabled");
    const submitLoading = await locator.getAttribute("submit-loading");
    if (
      visible
      && !disabled
      && attrDisabled === null
      && submitDisabled !== "true"
      && submitLoading !== "true"
    ) return;
    await delay(500);
  } while (Date.now() < deadline);
  assert(await locator.isVisible().catch(() => false), `${platform} publish button is not visible`);
  throw new Error(`${platform} publish button is disabled after waiting ${timeout}ms`);
}

async function waitForXiaohongshuCoverUpload(page, timeout = 10 * 60 * 1000) {
  const deadline = Date.now() + timeout;
  do {
    const text = await bodyText(page);
    assert(!/封面上传失败/u.test(text), "Xiaohongshu reported cover upload failure");
    if (!text.includes("封面上传中")) return;
    await delay(1000);
  } while (Date.now() < deadline);
  throw new Error("Xiaohongshu cover upload timed out");
}

async function currentXiaohongshuPublishControl(page, timeout = 30000) {
  return firstVisible(page, [
    'xhs-publish-btn[submit-text="发布"][submit-disabled="false"]',
    'xhs-publish-btn[submit-text="发布"]',
  ], timeout);
}

export function xiaohongshuPublishClickPosition(width, height) {
  assert(Number.isFinite(width) && width > 0, "Xiaohongshu publish control width must be positive");
  assert(Number.isFinite(height) && height > 0, "Xiaohongshu publish control height must be positive");
  return {
    x: width * 0.61,
    y: height / 2,
  };
}

export function xiaohongshuListTimestamp(text) {
  const match = String(text || "").match(
    /\b(20\d{2})-(\d{2})-(\d{2})\s+([01]\d|2[0-3]):([0-5]\d)\b/u,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const timestamp = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  ).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function douyinListTimestamp(text) {
  const match = String(text || "").match(
    /\b(20\d{2})年(\d{2})月(\d{2})日\s+([01]\d|2[0-3]):([0-5]\d)\b/u,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const timestamp = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  ).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function clickXiaohongshuPublish(control) {
  const box = await control.boundingBox();
  assert(box, "Xiaohongshu publish control has no clickable bounds");
  await control.click({
    position: xiaohongshuPublishClickPosition(box.width, box.height),
  });
}

async function selectDouyinAiDeclaration(page) {
  const currentText = await bodyText(page);
  if (/自主声明[^\n]*(AI|人工智能)/iu.test(currentText)) {
    return { selected: true, text: currentText.match(/自主声明[^\n]*/iu)?.[0] || "AI" };
  }
  const entry = page.getByText("请选择自主声明", { exact: true }).first();
  await entry.waitFor({ state: "visible", timeout: 10000 });
  await entry.click();
  const dialog = page.locator(".semi-modal-content").filter({ hasText: "对作品内容添加声明" }).first();
  await dialog.waitFor({ state: "visible", timeout: 10000 });
  const options = dialog.locator(".semi-radio");
  const count = await options.count();
  let selectedText = "";
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const text = String(await option.innerText().catch(() => "")).trim();
    if (/(AI|人工智能).*(生成|创作)|(?:生成|创作).*(AI|人工智能)/iu.test(text)) {
      await option.click();
      selectedText = text;
      break;
    }
  }
  assert(selectedText, "Douyin AI-generated-content declaration option was not found");
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 10000 });
  return { selected: true, text: selectedText };
}

async function selectXiaohongshuAiDeclaration(page) {
  const direct = await setBooleanSetting(page, /AI.*(?:生成|创作)|(?:生成|创作).*AI|人工智能.*(?:生成|创作)/iu, true);
  if (direct.available && direct.state === true) return { selected: true, method: "toggle" };

  const declarationEntry = page.getByText(/添加内容类型声明|内容声明|创作声明|笔记声明/u, { exact: true }).first();
  if (await declarationEntry.count() && await declarationEntry.isVisible().catch(() => false)) {
    await declarationEntry.click();
    await delay(500);
    const aiOption = page.getByText(
      /笔记含AI合成内容|AI.*(?:合成|生成|创作)|(?:合成|生成|创作).*AI|人工智能.*(?:合成|生成|创作)/iu,
      { exact: true },
    ).first();
    if (await aiOption.count() && await aiOption.isVisible().catch(() => false)) {
      await aiOption.click();
      await delay(300);
      const currentText = await bodyText(page);
      assert(currentText.includes("笔记含AI合成内容"), "Xiaohongshu AI declaration selection was not retained");
      return { selected: true, method: "content-type-declaration", text: "笔记含AI合成内容" };
    }
    const match = await findSettingControl(page, /AI.*(?:生成|创作)|(?:生成|创作).*AI|人工智能.*(?:生成|创作)/iu);
    if (match) {
      const state = await controlState(match.control);
      if (state !== true) await match.control.click({ force: true });
      const confirm = page.getByRole("button", { name: /确定|确认/u }).last();
      if (await confirm.count() && await confirm.isVisible().catch(() => false)) await confirm.click();
      return { selected: true, method: "declaration-dialog" };
    }
  }
  throw new Error("Xiaohongshu AI-generated-content declaration option was not found");
}

export async function platformNeedsLogin(page, platform) {
  const url = page.url();
  if (platform === "xiaohongshu") {
    if (/\/login(?:[/?#]|$)/u.test(url)) return true;
    return isVisible(page.locator("div[class*='login-box']").first());
  }
  if (platform === "douyin") {
    if (!url.includes("/creator-micro/")) return true;
    return (
      isVisible(page.getByText("扫码登录", { exact: true }).first())
      || isVisible(page.getByText("手机号登录", { exact: true }).first())
    );
  }
  throw new Error(`Unsupported publication platform: ${platform}`);
}

export async function openPlatformPreparePage(page, platform) {
  const config = PLATFORM_CONFIG[platform];
  assert(config, `Unsupported publication platform: ${platform}`);
  await page.goto(config.prepareUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await delay(1500);
  return config.prepareUrl;
}

export async function waitForPlatformLogin(page, platform, options = {}) {
  const timeout = options.timeout || 30 * 60 * 1000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!await platformNeedsLogin(page, platform)) {
      await openPlatformPreparePage(page, platform);
      if (!await platformNeedsLogin(page, platform)) return;
    }
    await delay(2000);
  }
  throw new Error(`${platform} login timed out`);
}

export async function prepareXiaohongshu(page, brief, account) {
  const copy = platformCopyFor(brief, "xiaohongshu");
  assertOfficialUrl("xiaohongshu", page.url());
  const accountSignal = await requireAccount(page, account, "xiaohongshu");
  const upload = await firstAttached(page, [
    'input.upload-input[type="file"]',
    'div[class^="upload-content"] input[class="upload-input"]',
    'input[type="file"][accept*="video"]',
  ], 60000);
  assert(upload, "Xiaohongshu video upload input was not found");
  await upload.setInputFiles(brief.videoPath);

  const title = await firstVisible(page, ['input[placeholder*="填写标题"]'], 180000);
  assert(title, "Xiaohongshu title input did not appear after upload");
  await title.fill(copy.title);
  const editor = await currentDescriptionEditor(page, "xiaohongshu");
  const topics = await fillDescriptionAndSelectTopics(page, editor, brief, "xiaohongshu");

  const uploadDeadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < uploadDeadline) {
    const text = await bodyText(page);
    if (/上传成功|重新上传|编辑封面|已上传|100%/u.test(text)) break;
    assert(!/上传失败/u.test(text), "Xiaohongshu reported video upload failure");
    await delay(2000);
  }
  assert(Date.now() < uploadDeadline, "Xiaohongshu video upload timed out");

  const aiDeclaration = await selectXiaohongshuAiDeclaration(page);
  const detectedOriginalDeclaration = await setBooleanSetting(page, /原创声明|原创保护/u, false);
  const originalDeclaration = detectedOriginalDeclaration.state === "unknown"
    ? {
      ...detectedOriginalDeclaration,
      state: false,
      observedState: "unknown",
      source: "user-confirmed-platform-default",
    }
    : detectedOriginalDeclaration;
  const download = await setBooleanSetting(page, /允许下载|允许他人下载/u, false);
  const commercial = await setBooleanSetting(page, /商业推广|商业合作/u, false);
  await waitForXiaohongshuCoverUpload(page);
  const publishButton = await currentXiaohongshuPublishControl(page);
  await assertPublishButtonReady(publishButton, "xiaohongshu");

  const currentTitle = await firstVisible(page, ['input[placeholder*="填写标题"]'], 30000);
  const currentEditor = await currentDescriptionEditor(page, "xiaohongshu");
  assert(currentTitle && currentEditor, "Xiaohongshu form fields were not available for final verification");
  const titleValue = await currentTitle.inputValue();
  const descriptionValue = await currentEditor.innerText();
  assert(titleValue === copy.title, "Xiaohongshu title verification failed");
  assert(descriptionValue.includes(copy.description), "Xiaohongshu description verification failed");
  for (const tag of topics.selected) {
    assert(descriptionContainsTopicName(descriptionValue, tag), `Xiaohongshu is missing selected topic ${tag}`);
  }
  return {
    accountSignal,
    title: titleValue,
    description: descriptionValue,
    fileName: brief.videoPath.split(/[\\/]/u).at(-1),
    topics,
    settings: { aiDeclaration, originalDeclaration, download, commercial },
  };
}

export async function prepareDouyin(page, brief, account) {
  const copy = platformCopyFor(brief, "douyin");
  assertOfficialUrl("douyin", page.url());
  await page.goto(PLATFORM_CONFIG.douyin.accountUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await delay(1500);
  assertOfficialUrl("douyin", page.url());
  const accountSignal = await requireAccount(page, account, "douyin");
  await page.goto(PLATFORM_CONFIG.douyin.prepareUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await delay(1500);
  assertOfficialUrl("douyin", page.url());
  const upload = await firstAttached(page, [
    'div[class^="container"] input[type="file"]',
    'div[class^="container"] input',
    'input[type="file"][accept*="video"]',
  ], 60000);
  assert(upload, "Douyin video upload input was not found");
  await upload.setInputFiles(brief.videoPath);

  const title = await firstVisible(page, ['input[placeholder*="填写作品标题"]'], 180000);
  assert(title, "Douyin title input did not appear after upload");
  await title.fill(copy.title);
  const editor = await currentDescriptionEditor(page, "douyin");
  const topics = await fillDescriptionAndSelectTopics(page, editor, brief, "douyin");

  const uploadDeadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < uploadDeadline) {
    const text = await bodyText(page);
    if (/重新上传|上传成功|100%/u.test(text)) break;
    assert(!/上传失败/u.test(text), "Douyin reported video upload failure");
    await delay(2000);
  }
  assert(Date.now() < uploadDeadline, "Douyin video upload timed out");

  const aiDeclaration = await selectDouyinAiDeclaration(page);
  const originalDeclaration = await setBooleanSetting(page, /原创声明|原创保护/u, false);
  const visibility = await selectDouyinChoice(
    page,
    "谁可以看",
    "公开",
    ["公开", "好友可见", "仅自己可见"],
    "public",
  );
  const download = await selectDouyinChoice(
    page,
    "保存权限",
    "不允许",
    ["允许", "不允许"],
    false,
  );
  const timing = await selectDouyinChoice(
    page,
    "发布时间",
    "立即发布",
    ["立即发布", "定时发布"],
    "immediate",
  );
  const commercial = await setBooleanSetting(page, /商业推广|商业合作/u, false);
  const sync = await setBooleanSetting(page, /同步到头条|同步到西瓜|同步至头条/u, false);
  const publishButton = page.getByRole("button", { name: "发布", exact: true }).first();
  await publishButton.waitFor({ state: "visible", timeout: 30000 });
  await assertPublishButtonReady(publishButton, "douyin");

  const currentTitle = await firstVisible(page, ['input[placeholder*="填写作品标题"]'], 30000);
  const currentEditor = await currentDescriptionEditor(page, "douyin");
  assert(currentTitle && currentEditor, "Douyin form fields were not available for final verification");
  const titleValue = await currentTitle.inputValue();
  const descriptionValue = await currentEditor.innerText();
  assert(titleValue === copy.title, "Douyin title verification failed");
  assert(descriptionValue.includes(copy.description), "Douyin description verification failed");
  for (const tag of topics.selected) {
    assert(descriptionContainsTopicName(descriptionValue, tag), `Douyin is missing selected topic ${tag}`);
  }
  return {
    accountSignal,
    title: titleValue,
    description: descriptionValue,
    fileName: brief.videoPath.split(/[\\/]/u).at(-1),
    topics,
    settings: {
      aiDeclaration,
      originalDeclaration,
      visibility,
      download,
      timing,
      commercial,
      sync,
    },
  };
}

function extractWorkId(url) {
  const parsed = new URL(url);
  const queryId = ["noteId", "itemId", "aweme_id", "id"].map((key) => parsed.searchParams.get(key)).find(Boolean);
  if (queryId) return queryId;
  const pathId = parsed.pathname.match(/\/(?:video|explore|item)\/([a-z0-9_-]+)/iu)?.[1];
  return pathId || "";
}

export async function publishXiaohongshu(page, brief) {
  assertOfficialUrl("xiaohongshu", page.url());
  await waitForXiaohongshuCoverUpload(page);
  const button = await currentXiaohongshuPublishControl(page, 10000);
  await assertPublishButtonReady(button, "xiaohongshu");
  await clickXiaohongshuPublish(button);
  await page.waitForURL("**/publish/success**", { timeout: 120000 });
  const successUrl = page.url();
  assertOfficialUrl("xiaohongshu", successUrl);
  return {
    successUrl,
    acceptedSignal: "official publish success page",
    ...(extractWorkId(successUrl) ? { workId: extractWorkId(successUrl) } : {}),
  };
}

export async function publishDouyin(page, brief) {
  assertOfficialUrl("douyin", page.url());
  const button = page.getByRole("button", { name: "发布", exact: true }).first();
  await button.waitFor({ state: "visible", timeout: 10000 });
  await assertPublishButtonReady(button, "douyin");
  await button.click({ force: true });
  await page.waitForURL("**/creator-micro/content/manage**", { timeout: 120000 });
  return {
    successUrl: page.url(),
    acceptedSignal: "official content management redirect after publish",
    ...(extractWorkId(page.url()) ? { workId: extractWorkId(page.url()) } : {}),
  };
}

export async function verifyDouyinPublishedWork(page, brief, account = null, options = {}) {
  const copy = platformCopyFor(brief, "douyin");
  if (account) {
    await page.goto(PLATFORM_CONFIG.douyin.accountUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await delay(1500);
    assertOfficialUrl("douyin", page.url());
    await requireAccount(page, account, "douyin");
  }
  if (!page.url().includes("/creator-micro/content/manage")) {
    await page.goto(PLATFORM_CONFIG.douyin.manageUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  }
  const url = page.url();
  assertOfficialUrl("douyin", url);
  const search = await firstVisible(page, ['input[placeholder*="搜索作品"]'], 30000);
  if (search) {
    await search.fill(copy.title);
    await search.press("Enter");
  }

  const notBefore = options.notBefore ? Date.parse(options.notBefore) : Number.NaN;
  assert(!options.notBefore || Number.isFinite(notBefore), "Douyin verification notBefore must be an ISO date");
  const recentThreshold = Number.isFinite(notBefore) ? notBefore - 5 * 60 * 1000 : null;
  const listDeadline = Date.now() + 45000;
  let exactTitle = null;
  let itemText = "";
  while (Date.now() < listDeadline) {
    const candidates = page.getByText(copy.title, { exact: false });
    const count = Math.min(await candidates.count(), 20);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      let candidateText = "";
      for (let depth = 1; depth <= 8; depth += 1) {
        const item = candidate.locator(`xpath=ancestor::*[self::div or self::li][${depth}]`);
        if (!await item.count()) continue;
        const text = String(await item.innerText().catch(() => "")).trim();
        if (!text.includes(copy.title) || text.length > 3000) continue;
        candidateText = text;
        if (douyinListTimestamp(text) !== null) break;
      }
      const timestamp = douyinListTimestamp(candidateText);
      if (recentThreshold !== null && (timestamp === null || timestamp < recentThreshold)) continue;
      exactTitle = candidate;
      itemText = candidateText;
      break;
    }
    if (exactTitle) break;
    await delay(1000);
  }
  assert(
    exactTitle,
    recentThreshold === null
      ? `Douyin content management search did not find the exact published title: ${copy.title}`
      : `Douyin content management search did not find a recent exact-title item: ${copy.title}`,
  );
  const listedTimestamp = douyinListTimestamp(itemText);
  return {
    url: page.url(),
    signal: search
      ? "official content management search contains exact title"
      : "official content management list contains exact title",
    statusSignal: itemText.match(/已发布|审核中|审核|发布成功/u)?.[0] || "listed",
    ...(listedTimestamp !== null ? { listedAt: new Date(listedTimestamp).toISOString() } : {}),
    ...(extractWorkId(page.url()) ? { workId: extractWorkId(page.url()) } : {}),
  };
}

export async function verifyXiaohongshuPublishedWork(page, brief, account = null, options = {}) {
  const copy = platformCopyFor(brief, "xiaohongshu");
  if (!page.url().includes("/new/note-manager")) {
    await page.goto(PLATFORM_CONFIG.xiaohongshu.manageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await delay(1500);
  }
  assertOfficialUrl("xiaohongshu", page.url());
  if (account) await requireAccount(page, account, "xiaohongshu");

  const allTabs = page.getByText(/^全部(?:\s*\d+)?$/u);
  const allTabCount = Math.min(await allTabs.count(), 20);
  for (let index = 0; index < allTabCount; index += 1) {
    const candidate = allTabs.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    await candidate.click();
    await delay(500);
    break;
  }

  const search = await firstVisible(page, [
    'input[placeholder*="搜索笔记"]',
    'input[placeholder*="搜索"]',
  ], 5000);
  if (search) {
    await search.fill(copy.title);
    await search.press("Enter");
    await delay(1000);
  }

  const notBefore = options.notBefore ? Date.parse(options.notBefore) : Number.NaN;
  assert(!options.notBefore || Number.isFinite(notBefore), "Xiaohongshu verification notBefore must be an ISO date");
  const recentThreshold = Number.isFinite(notBefore) ? notBefore - 5 * 60 * 1000 : null;
  const listDeadline = Date.now() + 60000;
  let exactTitle = null;
  let itemText = "";
  while (Date.now() < listDeadline) {
    const candidates = page.getByText(copy.title, { exact: true });
    const count = Math.min(await candidates.count(), 20);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      let candidateText = "";
      for (let depth = 1; depth <= 8; depth += 1) {
        const item = candidate.locator(`xpath=ancestor::*[self::div or self::li][${depth}]`);
        if (!await item.count()) continue;
        const text = String(await item.innerText().catch(() => "")).trim();
        if (!text.includes(copy.title) || text.length > 2000) continue;
        candidateText = text;
        if (xiaohongshuListTimestamp(text) !== null) break;
      }
      const timestamp = xiaohongshuListTimestamp(candidateText);
      if (recentThreshold !== null && (timestamp === null || timestamp < recentThreshold)) continue;
      exactTitle = candidate;
      itemText = candidateText;
      break;
    }
    if (exactTitle) break;
    await delay(1000);
  }
  assert(
    exactTitle,
    recentThreshold === null
      ? `Xiaohongshu note manager did not show exact title: ${copy.title}`
      : `Xiaohongshu note manager did not show a recent exact-title item: ${copy.title}`,
  );
  const listedTimestamp = xiaohongshuListTimestamp(itemText);
  return {
    url: page.url(),
    signal: "official note manager contains exact title",
    statusSignal: itemText.match(/已发布|审核中|审核|发布成功/u)?.[0] || "listed",
    ...(listedTimestamp !== null ? { listedAt: new Date(listedTimestamp).toISOString() } : {}),
  };
}

export function platformPrepareFunction(platform) {
  if (platform === "douyin") return prepareDouyin;
  if (platform === "xiaohongshu") return prepareXiaohongshu;
  throw new Error(`Unsupported publication platform: ${platform}`);
}

export function platformPublishFunction(platform) {
  if (platform === "douyin") return publishDouyin;
  if (platform === "xiaohongshu") return publishXiaohongshu;
  throw new Error(`Unsupported publication platform: ${platform}`);
}
