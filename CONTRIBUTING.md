# Contributing

Thanks for helping improve Subtitle Me.

## Before opening a pull request

```bash
npm ci
npm test
npm run validate
```

Keep the runtime dependency-free unless a new dependency solves a measured portability problem. Add tests for subtitle parsing, timing, terminology, or QA behavior changes.

Do not add copyrighted subtitle files, private project data, API keys, downloaded media, or a terminology seed. Test fixtures must be short, original, and neutral.

Compatibility claims require a real installation and smoke test. Record the Agent, operating system, install command, and observed result in the pull request.
