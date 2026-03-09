const puppeteer = require("puppeteer");

async function getLatestSubmission(userId) {

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox"]
  });

  const page = await browser.newPage();

  await page.goto(`https://www.acmicpc.net/status?user_id=${userId}`, {
    waitUntil: "networkidle2"
  });

  // status table이 로드될 때까지 기다림
  await page.waitForSelector("#status-table tbody tr");

  // 브라우저 안에서 직접 데이터 가져오기
  const result = await page.evaluate(() => {

    const row = document.querySelector("#status-table tbody tr");

    const tds = row.querySelectorAll("td");

    return {
      problemId: tds[2].innerText.trim(),
      result: tds[3].innerText.trim(),
      time: tds[8].innerText.trim()
    };

  });

  await browser.close();

  return result;
}

module.exports = { getLatestSubmission };