# Website design

The user delegated design, then rejected the teal editor concept: it implied an online workstation and obscured the product's project glossary and AI review. The replacement is an editorial subtitle-proofreading page, with no playback, timeline, uploader or simulated app controls.

## Visual specification

- True white canvas, ink `#151515`, gray `#686868`, hairlines `#cecece`, pale yellow proofreading highlights `#ffe79a`.
- System Chinese sans-serif; Impact for the wordmark, Avenir Next Condensed / Arial Narrow for English specimens, monospace for installation commands.
- Desktop container 1320px with 48px outer gutters, 24px on mobile.
- Hero 88px maximum / 46-60px on small phones; section headings 40px / 29px; body 16px / 14px; annotations around 12px.
- Composition: left headline and install action; right unboxed annotated translation; open glossary table; AI proofreading example; ruled installation section; output definitions and scope notes.
- Mobile stacks sections without a workspace-like frame. All copy remains selectable HTML. The only scripted interaction copies the installation command, with an accessible failure fallback.
- Motifs: yellow text highlights, black install button, inline corrected number. Arrows are text glyphs, with no decorative icon system. Use whitespace rather than section rules; only the table header and quiet footer retain separators. The term leader is removed.
- Above-fold copy lock: subtitle-me; 术语库; AI 核验; 安装; GitHub; 译名有谱，字幕有据。; 为你的 Agent 装上字幕翻译 Skill。; 项目术语库统一译名，AI 对照原文再审一遍。; 安装 subtitle-me; the latest install command; the source/translation/term specimen.

## Source and intentional refinements

The glossary and first subtitle specimen come from `examples/demo`. The numeric correction is explicitly a review illustration, not a fabricated live QA result. New projects start with an empty glossary. AI review is a second phase and need not use a separate model. Do not imply perfect accuracy or private/offline model execution.

Two replacement concepts were generated with built-in ImageGen: an editorial black/white/yellow hero and glossary with the exact above-fold copy; a matching AI review, install and deliverables section. The second concept rendered serif type, which is intentionally normalized to the primary concept's sans-serif system. Existing portable skill branding is unchanged; the website uses a neutral letter favicon.

Concepts are retained with local QA evidence for reference only and are not served as page content or included in the distributable skill. They were generated with the built-in ImageGen tool, not the API fallback.

The author's story is a reading section before installation, sourced from https://heyblaine.com/projects/subtitle-me and https://heyblaine.com/about. Keep the English degree, business translation, memoQ and personal subtitle experience factual; do not invent employers, years, metrics or guarantees. Preserve the incumbent palette and typography when simplifying the page.

## Version 0.2.0 extension

Preserve the incumbent editorial system. Add open feature rows, paired translation examples, an explicit exception, and an in-page changelog. Historical translations and newly edited examples have distinct labels; illustrative sentences are never attributed to an untested model or skill. Link the creator's supplied public profile for actual work without implying every video used the current public package.

The comparison section is one focused proofreading surface rather than a run of article cards. A three-item tab list switches among tone, action, and rule-boundary cases; each panel keeps source, before/after copy, and the editorial reason in one reading path. Use the accessible tabs interaction pattern while retaining native HTML/CSS/JS and the site's black, white, and yellow visual system.
