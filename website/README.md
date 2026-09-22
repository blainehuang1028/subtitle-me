# subtitle-me website

Static product website. No build step, tracking, upload endpoint, or translation backend. The glossary example is sourced from `examples/demo`; the numeric correction is labeled as an illustration. Version 0.2.0 adds a feature block, a real historical translation with a newly edited alternative, explicitly illustrative examples, and an in-page changelog. Source and comparison limitations are documented in `docs/translation-examples.zh-CN.md`.

Production URL: https://skills.heyblaine.com/subtitle-me/

Preview from the repository root:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory website
```

Open `http://127.0.0.1:4173`. To host the site, publish `index.html`, `style.css`, `app.js`, and `assets/` together. All runtime resources are relative, so the same files work at a domain root or a subpath. Do not upload development notes or QA evidence.

Verification: `npm test` checks installation-copy consistency, example terminology, local resource references and both clipboard outcomes. Visual acceptance includes desktop and narrow mobile views, anchor navigation, keyboard focus, command copying and no horizontal overflow. The site intentionally has no timeline, player, online-editor controls or upload area.

Keep the public install command on `skills@latest`. The development dependency in the root lockfile remains pinned for reproducible CI and is not a public installation instruction.

## Production deployment

The existing Caddy host serves multiple sites. Publish only `index.html`, `style.css`, `app.js`, `assets/`, and `sitemap.xml` to a new directory below `/srv/skills/subtitle-me/releases/`, then atomically switch `/srv/skills/subtitle-me/current` to that release. Retain the previous target for rollback. Never publish this README, design notes, tests or the `deploy/` directory as website content.

Merge `deploy/subtitle-me.caddy` into the existing domain block, preserving sibling routes. Back up the live Caddy configuration, validate the complete candidate with `caddy validate`, and reload Caddy only after validation passes. Check for concurrent configuration changes before replacing the live file. If validation or live checks fail, restore the backup and previous release target.

`deploy/robots.txt` and `deploy/sitemap.xml` are domain-root resources served from `/srv/skills/shared`. They were added when those URLs had no existing resources. On later deployments, merge existing shared sitemap entries rather than overwriting them. The product sitemap lists only its canonical page; do not list assets, fragments, redirects or missing pages.

Keep the canonical, Open Graph URL, JSON-LD and sitemap aligned with the trailing-slash production URL. Copy the repository's `docs/images/social-preview.png` to `assets/social-preview.png` whenever the image changes. Live checks must cover HTTPS, slash and index redirects, assets, robots, both sitemaps, a real 404, and the existing sibling site. Search Console submission and actual indexing are separate from deployment; never claim either without evidence.
