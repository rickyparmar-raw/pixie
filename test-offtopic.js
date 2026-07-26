require("dotenv").config({ path: ".env.test" });
const { classifyIntent, HELP_NEEDED, CASUAL_CHAT } = require('./lib/intent');

const tests = [
  // Off-topic questions (should be CASUAL_CHAT)
  "how do i join the mafia",
  "whats for lunch",
  "how do i join discord",
  "what time is it",
  "whos the president",
  
  // On-topic questions (should be HELP_NEEDED)
  "when does pixl end",
  "how do i join pixl",
  "what is restoration energy",
  "how does git work",
  "help with my project"
];

async function runTests() {
  console.log("Testing on-topic vs off-topic classification...\n");
  for (const msg of tests) {
    const result = await classifyIntent(msg);
    console.log(`"${msg}"`);
    console.log(`  → ${result}\n`);
  }
}

runTests().catch(console.error);
