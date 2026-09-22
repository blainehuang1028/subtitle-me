# Workflow and commands

Use this reference after preflight or when resuming a job.

## Runtime

The deterministic layer requires Node.js 20 or newer and uses only the Node standard library.

```bash
node "$SKILL_ROOT/scripts/subtitle-me.mjs" doctor
```

FFmpeg is not checked by default because translation, SRT output, ASS generation, terminology, and QA do not require it.

## Visible project layout

```text
subtitle-localizer/
  README.md
  glossary.json
  glossary.md
  glossary.changes.jsonl
  jobs/<job-id>/
    job.json
    source/source.en.srt
    subtitles/semantic.zh-Hans.srt
    subtitles/readable.zh-Hans.srt
    subtitles/readable.en.srt
    subtitles/bilingual.zh-en.ass       optional
    qa/term-candidates.json
    qa/term-decisions.json
    qa/ai-review.json
    qa/qa.json
    title.zh-Hans.md                    optional
    description.zh-Hans.md              optional
    report.md
```

`glossary.json` is the terminology authority. `glossary.md` is generated and must not be parsed as a mutation source. `glossary.changes.jsonl` records applied changes.

## Commands

Initialize or refresh a job:

```bash
node "$SKILL_ROOT/scripts/subtitle-me.mjs" init \
  --input "captions.en.srt" \
  --project "$PROJECT_ROOT" \
  --ass yes \
  --title yes
```

Inspect resumable state:

```bash
node "$SKILL_ROOT/scripts/subtitle-me.mjs" status --job "$JOB_DIR"
```

Validate or update project terminology:

```bash
node "$SKILL_ROOT/scripts/subtitle-me.mjs" glossary lint --project "$PROJECT_ROOT"
node "$SKILL_ROOT/scripts/subtitle-me.mjs" glossary apply --job "$JOB_DIR"
```

Generate deterministic layers and QA:

```bash
node "$SKILL_ROOT/scripts/subtitle-me.mjs" readable --job "$JOB_DIR"
node "$SKILL_ROOT/scripts/subtitle-me.mjs" review scaffold --job "$JOB_DIR"
node "$SKILL_ROOT/scripts/subtitle-me.mjs" ass build --job "$JOB_DIR"
node "$SKILL_ROOT/scripts/subtitle-me.mjs" qa --job "$JOB_DIR"
```

Run `review scaffold` after terminology application and after the final semantic translation exists. Complete the scaffold through an actual second review. If that review changes the translation, regenerate the scaffold and review the updated file again before QA.

When a Chinese title was requested, create `title.zh-Hans.md` before QA with this exact two-line shape:

```text
Original: <original title>
Chinese: <natural Simplified Chinese title>
```

Keep it to one title pair. For a requested video description, initialize with `--description yes` and write a summary, `来源：<original URL>` and `作者：<creator>` in `description.zh-Hans.md`. Final QA requires all three. Tags, chapters and uploading remain out of scope.

## Resuming and rerunning

`job.json` records the original subtitle path, source format, options, and phase states. It does not hash media. New AI review scaffolds keep visible per-batch text snapshots to identify changed ranges.

- Run `status` to see the last completed phase.
- Run `init` again if the input subtitle changed. A source text change resets downstream phases and keeps the preceding terminology records and AI-review summary inside the reset JSON files for reference.
- After changing the semantic translation, regenerate readable output, scaffold and review changed ranges with context, rebuild optional ASS, and run QA.
- After changing terminology, regenerate readable output if the chosen wording changed, then scaffold and review changed ranges with context, rebuild optional ASS when needed, and run QA.
- After changing readable subtitles, ASS, or title files, rebuild any dependent artifact and rerun QA.

Existing files stay visible for inspection. The phase state is guidance, while the latest QA run is the delivery check.

ASS defaults to two rows. Explicit single-language requests use `ass build --job "$JOB_DIR" --language zh` or `--language en`; final QA validates the selected mode. Keep both masters internally, but deliver only the requested language.
