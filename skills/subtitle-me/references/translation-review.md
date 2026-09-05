# Translation and independent review

Read this reference while translating and before final QA.

## Semantic translation

Translate directly from `source/source.en.srt` into `subtitles/semantic.zh-Hans.srt`.

- Keep the same cue count, order, normalized 1-based cue positions, start times, and end times.
- Translate meaning rather than English word order.
- Preserve uncertainty, criticism, humor, emphasis, and speaker attitude.
- Preserve numbers, units, names, and approved terminology.
- Do not add background explanations or facts not spoken in the source.
- Keep the semantic layer layout-independent. Readability changes belong in the readable layer.

Work in batches of at most 50 cues when the subtitle is long. Include a small adjacent context window and only the terms active in that batch.

## Second AI pass

This pass is mandatory. Re-read the English and the current Chinese as a fresh comparison. Do not accept the first pass because it sounds fluent.

Check every cue for:

- changed or missing meaning;
- invented meaning;
- names and numbers;
- terminology consistency;
- untranslated English;
- natural Simplified Chinese;
- context across adjacent cue boundaries.

Run:

```bash
node "$SKILL_ROOT/scripts/subtitle-me.mjs" review scaffold --job "$JOB_DIR"
```

The command creates a review record for the current job. Then edit `qa/ai-review.json` only after performing the review:

```json
{
  "schemaVersion": 1,
  "job": "example",
  "status": "passed",
  "reviewedAt": "2026-09-05T00:00:00.000Z",
  "coverage": [
    { "cueStart": 1, "cueEnd": 50 },
    { "cueStart": 51, "cueEnd": 84 }
  ],
  "issues": [],
  "notes": "Reviewed fidelity, names, numbers, terminology, omissions, and natural Chinese."
}
```

Every recorded issue must include `resolved: true` before the review can pass. If a fix changes the semantic translation, generate a new scaffold and review the changed result before running QA.

This evidence may be produced by the same Agent in a deliberately separate pass. A host-specific subagent is optional and must not be required for portability.
