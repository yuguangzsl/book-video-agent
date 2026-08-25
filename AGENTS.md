# Book Video Agent Guide

This repository is a natural-language workflow for producing short book videos. Keep reusable code, templates, owned assets, and distilled methods in Git. Keep credentials, private book data, downloaded references, generated episodes, account data, and publication state local.

## Policy

- Treat `must`, `never`, `only`, hard limits, and validation failures as blocking. Treat `should`, `about`, `default`, and `prefer` as quality guidance unless a command reports an error.
- Resolve the repository root at runtime. Never reuse a path from another clone.
- Run initialization only before the first discovery, scripting, production, render, or publication task when `.book-automation-state.json` is missing, or when the user requests a recheck or a relevant dependency changed. Skip it for repository maintenance and rule discussions.
- Use built-in image generation and the available HyperFrames capability directly. Ensure the official Tencent WeChat Reading Skill is enabled; do not vendor it into this repository.
- Never request or accept secrets in chat or command arguments. When WeChat Reading is unconfigured, ask whether to configure it; after confirmation, direct the user to the official site and the hidden-input configuration command below.
- If HyperFrames fails because registry access is blocked, retry with the execution tool's network-capable path. Do not repeatedly ask the user to rerun the same operation.
- Before drafting a new episode, verify title and author, normalize `display_title`, and run the duplicate check. A validated render or generated-title-index match blocks new production. An explicit fix, revision, or rerender of that episode is maintenance and may use the maintenance override.
- Prefer WeChat Reading engagement signals for discovery and research when configured. Describe selections as relatively popular based on available signals, never as an official global ranking. Record all discovered candidates before recommending five and waiting for selection.
- Require script approval before media generation unless the user explicitly requests fully automatic production for that episode.
- Use research as evidence, not copy. Do not reproduce long excerpts, reviews, transcripts, reference frames, titles, descriptions, or tag combinations.
- Keep the shared template's visual identity: glass-shard intro, rolling list, stable title and author, atmosphere-first bitmap imagery, slow push-in, crossfade, and white text with black shadow. Avoid card UI, watermarks, copied frames, cover mockups, and literal prompts that weaken atmosphere.
- The final MP4 first frame is the publication cover. It must show the stable title and author over a visible bitmap scene; a black or nearly black background is blocking even when white title text is readable. Final render, completed-episode, inventory, and stock validation must decode frame 0 and enforce the cover luminance gate.
- Keep scripts conversational, concrete, emotionally resonant, and free of CTA language. Let the book support the viewer's emotion rather than turning the video into a plot summary or lecture.
- Add media to Git only when redistribution rights are confirmed and recorded in `templates/shared-video-template/ASSET_PROVENANCE.csv`.
- Treat an explicit user request containing `清理` as authorization only for the guarded episode-cleanup workflow. Always inspect the dry run first; never delete outside this repository's direct `episodes/` children.

## Command Entry Points

Run commands from the resolved repository root.

| Stage | Command | Required outcome |
| --- | --- | --- |
| Environment check | `node scripts/init.mjs --check` | Read-only dependency, model, state, and WeChat Reading report |
| Environment apply | `node scripts/init.mjs --apply` | Apply only after required runtime checks pass |
| WeChat Reading key | `node scripts/init.mjs --configure-weread` | Run only in the user's interactive terminal; hidden input |
| Candidate recording | `node scripts/record-book-candidates.mjs <candidates.json>` | Normalize and merge the complete search result set |
| Duplicate check | `npm run book:check -- "<display_title>"` | Must report `eligible: true` before new drafting |
| Maintenance check | `npm run book:check -- "<display_title>" --maintenance` | Use only for an explicit fix, revision, or rerender |
| Script validation | `node scripts/validate-script.mjs "<book>" [script-version]` | Blocking limits pass before showing a draft |
| Agent TTS | `npm run prepare:voiceover -- "<book>" [script-version]` | Audio, Edge subtitles, TTS input, and timings validate together |
| User audio timings | `node scripts/create-body-timings.mjs "<book>" [script-version]` | Use ASR or speech-pause only for user-supplied audio |
| Final render | `node scripts/render-episode-final.mjs "<book>" [script-version] [bgm]` | Validated MP4 and manifest replace the active render atomically |
| Episode preflight | `npm run check:episode -- "<book>" [script-version] --pre-render` | Script, timings, audio, and image inputs are render-ready |
| Completed episode | `npm run check:episode -- "<book>" [script-version]` | Active MP4 and manifest remain valid |
| Stock batch start | `npm run stock:begin -- "<sample-book>" "<next-book>" ...` | First book becomes the end-to-end sample gate |
| Publishable finalize | `npm run stock:finalize -- "<book>" [script-version]` | Immutable release, publish data, hashes, title index, queue reread, and delivery all pass |
| Stock verification | `npm run stock:verify` | Every batch item matches active media, publish data, hashes, and queue |
| Mistaken stock rollback | `npm run stock:rollback -- --dry-run` | Preview an exact release/hash rollback; apply only with `--apply --confirm-mistaken-stock-rollback` |
| Inventory read | `npm run inventory:list` | UTF-8 read of the active publication queue |
| Production ledger migration | `npm run production:migrate` | Rebuild and atomically merge local render, release, queue, session, and proof history |
| Production history | `npm run production:list [-- --book "<display_title>"]` | Report generated, released, and evidence-backed platform history |
| Production history verification | `npm run production:verify` | Cross-check the active queue, immutable releases, and local production ledger |
| Next Douyin object | `npm run publish:next` | Return only the first safe pending Douyin release, or null |
| Inventory verification | `npm run inventory:verify` | Revalidate current queue items against disk and the production ledger |
| Publication brief | `npm run publish:brief -- --position <n>` | Revalidate the exact queue item, copy, settings, media, and hash |
| Xiaohongshu manual panel | `npm run publish:xiaohongshu -- --position <n>` | Open the official page in the normal browser and show the always-on-top manual material panel |
| Xiaohongshu manual verification status | `npm run publish:xiaohongshu:status -- --position <n>` | Report that post-close publication verification is disabled |
| Douyin browser preparation | `npm run publish:start -- --position <n> ...` | Use the dedicated profile and stop Douyin at `ready` |
| Publication status | `npm run publish:status` | Read the current local browser-publication session without changing it |
| Final Douyin publication | `npm run publish:confirm -- --platform douyin --confirm-sha <sha256>` | Publish only a ready Douyin form with an exact render-hash confirmation |
| Douyin publication verification | `npm run publish:verify -- --platform douyin [--session <id>]` | Search the official work list after an ambiguous submission, save a proof screenshot, and record success only on an exact-title match |
| Preview delivery | `npm run preview:delivery -- "<absolute-preview-path>"` | Emit the single approved preview field |
| Completed delivery | `npm run check:episode -- "<book>" [script-version] --delivery` | Emit the approved completed-video fields from verified state |
| Temporary cleanup | `npm run cleanup:temp -- --dry-run` | Inspect managed temporary cleanup without deleting |
| Episode cleanup | `npm run cleanup:episodes -- --dry-run` | Inventory eligible, protected, and review-required episodes |
| Episode cleanup apply | `npm run cleanup:episodes -- --apply` | Use only after explicit cleanup authorization and dry-run review |
| Repository validation | `npm run check` | Unit, asset provenance, template, and repository checks pass |

## Production Decisions

- Keep `source_title` unchanged for provenance and use normalized `display_title` for folders, visible labels, scripts, duplicate checks, and the generated-title index. Ambiguous editions, guides, summaries, or author mismatches require review.
- The first spoken line must create resonance. Present the complete copy-ready script in one fenced block beginning with `《书名》`; do not include CSV headers, numbering, author labels, timing data, or commentary inside that block.
- Generate media only after approval. `script.csv` remains subtitle truth. Agent-generated TTS uses native Edge word boundaries; user-supplied audio may use ASR or speech-pause fallback.
- A successful render is not publishable inventory. Publication requires a valid `publish.json`, an immutable release package with a `READY` marker, matching hashes, atomic queue enrollment, queue reread, generated-title recording, and successful final delivery formatting. A new release must never inherit another release's platform status or proof.
- Treat `.agents/production-ledger.json` as the local historical truth and `.agents/publish-queue.json` as the active-work projection. Use `releaseId + renderSha256` for identity; `position` is display order only. A legacy generated-title claim is a duplicate tombstone, not proof that a render or release exists.
- Derive `everGenerated` from a validated render, `everReleased` from a valid READY release package, and `everPublished` only from trusted platform proof bound to the same release and hash. A browser session or manual panel is an attempt, never publication proof by itself.
- Restoring the same archived release must preserve its platform state and proof. A genuinely new release starts pending, while prior release history remains in the production ledger.
- Douyin publication, post-publication verification, screenshots, recording, and retries must use the repository's `publish:*` browser scripts with the ignored dedicated profile. Never substitute direct browser control, Computer Use, an ad hoc Playwright command, a platform API, or another fallback.
- Xiaohongshu publication is manual only. Use `publish:xiaohongshu` to open the official page in the user's normal browser and show the independent always-on-top panel. The panel may expose native file drag, copy actions, user-clicked cursor insertion for title and description, and user-clicked sequential tag entry with keyboard acceptance of the first platform suggestion. It must never inspect the page, upload automatically, change settings, click publish, or launch Playwright. The user must visually verify every selected topic before publishing.
- Xiaohongshu post-close publication verification is permanently disabled. Closing the manual panel must not start a watcher, inspect the official note manager, require account identifiers, save proof screenshots, or update the queue to `published`. Xiaohongshu has no independent operational publication status: completion, inventory reporting, archival, and daily automation follow the same release's Douyin status. Do not report Xiaohongshu as pending or unpublished merely because it has no platform proof; historical Xiaohongshu evidence may remain in the ledger for provenance only.
- An explicit user instruction in the current task to publish or start publishing is the publication confirmation for that run. For Douyin, do not ask for a second confirmation and still pass the exact prepared SHA-256 to `publish:confirm` as the script's internal integrity gate. Never publish content that has no explicit current-task publication instruction.
- Douyin browser publication must use the official creator page and the ignored dedicated profile. Stop at `ready`, revalidate the account, copy, associated official topics, settings, media path, and exact hash, then let `publish:confirm` click the final control once.
- After Douyin accepts a submission, the script must open the official work list, verify an exact-title match in a submitted state such as published or under review, and save a list-page screenshot as publication proof. Deliver that screenshot to the user. Update only the verified platform status under the queue lock, and only after both the exact-title list match and proof screenshot succeed.
- Douyin publication-proof screenshots must capture only the current browser viewport (`fullPage: false`), with the matched recent work visible, rather than saving the entire scrollable work list as a long image.
- Count one Douyin publication attempt as one script-created session for the same release ID. On a definite pre-submit or platform-rejected failure, create a fresh script session and retry the same immutable release, account, copy, topics, and settings. Stop immediately on success. Stop after three definite failures, keep Douyin pending, and report the three session IDs and concrete failure reasons.
- An ambiguous Douyin submit outcome is not a definite failure and must never trigger an immediate re-upload. Run `publish:verify` through the script first. If the official list contains the exact title, capture proof and record success without republishing; if authoritative verification proves the title absent, the next fresh script session counts as the next attempt. A `published_unrecorded` state must be repaired with script verification or recording, never by republishing.
- Every Douyin hashtag in `publish.json` must be selected from the official topic suggestions during browser preparation. For Xiaohongshu, the panel's tag button sequentially enters each proposed tag and accepts the first platform suggestion; the user must confirm that every selected suggestion is the intended official topic. A mismatch or unassociated plain hashtag blocks publication.
- Xiaohongshu's original-declaration control defaults to off. The compact manual panel does not display publication settings; the user must visually verify the off state on the official page before publishing, and any visible enabled state blocks publication.
- Closing the Xiaohongshu panel only closes the helper. It must not trigger publication verification, reopen the page, or upload again.
- For publication research, stop repeating a route after two failures. Use a second public route at most once, then fall back to WeChat Reading or recorded local signals and label the evidence honestly.
- Do not report stock counts or today's publication choice from an unverified queue.

## Output Policy

- For a pre-publication preview, return the output of `preview:delivery` verbatim and nothing else.
- For completed videos, return the output of `stock:finalize` or `check:episode --delivery` verbatim. Do not reconstruct Markdown paths or read title and description with ad hoc shell commands.
- Do not add technical metadata, alternative titles, recommendation labels, timestamps, or tags unless the user explicitly asks for them.

## Validation And Learning

- `npm run check` validates reusable repository state; it does not replace single-episode or inventory validation.
- Before a public repository release, also inspect reachable Git history for secrets and private media, verify no full reference transcript remains, and test clean-clone initialization with and without WeChat Reading.
- Before producing or fixing a video, read `.agents/video-error-log.md` when it exists. When a new production error is reported, record its symptom, root cause, prevention rule, and required verification before the next render.
