<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./skills/subtitle-me/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./skills/subtitle-me/assets/logo-light.svg">
    <img alt="Subtitle Me" src="./skills/subtitle-me/assets/logo-light.svg" width="720">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/blainehuang1028/subtitle-me/actions/workflows/test.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/blainehuang1028/subtitle-me/test.yml?branch=main&style=flat-square&label=tests"></a>
  <img alt="Version 0.1.0" src="https://img.shields.io/badge/version-0.1.0-5B7CFA?style=flat-square">
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-101522?style=flat-square"></a>
</p>

<p align="center">
  译名有谱，字幕有据。为你的 Agent 装上字幕翻译 Skill，项目术语库统一译名，AI 对照原文再审一遍。
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#使用">使用</a> ·
  <a href="#它会做什么">功能</a> ·
  <a href="#english">English</a>
</p>

## 安装

```bash
npx skills@latest add blainehuang1028/subtitle-me
```

需要 Node.js 20 或更高版本。

![安装和任务初始化示例](./docs/images/quick-start.svg)

## 使用

把 SRT、WebVTT、YouTube JSON3 或 ASS 字幕文件交给 Agent，然后说：

```text
帮我翻译这个视频
```

也可以直接说明你想要的产物：

```text
用 subtitle-me 把 captions.en.srt 翻译成简体中文，
需要中英双语 ASS，也请给我一个中文标题。
```

开始前，Agent 会一次确认素材、双语 ASS 和中文标题。默认交付适合观看的简体中文 SRT。

## 它会做什么

- 直接从带时间轴的英文字幕翻译成简体中文
- 为每个项目建立一份空白术语库，统一人名、品牌和专业词汇
- 保留忠实原意的翻译版本，并生成更适合单行阅读的观看版本
- 完成第二轮中英对照审校，再检查漏译、数字、术语和时间轴
- 按需生成一行中文加一行英文的双语 ASS
- 按需提供自然的中文标题

![字幕和 QA 结果](./docs/images/qa-result.svg)

所有工作文件都保存在当前项目可见的 `subtitle-localizer/` 目录。术语库不会跨项目共享，也不会预装任何术语。需要联网查询术语时，Agent 会先征求你的同意。

## 输入与产物

支持输入：

- SRT
- WebVTT
- YouTube JSON3
- ASS 对白

主要产物：

- `semantic.zh-Hans.srt`：忠实原意的中文字幕
- `readable.zh-Hans.srt`：适合屏幕单行阅读的中文字幕
- `bilingual.zh-en.ass`：可选的中英双语字幕
- `title.zh-Hans.md`：可选的中文标题
- `report.md`：术语、审校和 QA 结果

## 当前边界

`v0.1.0` 需要用户提供带时间轴的英文字幕。它暂不处理语音识别、视频下载、字幕烧录、配音、TTS、平台上传或其他语言对。

生成 ASS 不需要 FFmpeg。只有你要求渲染预览图时才会检查 FFmpeg，缺少时也不会自行安装。

## 兼容性

- Codex：已验证安装和完整示例
- Hermes Agent、OpenCode、Pi、OpenClaw、Trae：兼容通用 Agent Skill 结构
- WorkBuddy：从 [GitHub Release](https://github.com/blainehuang1028/subtitle-me/releases) 导入 ZIP

## License

[MIT](./LICENSE) © 2026 Kai Huang

---

## English

Subtitle Me turns timed English captions into reviewed Simplified Chinese subtitles. It keeps terminology consistent, improves on-screen readability, and can optionally create bilingual ASS subtitles and a Chinese title.

### Install

```bash
npx skills@latest add blainehuang1028/subtitle-me
```

Node.js 20 or newer is required.

Attach an SRT, WebVTT, YouTube JSON3, or ASS file and say:

```text
Translate this video with subtitle-me.
```

Each project starts with an empty, project-owned glossary. The default result is a readable Simplified Chinese SRT, accompanied by terminology and review reports. Project files stay in the visible `subtitle-localizer/` directory.

Optional outputs include bilingual ASS subtitles with one Chinese row and one smaller English row, plus a natural Chinese title.

Version 0.1.0 does not perform ASR, download media, burn subtitles into video, create dubbing, upload to platforms, or translate arbitrary language pairs. FFmpeg is only needed when you request an ASS preview.

Codex has been verified with a complete example. Hermes Agent, OpenCode, Pi, OpenClaw, and Trae follow the same Agent Skill structure. WorkBuddy users can import the ZIP from [GitHub Releases](https://github.com/blainehuang1028/subtitle-me/releases).
