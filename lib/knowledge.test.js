const { test } = require("node:test");
const assert = require("node:assert/strict");
const { textFromJsonFaq, stripHtml, annotateHeadingAnchors } = require("./knowledge");

test("textFromJsonFaq extracts question/answer pairs", () => {
  const data = {
    faq: {
      items: [
        { question: "Who can join?", answer: "Teen hackers and curious friends." },
        { question: "Is this free?", answer: "Yes, 100% free." },
      ],
    },
  };

  const text = textFromJsonFaq(data);
  assert.match(text, /Q: Who can join\?\nA: Teen hackers and curious friends\./);
  assert.match(text, /Q: Is this free\?\nA: Yes, 100% free\./);
});

test("textFromJsonFaq returns empty string when faq.items is missing", () => {
  assert.equal(textFromJsonFaq({}), "");
  assert.equal(textFromJsonFaq({ faq: {} }), "");
});

test("stripHtml removes tags and decodes entities", () => {
  const html = "<div>Hello &amp; <strong>welcome</strong></div><script>evil()</script>";
  const text = stripHtml(html);
  assert.equal(text, "Hello & welcome");
});

test("annotateHeadingAnchors tags anchored sections with a deep link and records it", () => {
  const html = '<section id="react-native"><h1>React Native app guide</h1><p>Use Expo.</p></section>';
  const links = new Map();
  const annotated = annotateHeadingAnchors(html, "https://example.com/docs", links);

  assert.match(annotated, /## React Native app guide \(https:\/\/example\.com\/docs#react-native\)/);
  assert.match(annotated, /Use Expo\./);
  assert.equal(links.get("react native app guide"), "https://example.com/docs#react-native");
});

test("annotateHeadingAnchors leaves a section untouched if it has no heading", () => {
  const html = '<section id="empty"><p>No heading here.</p></section>';
  const links = new Map();
  const annotated = annotateHeadingAnchors(html, "https://example.com/docs", links);

  assert.equal(links.size, 0);
  assert.match(annotated, /No heading here\./);
});

test("annotateHeadingAnchors handles a div wrapper with a nested eyebrow label without picking the label as the heading", () => {
  const html = '<div class="hero doc-page" id="welcome"><div class="eyebrow">Start here</div><h1>Welcome to Pixl</h1><p class="lead">So here\'s the deal.</p></div>';
  const links = new Map();
  const annotated = annotateHeadingAnchors(html, "https://example.com/docs", links);

  assert.match(annotated, /## Welcome to Pixl \(https:\/\/example\.com\/docs#welcome\)/);
  assert.doesNotMatch(annotated, /Start here/);
  assert.equal(links.get("welcome to pixl"), "https://example.com/docs#welcome");
  assert.equal(links.has("start here"), false);
});
