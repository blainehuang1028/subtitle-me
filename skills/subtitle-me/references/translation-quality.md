# Translation judgment and natural Chinese

Read before translating and reuse during the existing AI review; do not create a separate polishing gate.

## Whole-video context

Record a short translation brief in the job’s `brief.md`: video type (news, commentary, guide, lore), subject and argument, speaker attitude, audience knowledge, recurring people/events, and important cross-batch references. Pass this brief with each bounded cue batch and its nearby context. Do not put the complete glossary into prompts.

## Fidelity before style

Preserve claims, conditions, negation, uncertainty, numbers, names, causal relationships and speaker attitude. Natural Chinese may reorder syntax; it must not amplify or soften a claim. Preserve criticism, humor and meaningful emphasis. Do not add explanations or personal opinions while making a translation sound natural.

Use an equivalent Chinese meme only when it preserves meaning and emotional intensity. For plot, character identity, quoted dialogue or later callbacks, preserve the original reference and prefer established Chinese wording. If there is no suitable equivalent, translate normally.

## Readability is a time budget

Default presentation is one Chinese row plus one English row. Use only the requested language when explicitly asked. Never solve overlong Chinese by making it two visual rows.

Compress redundant phrasing and empty filler before removing information. Keep substantive information, especially conditions, negation, uncertainty and key facts. If the result remains too fast, inspect that span in context. Splitting two seconds into two consecutive cues does not create more reading time. Do not extend timing into another speaker or silently omit facts just to pass a metric.

A natural phrase may continue across successive cues. Preserve understandable semantic boundaries; do not demand a complete sentence or terminal punctuation on every screen. Never cut inside names, terms, words or number-unit expressions.

## Anti-translationese is contextual

Treat “这意味着”, “不是……而是……”, repeated pronouns, mechanical “当……的时候”, stacked modifiers and “进行＋抽象名词” as review clues, not banned strings. Preserve source-supported contrast and inference. Prefer direct verbs and natural spoken syntax where this retains the same meaning. Leave already-natural sentences alone.

Review meaning first, natural expression second, display timing third. Return minimal justified edits, with reasons and exceptions when useful. Do not invent a new finding merely to complete a checklist.

## 改写案例库

以下中文对照为教学而拟写。它们不是从用户历史字幕提取的真实改稿，也不是外部文章原文。后续公开使用时应称为“示例”或“对照案例”，不能写成亲历项目中的实际错误或测评结果。是否适用，仍取决于英文原文、说话语气和相邻字幕。

| 需要警惕的表达 | 示例改写 | 修改理由 | 适用边界 |
| --- | --- | --- | --- |
| 当你完成换弹的时候，你就可以继续射击 | 换完弹就能继续开火 | 缩短机械的时间从句，省去可推知的主语 | 时间先后或条件关系必须保留；原文刻意强调“你”时不能随意省略 |
| 对这把武器的伤害进行了调整 | 调整了这把武器的伤害 | 用直接动词代替“进行＋抽象名词” | 保留调整对象；不能擅自改成“增强”或“削弱” |
| 你需要确保你的位置不会被敌人发现 | 你得藏好，别让敌人发现 | 减少重复主语和生硬被动表达 | 适合躲藏语境；若原文指雷达暴露或坐标泄露，“藏好”可能误导，需要重新措辞 |
| 一个能够让你更快地完成撤离的道具 | 能帮你更快撤离的道具 | 精简冠词式数量表达和层叠修饰 | 原文强调数量“一件”或区分特定道具时，应保留相应信息 |
| 这意味着你将无法再次进入 | 也就是说，你进不去了 | 改成更自然的口头解释 | 相邻字幕需已明确“再次进入”的语境；否则应保留为“也就是说，你没法再进去了”。原文确实强调推论时，也可保留“这意味着” |

### 必须保留的反例

**原文明确纠正误解：** `It’s not a bug. It’s intentional.`

可译为“这不是 bug，是故意这样设计的”。这种对照有原文依据，不能因命中“不是……是……”就删除。应保留纠正误解的功能，而不是机械绕开某几个字。

**原文只表达轻度担心：** `I’m a little worried.`

“我有点担心”保留原有程度；“这下悬了”加强了判断和情绪，不能仅为口语化而采用。

**原文包含有剧情作用的梗：** 当一句角色台词在后文继续被讨论时，不能用无关的中文热梗替换，哪怕替换后更好笑。这个场景是原则示例，不对应已核实的具体视频。

