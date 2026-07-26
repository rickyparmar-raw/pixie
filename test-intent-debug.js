require("dotenv").config({ path: ".env.test" });
const axios = require("axios");

async function testEndpoint() {
  const apiKey = process.env.INTENT_CLASSIFIER_API_KEY;
  const baseUrl = process.env.INTENT_CLASSIFIER_BASE_URL;
  const model = process.env.INTENT_CLASSIFIER_MODEL;

  console.log("Config:");
  console.log("  API Key:", apiKey ? "✓ set" : "✗ missing");
  console.log("  Base URL:", baseUrl);
  console.log("  Model:", model);
  console.log("\nTesting endpoint...\n");

  try {
    const res = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        max_tokens: 20,
        temperature: 0.3,
        messages: [
          { role: "system", content: "Reply with HELP_NEEDED or CASUAL_CHAT" },
          { role: "user", content: "when does pixl end bro" },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );

    console.log("Success!");
    console.log("Response:", JSON.stringify(res.data, null, 2));
  } catch (e) {
    console.log("Error:", e.message);
    if (e.response) {
      console.log("Status:", e.response.status);
      console.log("Data:", JSON.stringify(e.response.data, null, 2));
    }
    if (e.code) {
      console.log("Code:", e.code);
    }
  }
}

testEndpoint();
