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
    await access(new URL(`website/${resource}`, root));
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
