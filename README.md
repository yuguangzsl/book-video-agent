# Book Video

这是一个通过自然语言制作图书带货短视频的开源工作流。它把选书、文案、氛围图、旁白对齐和成片制作组织成一套可复用的流程。

Copyright (c) 2026 prototech, endless, and 未济.

## 运行要求

开始前请安装以下基础环境：

- [Codex](https://developers.openai.com/codex/)：安装并登录后，用它打开本项目目录。
- [Git](https://git-scm.com/)：用于克隆和更新项目。
- [Node.js 22 或更高版本](https://nodejs.org/)：安装包需要同时提供 `node`、`npm` 和 `npx`。
- [FFmpeg](https://ffmpeg.org/)：安装后需要能在终端中直接运行 `ffmpeg` 和 `ffprobe`。
- [`whisper-cli`](https://github.com/ggml-org/whisper.cpp)：仅在处理用户提供的音频时使用，但首次环境检查会确认它和 Whisper 模型是否可用。

可以在终端中运行以下命令检查基础环境：

```powershell
git --version
node --version
npm --version
ffmpeg -version
ffprobe -version
whisper-cli --version
```

## 安装

克隆项目并安装 Node.js 依赖：

```powershell
git clone https://github.com/yuguangzsl/book-video-agent.git
cd book-video
npm install
```

安装完成后，可以运行仓库检查：

```powershell
npm run check
```

## 首次运行

1. 打开 Codex，把克隆得到的 `book-video` 目录添加为项目。
2. 在新任务中输入：“你好，请检查并初始化当前项目。”
3. Codex 会先运行只读检查，确认 Node.js、FFmpeg、`whisper-cli`、Whisper 模型和其他运行能力是否可用。
4. 如果缺少依赖，Codex 会集中说明缺少的内容，并在需要安装或下载前征求确认。
5. 检查通过后，Codex 会完成本地初始化。生成的视频、账号状态、密钥、候选书目和其他私人数据只保存在本地，不会提交到 Git。

也可以在项目根目录手动运行只读检查：

```powershell
node scripts/init.mjs --check
```

如果需要微信读书的书籍信息、评分、热门划线和公开书评，可以启用腾讯官方微信读书 Skill。API Key 不要发送到对话中；确认配置后，只在本地交互式终端运行：

```powershell
node scripts/init.mjs --configure-weread
```

完成初始化后，你不需要先学习代码或命令。直接在 Codex 中用自然语言描述想制作的图书视频即可。

## 制作步骤

1. 告诉 Codex 你要做哪本书，或者让它推荐五本适合做短视频的书。
2. Codex 确认书名、作者和版本，先检查是否已经生成过，再在对话中用代码块完整展示可直接用于配音的文稿，第一行包含书名，同时保存为本地脚本文件。
3. 你直接在对话中审核文案；确认后，Codex 生成氛围图和视频画面。
4. Codex 默认通过 `node-edge-tts` 和 `zh-CN-YunxiNeural` 生成口播，语速为 `-8%`、音调为 `-2Hz`；你也可以明确指定其他声音、韵律或提供自己的音频。
5. Codex 优先使用 `node-edge-tts` 的服务字幕词边界生成时间轴；用户提供音频时才使用 ASR 或语音停顿作为时间参考。字幕始终以 `script.csv` 为真源，之后混入 BGM 并渲染最终 MP4。
6. 如果你要求替换文案、图片或音频，Codex 会生成新方案，通过检查后覆盖旧方案。
7. 成片通过检查后，Codex 参考至少 5 个可核验的热门同类视频，生成并保存 3 个标题候选、1 段简介和 3-5 个标签；最终通过 `stock:finalize` 或 `check:episode --delivery` 返回可点击的视频路径、选定标题和选定简介。

自动补货和发布使用可恢复的统一入口：`npm run workflow -- replenish`、`publish-next`、`status`、`resume` 和 `verify`。运行状态原子保存在 `.agents/workflow-runs/`；Codex 每次只执行返回的一个 action envelope，完成后携带精确 action ID 恢复。action、release 或成片哈希不一致都会失败关闭。补货只统计带 `READY` 且抖音待发布的库存：每次补货都补满 7 条，达到 7 条才静默结束；生产与公开发布相互独立。候选短名单按微信读书阅读人数、评分人数、书评数和热门划线人数的分位排名加权，信号超过 7 天必须刷新，同书不同版本先按规范化书名和作者聚合。

补货批次仍由 `stock:begin` 建立样本门，并逐本执行 `stock:finalize`，不能推迟到整批末尾。`stock:finalize` 前必须先生成并完成哈希绑定的 `qa.json`：`npm run qa:prepare -- "<书名>" [版本] [返工次数]` 抽取封面、片头、每个正文场景和结尾帧并检测亮度、重复画面、静音和削波；Codex 完成画面语义检查和独立 ASR 三段抽查后，运行 `npm run qa:complete -- "<书名>" "<review.json>" [版本]`。局部返工最多两次，仍失败时不得创建 release。发现误入库批次时，先运行 `npm run stock:rollback -- --dry-run` 核对精确 release 和成片哈希，再执行可恢复回滚。

清理历史 episode 时先运行 `npm run cleanup:episodes -- --dry-run`；只有用户明确确认清理范围后才运行 `--apply`。删除前会先保存标准化书名，避免以后重复生产。

生成过程使用带生命周期标记的独立临时目录：独立预览保留 24 小时，失败任务保留 72 小时，最终成片成功后立即清理。可以运行 `npm run cleanup:temp -- --dry-run` 查看待清理内容；项目不会自动删除 `tmp/` 中来源不明、没有生命周期标记的文件。

发布前，`npm run publish:brief -- --position <序号>` 只从带 `READY` 标记的不可变 release 生成发布清单。抖音继续使用专用 Chrome 工作流：`npm run publish:start -- --position <序号> ...` 预填官方发布页并停在最终发布按钮前，只有 release、文案、队列状态和成片 SHA-256 完全一致的 `publish:confirm` 才会触发发布。小红书使用人工发布：`npm run publish:xiaohongshu -- --position <序号>` 用普通浏览器打开官方发布页，并在桌面上方显示置顶面板；视频可以直接拖入上传区，标题和简介既可复制也可在用户点击后输入到刚刚聚焦的光标位置，标签会逐个输入并用键盘确认第一条平台建议，所有设置和最终话题都由用户核对并手工发布。面板不会读取网页或点击发布；关闭后不会检查作品列表、保存发布证明或更新队列发布状态。小红书不再维护独立的发布完成状态，库存、归档和日常自动化直接跟随同一 release 的抖音状态；缺少小红书凭证不再显示为“待发布”或“未发布”。

本地生产历史由 `.agents/production-ledger.json` 记录：有效 render 表示“生成过”，带 `READY` 的不可变 release 表示“形成过发布包”，绑定同一 release ID 和 SHA-256 的官方凭证才表示“发布过”。首次对账运行 `npm run production:migrate`，日常验证运行 `npm run production:verify`，查看下一条安全的抖音待发布对象运行 `npm run publish:next`。活动队列 schema v2 只保存抖音运营状态和可信 proof；旧 schema 可只读兼容，切换时用 `npm run inventory:migrate-v2` 在队列锁内备份并原子升级。小红书历史证据仍留在生产台账。活动队列只表示当前待办，序号不是历史身份。

你也可以直接用自然语言操作，例如：

- “你好。”
- “推荐五本适合做情绪共鸣类视频的书。”
- “我想制作一本关于孤独和自我成长的书。”
- “把当前文案换成我提供的版本。”
- “这版视频不满意，请保留模板，替换图片和文案。”

## 参考来源

本项目的图书视频工作流参考了[原帖](https://x.com/369Serena/status/2073398014333321498)，特此致谢。

## 版权与许可

本项目的代码、文档和可复用模板采用 [Apache-2.0](LICENSE) 发布，版权方为 prototech（组织名），endless（网名）。Apache-2.0 不代表它自动覆盖第三方工具、字体、模型、图片生成服务或媒体素材。

仓库包含四首默认 BGM，位于 `assets/bgm/`：`城南花已开.mp3`、`红色高跟鞋.mp3`、`起风了.mp3`、`如愿.mp3`。项目维护者已确认这些文件可以随本项目公开再发布；它们的来源和授权状态记录在 `templates/shared-video-template/ASSET_PROVENANCE.csv` 中。将音频用于其他商业场景时，仍需遵守对应授权范围。

更详细的内部生产规则见 `AGENTS.md` 和 `docs/book-video-playbook.md`；当前旧批次完成后的定时任务切换步骤和提示词见 `docs/automation-cutover.md`。
