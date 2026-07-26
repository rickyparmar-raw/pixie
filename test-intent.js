require("dotenv").config({ path: ".env.test" });
const { classifyIntent, HELP_NEEDED, CASUAL_CHAT } = require('./lib/intent');

const tests = [
  // Questions that need help
  "when does pixl end bro",
  "how do i join",
  "whats the deadline",
  "where can i find the docs",
  "what is restoration energy",
  "how does hackatime work",
  "can someone help me with git",
  "why isnt my project showing up",
  "do i need to finish all sidequests",
  "wheres the game url",

  // Casual statements (should NOT respond)
  "yo i love pixl",
  "nice work everyone",
  "lol facts",
  "this is so cool",
  "gg everyone",
  "pixie is the best",
  "just shipped my project",
  "good morning yall",
  "congrats on the launch",
  "niceee"
];

async function runTests() {
  console.log("Testing intent classifier...\n");
  for (const msg of tests) {
    const result = await classifyIntent(msg);
    console.log(`"${msg}"`);
    console.log(`  → ${result}\n`);
  }
}

runTests().catch(console.error);
