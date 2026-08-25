# Book Video 生产手册

这是图书带货视频的详细生产 SOP；项目级策略和命令入口以根目录 `AGENTS.md` 为准，可判定的交付格式以校验脚本输出为准。共享模板位于 `templates/shared-video-template/`；每期只替换书籍信息、文案、AI 图片、正文口播和 BGM。

规则强度遵循 `AGENTS.md`：硬上限以及“必须、禁止、仅限”属于阻塞性要求；“建议、约、默认、优先”属于质量目标，除非验证脚本报错，否则不阻塞流程。

## 工作流

1. 初始化：仅在首次处理选书、文案、视频制作、渲染或发布任务且 `.book-automation-state.json` 不存在时执行。纯仓库维护、代码或文档查询、规则讨论跳过初始化；状态文件已存在时不重复执行，除非用户明确要求重新检查环境，或相关依赖、配置已经变化。需要初始化时，Agent 先定位当前仓库根目录，运行只读的 `node scripts/init.mjs --check`，一次性检查 Node.js、FFmpeg/FFprobe、`npx`、`whisper-cli`、Whisper 模型和微信读书配置，不提示输入、不迁移文件、不写状态。不要根据 FFmpeg/FFprobe 的版本输出首行判断是否安装，统一以退出状态和 JSON 结果为准。缺少依赖时集中说明并征得一次同意，再负责安装或下载。HyperFrames 首次使用可能需要 npm registry；网络被拦截时，Agent 直接通过执行工具申请网络权限并自动重试，不重复询问用户。微信读书 Skill 自动安装启用；缺少 API Key 时先询问是否配置，用户确认后打开官网，并让用户在本地交互式终端运行 `node scripts/init.mjs --configure-weread`，在隐藏提示中输入 Key，禁止把 Key 发到对话或命令参数。所有检查完成后运行非交互式的 `node scripts/init.mjs --apply`，再创建或迁移私有候选池并写入状态。
2. 选书：读取本地候选池；没有候选时先询问偏好，再搜索候选书。微信读书 Skill 已安装且可用时，优先灵活使用它获取书籍详情、评分、热门划线和公开书评；没有有效结果时再补充公开资料或用户提供的信息。搜索结果必须先全量写入本地 `data/book-pipeline.csv`，再从已记录的书目中选择五本并标出首选。
3. 书目确认：确认书名、作者、版本和 `display_title`，然后运行 `npm run book:check -- "<display_title>"`。只有显式修复、修改或重渲染现有 episode 时才使用 `--maintenance`。
4. 文案确认：先阅读书籍元数据、热门划线和公开书评等可用研究材料，再按本文的脚本原则只写一版文案。微信读书内容用于提炼情绪入口和事实背景，不直接复制长段落或整篇书评。文案在消息中用一个 Markdown 代码块完整展示可配音内容。代码块第一行写 `《书名》`，后面紧接全部朗读正文，不加入 CSV 字段、序号、作者标签、时间戳或解释；用户应能一次性复制代码块作为配音输入，无需再次清理。同时保存为 `script.csv` 作为机器处理真源，等待用户确认后再继续。
   文案长度：推荐总计 18–20 行（含书名），硬上限 22 行（含书名）；正文 `script.csv` 最多 21 行、约 220 个汉字。文案写入临时 `script.csv` 后，必须先运行 `node scripts/validate-script.mjs "<book>"`；未通过时由 Agent 内部缩短，不能先发给用户确认，也不能等到配音或最终渲染阶段才处理。
5. 图片制作：确认后生成 3 张 AI 氛围图和一张结果桥接图，记录提示词和来源。
6. 音频制作：默认使用全局 `text-to-speech` Skill，通过 `node-edge-tts` 和 `zh-CN-YunxiNeural` 生成正文口播，语速 `-8%`、音调 `-2Hz`；用户明确选择其他声音、韵律或提供自己的音频时按用户选择处理。生成配音时建立独立的 TTS 输入副本，为缺少结尾标点的标题和正文单元补充明确句号并保存服务字幕 JSON，不修改对话中展示的 `《书名》` 或 `script.csv`。
7. 配音与时间轴：Agent 生成配音时运行 `node scripts/prepare-body-voiceover.mjs "<book>" [script-version]`，脚本会同时保存 Edge TTS 词边界并生成 `body-timings.json`；用户提供音频时才单独运行 `scripts/create-body-timings.mjs`，以 ASR 或语音停顿作为回退参考。`script.csv` 始终是字幕真源。
8. 对齐渲染：裁剪 BGM 到视频长度并完成混音；最终 MP4 同目录生成同名 `.manifest.json`，记录脚本版本、实际 BGM、混音参数、输入素材哈希和成片规格。
9. 验收替换：检查画幅、时长、字幕、音频和模板连续性。新方案通过技术检查后覆盖旧方案，保持每期只有一套活动资产。最终渲染成功只代表成片文件有效，不代表已经成为可发布库存。
10. 发布文案：最终渲染后、上传前研究同主题高互动样本，提炼标题和简介结构，生成 3 个原创标题候选、1 个选定简介和 3-5 个标签，并写入本地 `publish.json`。
11. 入队交付：运行 `npm run stock:finalize -- "<book>" [script-version]`。该命令按固定顺序重新校验成片、校验 `publish.json` 和输入哈希、创建以发布内容摘要为 ID 的不可变 release（独立视频、`release.json`、最后写入的 `READY` 标记）、写入生成书名索引、原子写入发布队列、从磁盘重读队列、再次核对队列项，最后使用重读得到的队列项生成三字段交付文本。文案、策略或成片变化都会形成新 release；旧平台状态和证明只进入历史，不得继承给新 release。任一步失败都不得把该视频计入可发布库存。

片头固定使用 `templates/shared-video-template/intro/default-book-list.json` 中的六本书，不依赖 `book-pipeline.example.csv`，也不排除本期目标书；目标书可以先在滚动中出现，最后再定格到目标页。禁止使用“书名一”“作者一”等占位文本。正文字幕必须由 `script.csv` 和 `body-timings.json` 生成，时间轴数量不完整时禁止渲染。

## 固定输出规则

- `720x960`, `30fps`, 3:4。
- 玻璃碎片拼接开场、书单滚动、短黑场、结果页定格。
- 结果页进入正文时无跳变；书名和作者持续常驻。
- 最终 MP4 的第一帧直接作为发布封面，必须在可见的位图画面上显示书名和作者；黑色或近黑背景即使能看到白字也不通过。渲染时从正文自动选择首个合格画面前置，成片校验会实际解码 frame 0 并执行亮度门禁。
- 正文使用 3 张 AI 氛围图慢推近和交叉淡入。
- 文字使用白色德意黑风格和纯黑文字阴影，不加黑色承托层或卡片 UI。
- 默认不超过 60 秒。
- 最终成片通过 `npm run stock:finalize -- "<book>" [script-version]` 或 `npm run check:episode -- "<book>" [script-version] --delivery` 生成三字段交付文本；预发布预览通过 `npm run preview:delivery -- "<absolute-preview-path>"` 生成单字段文本且不读取 `publish.json`。两者都不直接嵌入对话预览。

## 周补货可执行门禁

周补货在第一次最终渲染前必须建立批次，参数顺序就是生产顺序，第一本是端到端样本：

```powershell
npm run stock:begin -- "样本书" "第二本" "第三本"
```

样本书完成最终渲染和 `publish.json` 后，必须先运行：

```powershell
npm run stock:finalize -- "样本书" v1
```

在该命令完成“成片校验、发布文案与哈希校验、原子入队、队列重读、交付文本生成”之前，`render-episode-final.mjs` 会拒绝渲染同一批次的第二本及后续书目。样本门通过后仍逐本运行 `stock:finalize`，不能把七本的队列更新留到批次末尾。

批次全部完成后，在读取库存数量或决定今日发布内容前运行：

```powershell
npm run stock:verify
```

该命令以批次书目为范围，重新验证每条活动 MP4、manifest、`publish.json`、release ID、哈希和队列项，并从 Node 的 UTF-8 JSON 读取器输出库存快照。查看批次进度使用 `npm run stock:status`，只读查看当前活动队列使用 `npm run inventory:list`，不依赖批次状态复核现有队列使用 `npm run inventory:verify`。历史生成、release 和平台凭证以本地生产账本为准：首次迁移或对账运行 `npm run production:migrate`，日常核验运行 `npm run production:verify`，查询下一条安全的抖音对象运行 `npm run publish:next`。不要用未指定编码的 PowerShell `Get-Content` 直接判断 JSON 是否有效。

`stock:begin` 会对批次内全部书目执行非维护模式的重复资格检查，已有生成标题、有效成片或生产台账历史均阻断；`stock:finalize` 还会阻断脱离活动批次的重复入库。若完整批次被错误写入库存，先运行 `npm run stock:rollback -- --dry-run`，确认只命中该批次锁定的 `book + releaseId + renderSha256`，再运行 `npm run stock:rollback -- --apply --confirm-mistaken-stock-rollback`。回滚只归档活动队列项并退役批次，保留 episode、不可变 release、生产台账和纠错记录，也不会伪造平台发布证明。

## 本地视频输出语义

以下模式由 `scripts/check-episode.mjs` 和单元测试固定，不再依赖临时对话规则：

| 目的 | 命令参数 | 输出语义 |
| --- | --- | --- |
| 正式交付 | `--delivery` | `[打开视频]` 指向准确 MP4，并附标题、简介；要求发布文案和队列均已验证 |
| 对话内播放 | `--media` | `![预览视频](...)` 媒体标签，指向准确 MP4 |
| 打开目录 | `--location` | `[打开文件位置]` 只指向 MP4 所在目录 |

所有本地 Markdown 目标都由代码统一转换为绝对正斜杠路径并包裹尖括号，覆盖空格、括号和中文路径。
预发布预览使用 `npm run preview:delivery -- "<absolute-preview-path>"`，不要手工拼接预览字段。

## 文案规则

- 第一句必须直接抓住观众，不先介绍书，也不铺垫“这本书适合谁”。
- 使用短句、口语化表达和具体生活场景，让情绪先成立，再自然带出书和作者。
- 书籍是情绪和信任的支点，不要写成书评、剧情梗概或主题讲解。
- 画面以氛围感优先，不必逐句解释文案；如果贴合文案会削弱画面，就保留意境。
- 结尾留下余味，不做 CTA，不写购物车、下单、推荐语。

避免：

- “你是不是”式营销开头。
- “不是……而是……”这类重复的 AI 论证句。
- 机械排比和口号化总结。
- “这本书告诉我们”这类生硬讲解。
- 高高在上的劝导语气。

## 发布标题和简介规则

- 优先研究抖音数据分析平台（如飞瓜数据、新抖、蝉妈妈、巨量算数）中的同书、同主题或同情绪视频；精确搜索被登录墙阻挡时，不绕过限制，改用可公开核验的跨平台样本并标明口径。
- 每期至少记录 5 个相关样本的来源平台、标题、简介或简介缺失状态、链接、发布日期和可见互动指标。先按主题相关性筛选，再比较播放、点赞、收藏、评论或分享；没有互动指标时只能称为“结构样本”，不能称为“热门样本”。
- 只提炼标题结构、情绪入口和信息顺序，不复制原句、长简介或标签组合。热门结果是研究信号，不构成流量保证。
- 生成并保存 3 个原创标题候选、1 个选定简介和 3-5 个精确标签。标题使用“具体困境/反差 + 书籍支点或余味”，避免“必看”“封神”“改变一生”等无法证明的夸张承诺。
- 简介控制在 2-4 个短句：先写观众可感知的情绪或场景，再让书籍提供支点，最后自然收束；不写购买 CTA，不堆砌泛标签。
- 将研究口径、样本、候选文案和最终选择保存到本地忽略文件 `episodes/<book>/publish.json`；不得写入账号、Cookie、Token 或其他登录数据。
- 三个标题候选和标签保存在 `publish.json`；最终交付命令只读取其中的选定标题和选定简介并生成三字段输出。只有用户明确要求时，才额外展示候选标题或标签。
- `publish.json` 校验会阻止空研究记录：公开视频路线需要至少 5 个带 URL 和可见指标的 `videoSamples`；公开视频不可用时需要至少 5 个结构化 `fallbackSignals`，并保留非空 `attempts` 说明失败或降级路径。

### 标题简介快速稳定路径

1. 先读取当前期的 `brief.json`、活动版本 `script.csv` 和最终成片 manifest，确定本期真实情绪入口、`scriptVersion`、脚本 SHA-256 和成片 SHA-256，不先打开网页盲搜。
2. 如果 `publish.json` 已存在、其中 `inputs.scriptVersion`、`inputs.scriptSha256` 和 `inputs.renderSha256` 全部与当前 manifest 和最终成片一致，且用户没有要求“最新”“重写”或“换一版”，直接复用其中的选定标题和选定简介完成三字段交付，跳过网络研究。任一指纹缺失或不一致时必须刷新。
3. 必须刷新时，先用 `rg --files episodes -g publish.json` 查看最近任务的 `research.attempts`。优先选择最近成功取得可见互动指标的来源，只执行一个聚焦查询，不并发尝试多个平台。
4. 同一路径连续失败两次，或页面明确出现登录墙、风控、验证码、无互动指标时，立即停止重试。只切换一次公开来源；仍失败则转入微信读书兜底，不继续改写关键词消耗时间。
5. 微信读书兜底使用书籍评分与评分人数、公开点评数量、热门划线人数和当前成片脚本。此时 `popularVideoSampleStatus` 必须写为 `unavailable`，不能把阅读热度称为视频热度。
6. 生成 3 个标题候选、1 个首选标题、1 段 2-4 句简介和 3-5 个标签；标题与简介必须和当前脚本一致。解析校验 `publish.json` 后，只将首选标题和选定简介用于三字段交付，候选标题和标签仅在用户明确要求时展示。
7. 每次研究在 `research.attempts` 中记录 `source`、`method`、`observedAt`、`status` 和 `reason`，成功时补充样本数量与指标类型；不得记录 Cookie、Token、账号或搜索历史。后续任务从最近成功的方法开始。
8. 只有同一来源累计至少 3 次记录后，才能依据成功率和阻断类型调整本节的来源优先级；单次超时不代表来源永久失效。

`publish.json` 应同时记录以下输入指纹，作为是否可安全复用的依据：

```json
{
  "inputs": {
    "scriptVersion": "v1",
    "scriptSha256": "...",
    "renderSha256": "..."
  },
  "research": {
    "attempts": [
      {
        "source": "public-video-source",
        "method": "sorted search page",
        "observedAt": "YYYY-MM-DDTHH:mm:ss+08:00",
        "status": "success | timeout | blocked | no-metrics | invalid-results",
        "reason": "short, non-sensitive explanation"
      }
    ]
  }
}
```

## 当前期文件约定

```text
episodes/<book>/
  brief.json
  script.csv
  prompts.csv
  publish.json   # local, ignored; 热门样本研究和发布文案
  images/       # local, ignored
  audio/        # local, ignored
  renders/      # local, ignored
```

`script.csv` 使用 `display_title` 关联的书籍和唯一活动版本；它是字幕文本真源。`prompts.csv` 记录当前图片提示词、生成工具、来源和审核状态。`publish.json` 记录发布前的样本口径、互动信号、原创标题候选、选定简介和标签。

## 音频约定

- 共享片头口播和齿轮音效属于模板媒体。
- 正文口播从正式介绍书籍的位置开始。
- 配音统一使用全局 `text-to-speech` Skill 的 `node-edge-tts`，默认声音为 `zh-CN-YunxiNeural`，语速 `-8%`、音调 `-2Hz`；只有用户明确选择时才改用其他声音或韵律。
- 口播统一使用 `story` 预设处理。
- ASR 时间轴必须匹配对应的 `scriptVersion`；字幕文本始终以 `script.csv` 为准，不能直接使用 ASR 原文。
- `script.csv` 每一行保持一个完整朗读单元；渲染器优先按逗号、句号、问号等标点分句，每个分句控制在约 12 个汉字以内，过长分句再在内部均衡换行，不能为了排版改动字幕真源。
- 如果用户没有指定 BGM，就从可用曲目中随机选择一首。只有在确认拥有再发布权时，才可以把音乐、音效和口播文件提交进仓库。

## 替换策略

新方案必须通过 `scripts/lib/temp-lifecycle.mjs` 在 `tmp/` 下创建带 `.book-video-temp.json` 的唯一任务目录，不能跨任务复用固定目录。验证通过后，再覆盖当前 episode 的活动文件，并删除被替换的旧媒体。Git 只保留已追踪文本的历史；媒体历史默认不保留。A/B 对比文件只能临时存在，并且需要用户明确同意。

临时目录生命周期：活动任务最多保留 24 小时；独立预览成功后保留 24 小时；失败的预览或渲染保留 72 小时用于诊断；最终成片成功激活后立即删除对应工作目录。到期目录会在创建下一任务、执行 `init.mjs --apply` 或运行 `npm run cleanup:temp` 时清理。普通异常通过 `finally` 删除原子 `.tmp` 文件；进程被强制中断后遗留的已知 `.tmp` 文件超过 24 小时再清理。

自动清理仅识别带生命周期元数据的项目目录和明确列出的原子临时文件，不删除 `tmp/` 中未标记的旧资料。先运行 `npm run cleanup:temp -- --dry-run` 查看范围；`--all-managed` 只在用户明确要求时使用，并且仍保护未到期的活动任务和所有未标记内容。

## 浏览器发布

项目使用官方创作者中心页面发布，不调用逆向接口。平台选择器参考了 `dreammis/social-auto-upload` 的公开实现，但本项目保留独立的发布安全层：

1. `npm run publish:brief -- --position <序号>` 从队列引用的不可变 release 生成清单，要求 `READY` 存在并重新核对 release 内容摘要、MP4 哈希和平台级文案；不再读取生成程序的脚本、音频或图片内部文件。
2. 抖音使用 `npm run publish:start -- --position <序号> --platforms douyin ...` 启动专用 Chrome。小红书使用 `npm run publish:xiaohongshu -- --position <序号>` 打开普通浏览器和人工面板；面板关闭后不执行作品列表核验，也不更新小红书发布状态。小红书的运营完成状态跟随同一 release 的抖音状态，不再单独维护待发布、未发布或核验队列。登录态只保存在 `.agents/browser-publisher/chrome-profile`，不得复制到 Git。
3. 工作进程上传精确文件、填写标题/简介/标签和已确认设置，验证账号与表单后停在最终发布按钮前。`npm run publish:status` 只读查看状态。
4. 用户确认公开发布后，运行 `npm run publish:confirm -- --platform <平台或all> --confirm-sha <完整SHA-256>`。点击前再次读取不可变 release 和队列；release ID、精确哈希、平台文案、表单状态或会话任一不匹配时拒绝发布。
5. 每个平台只点击一次发布。只有官方成功页、官方作品列表中的精确标题、作品 URL 或 work ID 等权威信号通过后，才调用带队列写锁的原子状态更新。失败、超时、验证码或选择器变化均不更新状态，也不自动重复点击。
6. 若平台已验证成功但队列写入失败，会话标记为 `published_unrecorded`。修复本地队列问题后使用 `publish:record` 写入已保存证明；不得重新发布。

默认设置为首帧封面、公开、立即发布、无位置、关闭下载、如实声明 AI 生成、关闭商业推广与原创声明、不启用变现。当前页面缺少要求的声明选项或无法核验账号时，流程必须失败关闭。

## Episode 清理

用户明确说“清理”后，先运行 `npm run cleanup:episodes -- --dry-run`。脚本只盘点仓库 `episodes/` 的直接子目录，优先使用已验证 manifest 的生成时间，再回退到唯一最终 MP4 的修改时间；活动发布队列和进行中的补货批次会被保护。只有超过七个完整自然日且年龄可信的非活动 episode 才会标记为可清理。

确认 dry-run 清单后运行 `npm run cleanup:episodes -- --apply`。脚本会先把标准化 `display_title` 原子写入 `data/generated-book-titles.txt`，再删除对应 episode；年龄不可信、较新、活动中或路径不符合边界的目录不会删除。

## 验证层级

1. 文案验证：请求用户确认前运行 `node scripts/validate-script.mjs "<book>"`。
2. 单期成片验证：`node scripts/render-episode-final.mjs "<book>" [script-version]` 必须通过内置的字幕数量、脚本版本、`720x960` 画幅、音轨、时长和 manifest 检查，才能替换活动媒体。
3. 仓库验证：日常代码修改先运行无网络的 `npm run check:unit`；媒体授权记录运行 `npm run check:assets`；模板或媒体管线变化再运行 `npm run check:template`。`npm run check` 会聚合三者。它们验证仓库，不代替单期 MP4 验收。公开发布仓库前还要检查 Git 历史中的密钥、私人媒体和完整参考转录，并验证全新克隆初始化。

周补货的可发布验收不靠新增对话规则完成：`stock:begin` 建立样本门并执行全批次重复检查，`stock:finalize` 完成单条入队事务并提供第二道重复防线，`stock:verify` 在库存读取前复核整个批次，`stock:rollback` 可恢复地纠正误入库批次；对应行为必须有单元测试。`AGENTS.md` 只保留跨任务且长期稳定的约束，操作性故障修复落在脚本、测试和本手册。

## 版权边界

不要把参考视频转录、长篇图书摘录、书评全文、热门划线汇总、下载的社交媒体视频、用户录音、音乐或账号数据写入 Git 追踪文件。本 SOP 只保留独立表述的视频制作方法。
