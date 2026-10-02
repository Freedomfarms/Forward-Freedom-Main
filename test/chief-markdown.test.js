// CHIEF markdown rendering. The transcript used to insert the model string as
// text, so escaped emphasis such as \*\*Search\*\* stayed on screen.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseChiefMarkdown, unescapeChiefMarkdown } from "../src/utils/chiefMarkdown.js";

function strongText(blocks) {
  const values = [];
  for (const block of blocks) {
    const nodes = block.inlines || block.items?.flat() || [];
    for (const node of nodes) {
      if (node?.type === "strong") values.push(node.value);
    }
  }
  return values;
}

test("escaped emphasis becomes bold and literal asterisks do not remain", () => {
  const blocks = parseChiefMarkdown("\\*\\*Search\\*\\*");
  assert.deepEqual(strongText(blocks), ["Search"]);
  assert.equal(JSON.stringify(blocks).includes("\\*"), false);
  assert.equal(unescapeChiefMarkdown("\\*\\*Search\\*\\*"), "**Search**");
});

test("common markdown renders and unsafe links stay text", () => {
  const blocks = parseChiefMarkdown(
    [
      "# Heading",
      "",
      "A *note* and **bold**.",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
      "See [Search](https://example.com/search) and [bad](javascript:alert(1)).",
      "",
      "| Name | State |",
      "| --- | --- |",
      "| Web | on |",
      "",
      "`inline`",
    ].join("\n")
  );
  assert.equal(blocks[0].type, "heading");
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[0].inlines[0].value, "Heading");
  assert.ok(
    blocks.some(
      (block) =>
        block.type === "paragraph" &&
        block.inlines.some((node) => node.type === "em" && node.value === "note")
    )
  );
  assert.ok(strongText(blocks).includes("bold"));
  const lists = blocks.filter((block) => block.type === "list");
  assert.equal(lists[0].ordered, false);
  assert.equal(lists[0].items.length, 2);
  assert.equal(lists[1].ordered, true);
  const link = blocks.flatMap((block) => block.inlines || []).find((node) => node.type === "link");
  assert.equal(link.href, "https://example.com/search");
  assert.equal(link.value, "Search");
  assert.equal(
    blocks.some((block) =>
      (block.inlines || []).some(
        (node) => node.type === "link" && String(node.href).startsWith("javascript:")
      )
    ),
    false
  );
  const table = blocks.find((block) => block.type === "table");
  assert.equal(table.header[0][0].value, "Name");
  assert.equal(table.rows[0][1][0].value, "on");
  assert.ok(
    blocks.some((block) =>
      block.inlines?.some((node) => node.type === "code" && node.value === "inline")
    )
  );
});

test("code blocks stay intact, including escaped asterisks", () => {
  const blocks = parseChiefMarkdown('```js\nconst label = "\\\\*\\\\*";\n```');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "code");
  assert.equal(blocks[0].language, "js");
  assert.equal(blocks[0].value, 'const label = "\\\\*\\\\*";');
});

test("a partial stream does not invent a closed emphasis", () => {
  const blocks = parseChiefMarkdown("**Sea");
  assert.equal(strongText(blocks).length, 0);
  assert.match(blocks[0].inlines[0].value, /\*\*Sea/);
});

test("the transcript renders assistant markdown for the live answer and history", () => {
  const source = readFileSync("src/components/chief/ChiefTranscript.jsx", "utf8");
  assert.match(source, /ChiefMarkdown text=\{answer\}/);
  assert.match(source, /ChiefMarkdown text=\{message\.text\}/);
  assert.match(source, /parseChiefMarkdown/);
});
