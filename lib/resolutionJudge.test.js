const { test } = require("node:test");
const assert = require("node:assert/strict");
const { judgeResolution, QUESTIONS } = require("./resolutionJudge");

test("resolution judge sends a bounded typed resolution task and returns Jev confidence", async () => {
  let request;
  const result = await judgeResolution(
    {
      ticket: { id: 4, program_id: "p", question: "How do I fix this?" },
      transcript: [
        { role: "requester", text: "How do I fix this?" },
        { role: "helper", text: "Change the setting, then restart." },
        { role: "requester", text: "Thanks, that worked." },
      ],
    },
    {
      evaluateDecision: async (input) => {
        request = input;
        return { status: "ok", result: { answers: { resolution: { choice: "resolved", probabilities: { resolved: 0.93 } } } } };
      },
    },
  );
  assert.equal(result.verdict, "resolved");
  assert.equal(result.confidence, 0.93);
  assert.deepEqual(Object.keys(request.questions), ["resolution"]);
  assert.match(request.state.transcript, /\[helper\]/);
  assert.equal(request.questions, QUESTIONS);
});

test("resolution judge fails closed on Jev errors and malformed labels", async () => {
  const error = await judgeResolution({ ticket: { question: "q" }, transcript: [] }, { evaluateDecision: async () => { throw new Error("timeout"); } });
  const malformed = await judgeResolution({ ticket: { question: "q" }, transcript: [] }, { evaluateDecision: async () => ({ status: "ok", result: { answers: { resolution: { choice: "maybe" } } } }) });
  assert.deepEqual(error, { verdict: "unknown" });
  assert.deepEqual(malformed, { verdict: "unknown" });
});
