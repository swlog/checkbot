const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

function extractProblemNumber(message) {

  const match = message.match(/\b\d{3,5}\b/);

  if (match) {
    return match[0];
  }

  return null;
}

app.post("/github", async (req, res) => {

  const commits = req.body.commits;

  if (!commits) {
    return res.sendStatus(200);
  }

  for (const commit of commits) {

    const msg = commit.message;

    console.log("새 커밋:", msg);

    const problem = extractProblemNumber(msg);

    if (problem) {

      const discordMessage =
`✅ 백준 문제 제출

문제 번호: BOJ ${problem}
커밋 메시지: ${msg}`;

      await axios.post(WEBHOOK, {
        content: discordMessage
      });

    }

  }

  res.sendStatus(200);
});

app.listen(3000, () => {
  console.log("Webhook server running on port 3000");
});