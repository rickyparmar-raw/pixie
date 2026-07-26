require("dotenv").config({ path: ".env.test" });
const axios = require("axios");

async function testRaw(message) {
  const res = await axios.post(
    `${process.env.INTENT_CLASSIFIER_BASE_URL}/chat/completions`,
    {
      model: process.env.INTENT_CLASSIFIER_MODEL,
      max_tokens: 20,
      temperature: 0.3,
      messages: [
        { 
          role: "system", 
          content: `You are a binary intent classifier for a Slack channel about Pixl (a game/program).
Your job: decide if a message needs help/answer or is just casual chat.

Reply with EXACTLY one of these:
- HELP_NEEDED: if it's a question, request for info, or asking for help
- CASUAL_CHAT: if it's a statement, reaction, greeting, or casual comment

Examples:
"when does pixl end bro" → HELP_NEEDED
"yo i love pixl" → CASUAL_CHAT
"how do i join" → HELP_NEEDED
"nice work everyone" → CASUAL_CHAT
"whats the deadline" → HELP_NEEDED
"lol facts" → CASUAL_CHAT`
        },
        { role: "user", content: message },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.INTENT_CLASSIFIER_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    },
  );

  const text = res.data?.choices?.[0]?.message?.content;
  console.log(`Message: "${message}"`);
  console.log(`Raw response: "${text}"`);
  console.log(`Trimmed: "${text?.trim()}"`);
  console.log();
}

(async () => {
  await testRaw("when does pixl end bro");
  await testRaw("yo i love pixl");
  await testRaw("how do i join");
})();
