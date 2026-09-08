import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const install = "npx skills@latest add blainehuang1028/subtitle-me";

test("website and documentation agree on the public install command", async () => {
  for (const path of [
    "website/index.html",
    "README.md",
    "docs/images/quick-start.svg",
    "docs/images/social-preview.svg",
  ]) {
    const text = await read(path);
    assert.ok(text.includes(install), path);
    assert.doesNotMatch(text, /npx skills@\d/, path);
  }
});

test("website local resources and glossary examples exist", async () => {
  const html = await read("website/index.html");
  for (const [, resource] of html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)) {
    await access(new URL(`website/${resource.split("?")[0]}`, root));
  }
  const terms = JSON.parse(
    await read("examples/demo/term-decisions.json"),
  ).terms;
  for (const term of terms) {
    assert.ok(html.includes(term.en));
    assert.ok(html.includes(term.zhHans));
  }
  assert.doesNotMatch(html, /<input|<video|<form|type="file"/);
  assert.ok(html.includes("本站不提供在线翻译"));
  assert.ok(html.includes("新项目从空白术语库开始"));
});

test("production SEO uses one canonical URL and valid source-backed structured data", async () => {
  const html = await read("website/index.html");
  const canonical = "https://skills.heyblaine.com/subtitle-me/";
  assert.ok(html.includes(`<link rel="canonical" href="${canonical}"`));
  assert.ok(html.includes(`<meta property="og:url" content="${canonical}"`));
  assert.match(html, /<title>[^<]*字幕翻译 Skill[^<]*<\/title>/);
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
  assert.doesNotMatch(html, /noindex|localhost|127\.0\.0\.1/);
  const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(schema["@graph"].length, 2);
  for (const entity of schema["@graph"]) assert.equal(entity.url, canonical);
  assert.equal(schema["@graph"][1].codeRepository, "https://github.com/blainehuang1028/subtitle-me");
  assert.doesNotMatch(JSON.stringify(schema), /aggregateRating|reviewCount/);
  const sitemap = await read("website/sitemap.xml");
  assert.deepEqual([...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]), [canonical]);
  assert.match(await read("website/deploy/robots.txt"), /Sitemap: https:\/\/skills\.heyblaine\.com\/sitemap\.xml/);
  assert.ok((await read("website/deploy/sitemap.xml")).includes(`${canonical}sitemap.xml`));
  const image = await readFile(new URL("website/assets/social-preview.png", root));
  assert.deepEqual(image, await readFile(new URL("docs/images/social-preview.png", root)));
  assert.equal(image.subarray(1, 4).toString(), "PNG");
  assert.equal(image.readUInt32BE(16), 1280);
  assert.equal(image.readUInt32BE(20), 640);
});

test("product story retains personal source links and a navigable section", async () => {
  const html = await read("website/index.html");
  assert.ok(html.includes('href="#story"'));
  assert.ok(html.includes('id="story"'));
  for (const source of ["https://heyblaine.com/projects/subtitle-me", "https://heyblaine.com/about"]) {
    assert.ok(html.includes(`href="${source}"`));
  }
  assert.match(html, /涉外商务笔译/);
  assert.match(html, /memoQ/);
  assert.match(html, /Marathon/);
  assert.doesNotMatch(html, /class="leader"/);
});

async function clipboardFixture(clipboard) {
  let handler;
  let selected = false;
  const command = { textContent: install };
  const status = { textContent: "" };
  const selection = {
    removeAllRanges() {},
    addRange() {
      selected = true;
    },
  };
  const source = await read("website/app.js");
  vm.runInNewContext(source, {
    navigator: { clipboard },
    document: {
      querySelector(selector) {
        if (selector === "#command") return command;
        if (selector === "#copy-status") return status;
        if (selector === "#copy")
          return {
            addEventListener(event, listener) {
              assert.equal(event, "click");
              handler = listener;
            },
          };
        throw new Error(`Unexpected selector: ${selector}`);
      },
      createRange() {
        return {
          selectNodeContents(node) {
            assert.equal(node, command);
          },
        };
      },
    },
    window: {
      getSelection() {
        return selection;
      },
    },
  });
  assert.equal(typeof handler, "function");
  await handler();
  return { text: status.textContent, selected };
}

test("copy writes the exact installation command and reports success", async () => {
  let copied;
  const result = await clipboardFixture({
    async writeText(text) {
      copied = text;
    },
  });
  assert.equal(copied, install);
  assert.match(result.text, /已复制/);
  assert.equal(result.selected, false);
});

test("denied or unavailable clipboard leaves a manual selection and clear status", async () => {
  for (const clipboard of [
    undefined,
    {
      async writeText() {
        throw new Error("denied");
      },
    },
  ]) {
    const result = await clipboardFixture(clipboard);
    assert.match(result.text, /手动复制/);
    assert.equal(result.selected, true);
  }
});
