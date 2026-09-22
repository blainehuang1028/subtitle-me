# Changelog

## 0.2.0 · 2026-09-22

- Added contextual natural-Chinese guidance, fidelity boundaries, and worked translation examples.
- Made bilingual ASS the default Agent workflow, with explicit Chinese-only and English-only presentation options.
- Added review reuse for unchanged ranges with adjacent context; changed source text and relevant terminology are checked again.
- Added optional video descriptions with a summary, original source URL, and creator attribution.
- Added a website feature section, sourced translation comparisons, public changelog, and links to the author's subtitle work.

Migration: existing jobs retain their output options; old review records need one full review before incremental reuse. Readable Chinese now requires one physical line. Single-language delivery still keeps both internal masters for QA. Media acquisition, burn-in and upload remain outside the public skill.

## 0.1.0

- Added English to Simplified Chinese timed subtitle localization workflow.
- Added project-owned terminology governance with JSON authority, Markdown view, and JSONL journal.
- Added semantic and readable SRT layers, independent AI review evidence, and deterministic QA.
- Added optional bilingual ASS and Chinese title output.
- Added SRT, WebVTT, YouTube JSON3, and ASS dialogue input handling.
- Added visible, resumable job progress with direct source-text refresh detection.
- Added fail-closed parsing, UTF-16 subtitle support, input/package limits, atomic file writes, and strict WorkBuddy file allowlisting.
- Added macOS, Windows, and Linux CI plus WorkBuddy ZIP packaging.
