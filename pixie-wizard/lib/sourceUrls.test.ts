import { test, expect } from "bun:test";
import { sourceUrlProblem } from "./sourceUrls";

test("private infrastructure URLs are rejected with a helpful message", () => {
  expect(sourceUrlProblem("http://localhost:3000/x")).toMatch(/private/);
  expect(sourceUrlProblem("http://127.0.0.1/")).toMatch(/private/);
  expect(sourceUrlProblem("http://169.254.169.254/latest/meta-data")).toMatch(/private/);
  expect(sourceUrlProblem("http://192.168.0.5/docs")).toMatch(/private/);
  expect(sourceUrlProblem("file:///etc/passwd")).toMatch(/http\(s\)/);
  expect(sourceUrlProblem("not a url")).toMatch(/valid/);
});

test("public https URLs pass screening", () => {
  expect(sourceUrlProblem("https://example.com/docs")).toBeNull();
  expect(sourceUrlProblem("http://docs.example.org/guide")).toBeNull();
});
