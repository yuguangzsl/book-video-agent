# Book Video Agent Guide

This repository is an open-source, natural-language workflow for producing short book videos. Keep reusable code, templates, owned assets, and distilled methods in Git. Keep credentials, private book data, downloaded reference videos, generated episode work, and account data local.

## Rule Strength

Requirements expressed as `must`, `never`, `only`, hard limits, or render-blocking errors are mandatory. Targets expressed as `should`, `about`, `roughly`, `default`, or `prefer` guide quality but do not block progress unless a validation script reports an error. Creative preferences never override safety, copyright, subtitle completeness, or technical validation.

## Startup Checklist

Run the startup checklist before the first book-discovery, scripting, video-production, rendering, or publication task when `.book-automation-state.json` is missing. Skip initialization for repository maintenance, code or documentation questions, and rule discussions. When the state file exists, do not rerun initialization unless the user explicitly requests an environment recheck or a relevant dependency or configuration has changed.

1. Resolve the current repository root with `git rev-parse --show-toplevel`; never hard-code a previous clone path. Check Codex capabilities first: the HyperFrames plugin/Skill and built-in bitmap image generation are capabilities, not user-installed project dependencies. Use them directly when available; do not ask the user to install a separate image model or HyperFrames Skill.
2. Check local runtime prerequisites in one read-only pass by running `node scripts/init.mjs --check` from the resolved repository root. This mode must not prompt, migrate files, or write local state. Do not replace it with an ad-hoc `command -v` plus parsed `--version` output: FFmpeg and FFprobe commonly write version banners to stderr, so a blank stdout is not a missing-command signal. Trust the command exit status and the JSON check result. If Node.js 22+, `npx`, FFmpeg/FFprobe, `whisper-cli`, or the Whisper model are missing, report the complete list and ask for one confirmation before installing or downloading them. After confirmation, the Agent may install them with the available platform package manager; never install or change system packages silently. The repository does not auto-install these through a project script.
3. HyperFrames runs through `npx hyperframes@0.7.33`, so the first check or render may need npm registry access even when the HyperFrames Skill is available. If `npx` reports `ENETUNREACH`, `EACCES`, `ENOTFOUND`, `ENOTCACHED`, registry access blocked, or a system network policy failure, classify it as an environment/network issue and immediately retry the same check/render with the execution tool's network-capable escalation. Do not ask the user for a second confirmation or ask them to repeat the workflow. Only report the blocker if the escalation itself is denied or fails. Try the local npm cache with `npx --offline` only as a quick fallback; it cannot replace network access when the package is not cached.
4. Check the model at `<repo-root>/assets/models/whisper/ggml-base.bin` using file existence and size, not `ls` output alone; a valid file is at least 100 MB. If missing, ask to download it as part of the confirmed setup, then run `node scripts/download-whisper-model.mjs`. If the download fails, first look for an enabled computer proxy or proxy environment variable; use it for a retry with `--proxy`, asking the user to enable their proxy when none is active. Do not change system network settings silently. If that fails, give the user the browser URL `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin`, then install the user-provided file with `node scripts/download-whisper-model.mjs --from "<local-path>"`.
5. Ensure the official Tencent WeChat Reading Skill is installed and enabled through the agent's skill installer when absent; do not ask whether to enable it and do not vendor its source into this repository.
6. If the check result reports `wereadApiKey: true` or `weread: enabled`, treat WeChat Reading as configured and never ask for the key again. Only when it is missing, ask whether to configure the integration. After confirmation, open [微信读书 Skills 官网](https://weread.qq.com/r/weread-skills) with the browser/computer tool and explicitly tell the user: “请在页面获取 API Key，然后在本项目的本地交互式终端运行 `node scripts/init.mjs --configure-weread`，并在隐藏输入提示中粘贴 Key。不要把 Key 发到对话里。” Never echo or log the key, request it in chat, or accept it as a command argument. The configuration command stores it in the ignored local `.env`, uses mode `0600` on POSIX, and restricts the file ACL to the current user on Windows. If the user declines key configuration, continue with public research.
7. After dependency, model, and Skill checks are complete, run `node scripts/init.mjs --apply`. This non-interactive mode creates or migrates the private pipeline and writes local state only after required runtime checks pass; it must not ask a second WeChat Reading question.

After an Agent-generated or user-supplied body voiceover is available, run `node scripts/create-body-timings.mjs "<book>" [script-version]`. When the version is omitted, the Agent resolves it from `brief.json` or the unique version in `script.csv`. It writes timing artifacts under the local episode audio folder and creates `body-timings.json`. For Agent-generated `node-edge-tts` audio, build a separate TTS input copy and append an explicit full stop to every title/body unit that lacks one; keep the displayed `《书名》` line and `script.csv` unchanged. Enable `--saveSubtitles`, and pass the resulting JSON with `--edge-subtitles <json>` so exact service word boundaries drive timing. Never concatenate raw CSV rows without a sentence delimiter. Use speech-pause detection only as the fallback for user-supplied audio. The default skips the spoken title/author segment; use `--skip-leading 0` when the audio starts directly with the first script line.

Initialization must be idempotent. It must not reinstall a verified skill, overwrite a valid key, reset user choices, or duplicate CSV columns.

## Temporary Artifact Lifecycle

- Every generated preview or render workspace must be created through `scripts/lib/temp-lifecycle.mjs` under a unique `tmp/` child directory with `.book-video-temp.json` metadata. Never reuse a fixed temporary directory across jobs.
- Active workspaces expire after 24 hours as crash recovery. A successful standalone preview is retained for 24 hours. A failed preview or render is retained for 72 hours for diagnostics. A successful final render removes its workspace immediately after the validated output and manifest are activated.
- Expiration makes an artifact eligible for cleanup; cleanup runs before a new managed workspace is created, during `node scripts/init.mjs --apply`, or through `npm run cleanup:temp`. The read-only `--check` mode must never delete temporary data.
- Ordinary failures must remove adjacent atomic `.tmp` files in `finally` blocks. Known interrupted `.env`, candidate-pipeline, and Whisper-model temporary files older than 24 hours are pruned by the managed cleanup flow.
- Automatic cleanup may delete only project-managed workspaces with valid lifecycle metadata and the explicit known atomic-file patterns. It must never delete unmarked files or directories under `tmp/`. Report unmarked artifacts for manual review instead.
- Use `npm run cleanup:temp -- --dry-run` to inspect cleanup scope. Use `npm run cleanup:temp -- --all-managed` only after the user explicitly requests removal of all inactive managed previews and failed workspaces; non-expired active jobs and unmarked artifacts remain protected.

## Episode Data Cleanup

- When the user explicitly says `清理`, treat that request as authorization for the cleanup policy in this section only. Resolve the current Git repository root, inventory the targets first, and delete only descendants of `<repo-root>/episodes/`; never clean another project, a home directory, shared assets, templates, or files outside this repository.
- An episode is eligible only when its final video was generated more than seven full days before the cleanup time. Prefer the validated final render manifest timestamp, then the final video modification time. If neither provides a trustworthy age or the episode is active, do not delete it and report it for review.
- Before deleting an eligible episode, merge its normalized `display_title` into the local ignored file `data/generated-book-titles.txt`. Keep exactly one unique book title per line and no author, path, timestamp, status, or other metadata. Use this title index together with existing episode directories to check whether a book has already had a video generated.
- After the title is recorded, remove the eligible episode directory and all of its episode-local video, image, audio, script, prompt, publication, manifest, and intermediate data. Preserve episodes newer than seven days. Report the removed titles and paths after cleanup.

## Book Selection

- If the user names a book, use it after verifying title and author.
- Before selecting any book for a new video, normalize its `display_title` and compare it with both `data/generated-book-titles.txt` and the titles of existing validated final renders under `episodes/`. A match is a hard duplicate-production block: do not draft a new script, generate media, render, or overwrite the existing episode for that title. Report that the book has already been generated and select or recommend a different book.
- An explicit user request to fix, revise, or rerender a specific existing episode is the only exception to the duplicate-production block; treat it as maintenance of that episode, not a new video.
- If the user does not name a book and WeChat Reading is configured, use WeChat Reading as the first source for candidate discovery and select relatively popular books using available engagement signals such as reading count, rating count and score, popular highlights, and public reviews. Present this as a relative-popularity selection, never as an official all-platform or WeChat Reading global ranking.
- If `data/book-pipeline.csv` is missing, header-only, or has no usable candidates, ask one question covering preferred genre, emotional theme, or audience.
- With a preference, search according to it. Without a preference, search literary/philosophical books with strong emotional resonance for young adults.
- After every candidate search, write the complete result set to the local ignored `data/book-pipeline.csv` before recommending. Use `node scripts/record-book-candidates.mjs <candidates.json>` so fields are normalized and duplicate results are merged; never only present search results in chat.
- Recommend five candidates from the recorded rows and mark one top recommendation. Wait for book selection before drafting.
- When the WeChat Reading Skill is installed and configured, use it flexibly as the preferred research source for book metadata, popular highlights, and public reviews during book discovery and script preparation. Treat its results as research signals, not copy to reproduce. Public sources and user-provided material remain valid supplements or fallbacks when the Skill has no useful result.

## Book Metadata

Use `display_title` for folder names, visible labels, and scripts. Keep the exact source result in `source_title`; never overwrite it during normalization. Keep `source_book_id` and `source_channel` for provenance. Ambiguous editions, guides, summaries, or author mismatches require review.

## Production Gates

1. After book selection, create a provisional `script.csv` and run `node scripts/validate-script.mjs "<book>"` before showing any draft to the user. If it fails, shorten and revise internally, then validate again; never send an over-limit draft for approval. Only after it passes, send one active script for approval. The response must include the complete copy-ready voiceover in one Markdown fenced code block. The first line must be the display title in the form `《书名》`, followed immediately by every line to be read aloud. Do not put CSV headers, order numbers, author labels, timing data, or explanations inside the block. A `script.csv` attachment or file path is supplementary and must never be the only presentation; the whole block must be directly usable as voiceover input without cleanup.
The copy-ready script should target 18-20 total lines including the title. Hard limits are 22 total lines including the title, at most 21 body rows in `script.csv`, and about 220 Chinese characters in the body. This gate belongs to the drafting stage; audio timing and final rendering checks are secondary safeguards, not the first validation point.
2. Only after script approval, generate prompts and 2-3 AI atmosphere images plus the result bridge.
3. When a body voiceover is generated or supplied, process it with the `story` preset and keep `script.csv` as subtitle truth. Use `node-edge-tts` subtitle boundaries for Agent-generated audio and ASR only as the timing fallback for user-supplied audio.
4. Mix the shared intro, gear SFX, and a user-selected or randomly chosen BGM. Render the final video only after the relevant media is present.
5. Replace old episode media only after the new output passes technical checks. Keep one active script, prompt set, image set, audio set, and render.
6. After a final render passes validation, merge the normalized `display_title` into `data/generated-book-titles.txt`, keeping one unique title per line. Then keep the media local and follow the output format in `Delivery`. A pre-publication preview is not a completed video and must not enter the generated-title index; it follows `Preview Delivery` instead, without requiring `publish.json`. Do not embed media or include technical metadata unless the user explicitly asks for them.
7. After the final video passes validation, research at least five publicly verifiable, high-engagement videos about the same book, theme, or emotional situation. Use them only to identify title structure, emotional hooks, and description sequencing; never copy wording. Save the research basis and original publication copy to the local ignored `episodes/<book>/publish.json`, including three title candidates with one top recommendation, one description, and 3-5 precise tags. When visible engagement data is unavailable, label the references as structural samples rather than popular samples.

For publication-copy tasks, use the fast path in `docs/book-video-playbook.md`. Reuse an existing `publish.json` only when its recorded `scriptVersion`, `scriptSha256`, and `renderSha256` all match the active render and the user did not request a refresh. Otherwise inspect recent `episodes/*/publish.json` attempt history, try the most recently successful verifiable video source with one focused query, and stop repeating a route after two failures. Record every attempt and its outcome. If video metrics remain unavailable, switch to WeChat Reading engagement signals plus the active script, mark the result as a fallback rather than popular-video research, and still deliver useful copy. Change the preferred source order only after at least three recorded attempts show a consistent result.

The intro book list is a fixed six-book template list stored in `templates/shared-video-template/intro/default-book-list.json`. It is independent of `book-pipeline.example.csv`, and the target book may appear in the rolling list before the final reveal. Placeholder labels such as `书名一` or `作者一` are forbidden.

If the user explicitly requests fully automatic production, the script approval gate may be skipped for that episode only.

## Visual And Audio Rules

- Use the shared template in `templates/shared-video-template/` as the only visual baseline.
- Generate video voiceovers with the globally installed `text-to-speech` Skill from `seepine/skills`, using `node-edge-tts`. Default to `zh-CN-YunxiNeural` with rate `-8%` and pitch `-2Hz` unless the user selects a different voice or prosody.
- Keep the glass-shard intro, rolling list, stable title/author, atmosphere-first body, slow push-in, crossfade, and white text with black shadow.
- Meaningful visuals must be AI-generated bitmaps. Do not use SVG as the main visual.
- Do not use card UI, visible watermarks, copied frames, book-cover mockups, or literal image prompts that weaken atmosphere.
- Body subtitles must be generated from `script.csv` plus `body-timings.json`; incomplete caption timing is a render-blocking error. Long Chinese lines must wrap within the 720px frame and remain visible.
- Keep each script row as one complete spoken unit for ASR alignment. The renderer first breaks at commas, periods, question marks, and similar punctuation; each clause stays within roughly 12 Chinese characters. If one clause is longer, it is balanced across multiple visual lines without changing the source text.
- Keep videos under 60 seconds unless the user explicitly changes the limit.
- Music, SFX, and voiceover assets may be committed only when the user has the right to redistribute them. The four default BGM files under `assets/bgm/` are tracked with project-maintainer redistribution authorization recorded in `templates/shared-video-template/ASSET_PROVENANCE.csv`; do not add new media without the same confirmation.

## Script Rules

Read `docs/book-video-playbook.md` before drafting. The first line must immediately create resonance. Use short, natural lines and concrete scenes. Let the book support the viewer's emotion instead of becoming an academic summary. Avoid “你是不是”, “不是……而是……” formulas, mechanical parallelism, arrogant instruction, and CTA language. End with emotional aftertaste.

When WeChat Reading is available, consult its book details, popular highlights, and public reviews before drafting so the script has concrete material and a reliable emotional entry point. Use the Skill to inform the writing, not to copy long excerpts or replace independent judgment.

## Dependencies And Licensing

Project-owned code, documentation, and reusable templates are Apache-2.0. Copyright (c) 2026 prototech, endless, and 未济. HyperFrames and WeChat Reading are external dependencies. GSAP is an external runtime under Webflow's separate Standard No-Charge License. FFmpeg, fonts, image-generation services, models, BGM, and other user media keep their own terms.

## Validation

Validation has three distinct layers:

1. Script validation: run `node scripts/validate-script.mjs "<book>"` before requesting script approval.
2. Episode validation: `node scripts/render-episode-final.mjs "<book>" [script-version]` must complete its built-in caption-count, script-version, 720x960 frame, audio-stream, duration, and manifest checks before replacing active media.
3. Repository validation: run `npm run check` when reusable code, templates, configuration, or tracked assets change, and before a public repository release. This command validates the repository, not a specific rendered MP4. If HyperFrames is not cached, retry through the execution tool's network-capable escalation. Before public release, also scan reachable Git history for secrets and private media, verify no full reference transcript remains, and confirm a clean clone initializes with and without WeChat Reading.

## Preview Delivery

When returning any pre-publication preview, return only this field:

```text
预览文件路径：[打开预览](<absolute-local-preview-path>)
```

The path must be a directly clickable Markdown link. A preview is not a completed video, does not read `publish.json`, and must not use placeholder title or description values.

## Delivery

Whenever the user asks to output, list, or retrieve completed videos, including the latest creations, return only these three fields for each video in this exact order:

```text
视频文件路径：[打开视频](<absolute-local-video-path>)
标题：<selected-title>
简介：<selected-description>
```

Use one blank line between multiple videos. The video path must be a directly clickable Markdown link, never a plain path string. Read the selected title and description from `publish.json`. Do not embed the video or add headings, explanations, timestamps, technical metadata, alternative title candidates, recommendation labels, or tags unless the user explicitly requests them.

Before producing or fixing a video, read `.agents/video-error-log.md` when it exists and enforce every recorded prevention check. When the user reports a new production error, append the symptom, root cause, prevention rule, and required verification before the next render.
