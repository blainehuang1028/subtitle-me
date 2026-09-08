# subtitle-me website

Static product website. No build step, tracking, upload endpoint, or translation backend. The glossary example is sourced from `examples/demo`; the numeric correction is labeled as an illustration.

Preview from the repository root:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory website
```

Open `http://127.0.0.1:4173`. To host the site, publish `index.html`, `style.css`, `app.js`, and `assets/` together. All runtime resources are relative, so the same files work at a domain root or a subpath. Do not upload development notes or QA evidence.

Verification: `npm test` checks installation-copy consistency, example terminology, local resource references and both clipboard outcomes. Visual acceptance includes desktop and narrow mobile views, anchor navigation, keyboard focus, command copying and no horizontal overflow. The site intentionally has no timeline, player, online-editor controls or upload area.

Keep the public install command on `skills@latest`. The development dependency in the root lockfile remains pinned for reproducible CI and is not a public installation instruction.
