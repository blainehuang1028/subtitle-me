# Formats, timing, and readability

Read this reference when normalizing input or resolving readable-layer failures.

## Input formats

- SRT: full support.
- WebVTT: full support for timed cues. Cue settings and HTML styling are normalized away.
- YouTube JSON3: supported as a supplied caption file. Each text event keeps its declared `tStartMs` and `dDurationMs` outer window; a missing duration falls back to the next event or two seconds. Long events may be split proportionally inside that window. Declared overlaps remain visible as timing warnings.
- ASS or SSA: dialogue is extracted with an explicit warning. Original styling, positioning, effects, and event layers are not preserved.

The skill does not acquire these files from a video platform.

During initialization, all accepted formats are normalized to SRT identifiers `1..N`. Terminology `cueIndexes` refer to these normalized 1-based positions, not any original SRT identifier.

## Timing authority

The supplied timed subtitle is authoritative. Do not shift or repair its synchronization. Report overlaps, strange ordering, or suspicious durations for the user to inspect.

Readable segmentation may split only within one source cue. It must preserve the original outer start and end of that cue. It must not merge unrelated or non-contiguous source ranges.

## Chinese readability

The readable Chinese layer strongly prefers one physical line per cue.

- Target 16 display units.
- Hard maximum 24 display units per physical line.
- Han and full-width characters count as 1 unit.
- Latin characters, digits, spaces, and half-width punctuation count as 0.5 unit.
- Prefer punctuation or a natural phrase boundary.
- Never cut inside an approved term, name, Latin word, or number-plus-unit expression.

If a single line would break meaning or create unreasonable reading pressure, the semantic translation may contain an intentional two-line exception. Both lines must fit the hard limit, and QA will expose the exception as a warning. Do not create more than two Chinese lines.

Bilingual ASS is stricter: it permits one Chinese row and one smaller English row. A Chinese two-line exception therefore blocks ASS generation. Rewrite or split the cue naturally instead of producing a three-row block.

## Reading warnings

Deterministic QA warns when a Chinese cue is shorter than 5/6 second, exceeds 9 display units per second, exceeds the 16-unit target, or uses a two-line exception. Review warnings in adjacent context. Do not hide them by weakening the limits.
