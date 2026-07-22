# Episodes

每期视频一个文件夹，只保存本期差异化内容，不复制核心视频代码。

推荐结构：

```text
episodes/book-slug/
  brief.json        # 书籍信息、主情绪、目标人群、视觉方向
  script.csv        # 唯一现行字幕/旁白文本
  prompts.csv       # 唯一现行 AI 生图方案
  publish.json      # 热门样本研究和发布文案，git 忽略
  images/           # AI 生成图片，git 忽略
  audio/            # 口播、ASR、body-timings.json，git 忽略
  renders/          # 最终 MP4 和同名 .manifest.json，git 忽略
```

维护原则：

- `templates/` 维护共享视频代码和检查清单。
- `episodes/` 只维护每本书自己的文案、配置和提示词。
- 发布前至少研究 5 个可核验的相关样本，原创标题、简介、标签及研究口径写入本地 `publish.json`。
- 音频版必须确认口播匹配的 `script.csv` 版本。
- 新方案生成成功后覆盖旧方案；文本历史交给 Git，媒体旧版不归档。
- 当前只保留最新有效图片、音频和 render，错误版和过期预览及时删除。
- Agent 生成的预览和渲染中间文件使用带 `.book-video-temp.json` 的唯一任务目录：预览保留 24 小时、失败任务保留 72 小时、最终成片成功后立即清理。A/B 对比文件只能临时放在 `tmp/`，确认选择后删除；未带生命周期标记的手工文件不会被自动清理。
