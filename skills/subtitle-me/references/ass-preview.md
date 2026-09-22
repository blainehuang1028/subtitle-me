# Bilingual ASS and preview

Read this reference only when bilingual ASS or a visual preview was requested.

## Generation

Generate ASS after readable subtitles exist:

```bash
node "$SKILL_ROOT/scripts/subtitle-me.mjs" ass build --job "$JOB_DIR"
```

The default bilingual style uses:

- one white Chinese row;
- one smaller white English row;
- a thin black outline;
- transparent background;
- explicit wrapping disabled.

Each event is derived from the aligned readable SRT files. ASS generation uses Node only and does not need FFmpeg.

The default font family is `Noto Sans CJK SC`. Pass `--font "<family>"` when the project requires another installed CJK font. Subtitle players may substitute missing fonts.

## Preview

Preview is optional. Before running it, check:

```bash
node "$SKILL_ROOT/scripts/subtitle-me.mjs" doctor --ass-preview
```

If the command reports `FFMPEG_REQUIRED`, ask whether the user wants installation guidance. Do not install FFmpeg automatically.

With FFmpeg available:

```bash
node "$SKILL_ROOT/scripts/subtitle-me.mjs" ass preview \
  --job "$JOB_DIR" \
  --video "optional-video.mp4" \
  --at 30 \
  --output "preview.png"
```

Without `--video`, the command renders the subtitle over a neutral dark background. Preview does not burn subtitles into a delivery video.

For explicit single-language output, add `--language zh` or `--language en` to `ass build`. English-only uses the smaller English font size to preserve its line-width budget. The legacy ASS filename is unchanged. Regenerate older ASS files once when upgrading, since the header now records the language mode.
