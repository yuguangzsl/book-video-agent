# 自动化切换清单

这两个提示词只在当前旧补货批次全部完成后启用。切换期间先暂停现有发布和补货任务，运行 `npm run inventory:migrate-v2`、`npm run check`、`npm run inventory:verify`、`npm run production:verify`、两个 workflow dry-run 和 `npm run workflow -- verify`；全部通过后再更新原任务并恢复，禁止创建重复任务。

## 每天 10:30 发布任务

模型使用 `gpt-5.6-sol`，推理强度使用 high。任务提示词：

> 这是每天一次的图书视频发布任务。本次运行明确授权：只公开发布活动队列中队首的一条安全抖音 release，并在抖音可信核验成功后交接同一 release 的小红书人工面板。先在仓库根目录运行 `npm run workflow -- publish-next`，只执行返回的当前 action envelope。每次执行前后都核对 action ID、release ID 和 render SHA-256，并用 `npm run workflow -- resume --mode publish-next --action-id <actionId>` 推进。抖音必须使用仓库 `publish:*` 脚本；不确定提交结果只能核验已有会话，禁止重新上传；明确失败最多三个新会话；登录失效、验证码、账号不符、身份或哈希变化、校验失败和未知错误立即停止。抖音精确标题核验和当前视口截图成功后，运行 `npm run publish:xiaohongshu -- --position <n>` 打开同一 release 的人工面板，成功启动即完成交接；不等待面板关闭，不检查小红书作品列表，不写小红书 published 状态。无待发布内容时保持静默；只在发布结果、面板交接、失败或需要登录时通知。

## 每天 13:00 补货任务

模型使用 `gpt-5.6-sol`，推理强度使用 high。任务提示词：

> 这是每天一次的图书视频库存补货任务，只生成可发布库存，不公开发布。先在仓库根目录运行 `npm run workflow -- replenish`，只执行返回的当前 action envelope，并用精确 action ID 通过 `npm run workflow -- resume --mode replenish --action-id <actionId>` 推进，直到完成、无动作或阻塞。每次补货都补满七条；库存达到七条时静默结束。候选刷新优先使用微信读书信号，完整记录搜索结果；按 action 中的短名单、三轮和六十本上限执行。逐本完成文案、图片、配音、时间轴、渲染、`qa:prepare`、Codex 视觉审阅、独立 Whisper ASR 三段抽查、`qa:complete`、发布文案和 `stock:finalize`，不得批量延迟 finalize，也不等待人工审批。QA 失败只返工对应媒体，最多两次，仍失败则换候选且不得创建 release。只有白名单内的 TTS 503/超时和已知 HyperFrames 导航超时可以限次重试；身份、哈希、校验、未知错误、登录失效和验证码不重试。补货完成、真实缺口、失败或需要用户操作时才通知。

切换验证必须确认两个提示词均不包含小红书独立 pending/published 状态、面板关闭后核验、skip/reopen 或旧小红书浏览器自动化命令。
