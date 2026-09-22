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

The readable Chinese layer requires exactly one physical line per cue.

- Target 16 display units.
- Hard maximum 24 display units per physical line.
- Han and full-width characters count as 1 unit.
- Latin characters, digits, spaces, and half-width punctuation count as 0.5 unit.
- Prefer punctuation or a natural phrase boundary.
- Never cut inside an approved term, name, Latin word, or number-plus-unit expression.

Semantic masters may contain formatting line breaks. Readable output normalizes them and splits at safe boundaries if necessary. Never use a second Chinese display row to fix overflow. Default ASS has one Chinese row plus one smaller English row; explicit single-language ASS has one row. Splitting does not create extra reading time, so retain reading-speed warnings and inspect them in context.

## Reading warnings

Deterministic QA warns when a Chinese cue is shorter than 5/6 second, exceeds 9 display units per second, exceeds the 16-unit target. Review warnings in adjacent context. Do not hide them by weakening the limits.
