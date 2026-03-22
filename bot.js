require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const axios = require("axios");
const fs = require("fs");
const cron = require("node-cron");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const CHANNEL_ID = process.env.CHANNEL_ID;
const USERS_FILE = "./users.json";

// ── 유틸 ──────────────────────────────────────────────────────────────────────

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
}

function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

function todayKST() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

async function getSolvedCount(handle) {
  const res = await axios.get(
    `https://solved.ac/api/v3/user/show?handle=${encodeURIComponent(handle)}`
  );
  return res.data.solvedCount;
}

function getChannel() {
  return client.channels.cache.get(CHANNEL_ID);
}

// ── 핵심 로직 ─────────────────────────────────────────────────────────────────

/**
 * 5분마다 실행: solved.ac에서 풀이 수를 갱신하고,
 * 오늘 새 문제를 푼 사람에게 인증 메시지를 보냄
 */
async function checkAllUsers() {
  const users = loadUsers();
  let changed = false;

  for (const [discordId, user] of Object.entries(users)) {
    try {
      const currentCount = await getSolvedCount(user.handle);

      // todayBaseCount 미설정 시 초기화
      if (user.todayBaseCount == null) {
        user.todayBaseCount = currentCount;
      }

      if (currentCount > user.todayBaseCount && !user.solvedToday) {
        user.solvedToday = true;
        user.streak += 1;
        user.maxStreak = Math.max(user.maxStreak || 0, user.streak);
        user.lastSolvedDate = todayKST();

        const channel = getChannel();
        if (channel) {
          const embed = new EmbedBuilder()
            .setColor(0x00c851)
            .setTitle("✅ 오늘의 문제 풀이 인증!")
            .setDescription(`<@${discordId}> 오늘 문제를 풀었습니다!`)
            .addFields(
              { name: "🔥 현재 스트릭", value: `${user.streak}일`, inline: true },
              { name: "🏆 최고 스트릭", value: `${user.maxStreak}일`, inline: true }
            )
            .setTimestamp();
          await channel.send({ embeds: [embed] });
        }
        changed = true;
      }

      if (currentCount !== user.solvedCount) {
        user.solvedCount = currentCount;
        changed = true;
      }
    } catch (err) {
      console.error(`[checkAllUsers] ${user.handle}: ${err.message}`);
    }
  }

  if (changed) saveUsers(users);
}

/**
 * 매일 00:00 KST: 어제 미인증자 스트릭 초기화 후 공지
 */
async function midnightReset() {
  const users = loadUsers();
  const praised = [];

  for (const [discordId, user] of Object.entries(users)) {
    if (user.solvedToday) {
      praised.push({ discordId, streak: user.streak });
    } else {
      user.streak = 0;
    }
    // 새 날을 위한 기준값 초기화
    user.todayBaseCount = user.solvedCount;
    user.solvedToday = false;
  }

  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);

  // 월요일이면 주간 기준값 초기화
  if (kst.getDay() === 1) {
    for (const user of Object.values(users)) {
      user.weeklyBaseCount = user.solvedCount;
    }
  }

  saveUsers(users);

  const channel = getChannel();
  if (!channel) return;

  // 매월 1일이면 월간 랭킹 발송 후 기준값 초기화
  if (kst.getDate() === 1) {
    await monthlyRanking();
    const updated = loadUsers();
    for (const user of Object.values(updated)) {
      user.monthlyBaseCount = user.solvedCount;
    }
    saveUsers(updated);
  }

  if (praised.length > 0) {
    const lines = praised.map(
      (u) => `<@${u.discordId}> — 🔥 ${u.streak}일 연속 달성!`
    );
    const embed = new EmbedBuilder()
      .setColor(0x00c851)
      .setTitle("🌙 오늘 하루도 수고했어요!")
      .setDescription(lines.join("\n"))
      .setFooter({ text: "내일도 함께 달려봐요 💪" })
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } else {
    await channel.send("🌙 오늘 하루도 수고했어요! 내일은 함께 달려봐요 💪");
  }
}

/**
 * 매일 21:00 KST: 저녁 격려 메시지
 */
async function eveningEncouragement() {
  const channel = getChannel();
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(0xffa500)
    .setTitle("🌙 오늘 자정까지 3시간 남았어요!")
    .setDescription("아직 시간이 있어요. 문제 하나 함께 풀어볼까요? 💻")
    .setFooter({ text: "1일 1코딩 — 작은 습관이 큰 실력을 만들어요 🚀" })
    .setTimestamp();
  await channel.send({ embeds: [embed] });
}

/**
 * 매일 23:00 KST: 아직 풀지 않은 사람에게 리마인더
 */
async function eveningReminder() {
  const users = loadUsers();
  const channel = getChannel();
  if (!channel) return;

  const done = Object.entries(users)
    .filter(([, u]) => u.solvedToday)
    .map(([id, u]) => `<@${id}> 🔥 ${u.streak}일`);

  if (done.length === 0) {
    await channel.send("⏰ 자정까지 아직 시간이 있어요! 오늘 한 문제 도전해봐요 💪");
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x00c851)
    .setTitle("⏰ 오늘의 인증 현황")
    .setDescription(done.join("\n"))
    .setFooter({ text: "아직 자정까지 시간이 있어요! 화이팅 😊" })
    .setTimestamp();
  await channel.send({ embeds: [embed] });
}

/**
 * 매월 1일 00:00 KST: 월간 스트릭 랭킹 (3위까지)
 */
async function monthlyRanking() {
  const users = loadUsers();
  const channel = getChannel();
  if (!channel) return;

  const entries = Object.entries(users);
  if (entries.length === 0) return;

  const sorted = entries
    .sort(([, a], [, b]) => {
      if (b.streak !== a.streak) return b.streak - a.streak;
      const aMonthly = a.solvedCount - (a.monthlyBaseCount ?? a.solvedCount);
      const bMonthly = b.solvedCount - (b.monthlyBaseCount ?? b.solvedCount);
      return bMonthly - aMonthly;
    })
    .slice(0, 3);

  const medals = ["🥇", "🥈", "🥉"];
  const lines = sorted.map(([id, u], i) => {
    const monthly = u.solvedCount - (u.monthlyBaseCount ?? u.solvedCount);
    return `${medals[i]} <@${id}> — 🔥 ${u.streak}일 | 이번 달 ${monthly}문제`;
  });

  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const month = `${now.getFullYear()}년 ${now.getMonth() + 1}월`;

  const embed = new EmbedBuilder()
    .setColor(0xff6f00)
    .setTitle(`🗓️ ${month} 월간 랭킹 TOP 3`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: "스트릭 동점 시 이번 달 풀이 수로 결정" })
    .setTimestamp();
  await channel.send({ embeds: [embed] });
}

/**
 * 매주 일요일 22:00 KST: 주간 스트릭 랭킹
 */
async function weeklyRanking() {
  const users = loadUsers();
  const channel = getChannel();
  if (!channel) return;

  const entries = Object.entries(users);
  if (entries.length === 0) return;

  const sorted = entries.sort(([, a], [, b]) => {
    if (b.streak !== a.streak) return b.streak - a.streak;
    const aWeekly = a.solvedCount - (a.weeklyBaseCount ?? a.solvedCount);
    const bWeekly = b.solvedCount - (b.weeklyBaseCount ?? b.solvedCount);
    return bWeekly - aWeekly;
  });

  const medals = ["🥇", "🥈", "🥉"];
  const lines = sorted.map(([id, u], i) => {
    const medal = medals[i] ?? `${i + 1}.`;
    const weekly = u.solvedCount - (u.weeklyBaseCount ?? u.solvedCount);
    return `${medal} <@${id}> — 🔥 ${u.streak}일 | 이번 주 ${weekly}문제`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle("🏆 이번 주 스트릭 랭킹")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "스트릭 동점 시 이번 주 풀이 수로 결정" })
    .setTimestamp();
  await channel.send({ embeds: [embed] });
}

// ── 명령어 처리 ───────────────────────────────────────────────────────────────

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  const args = msg.content.trim().split(/\s+/);
  const cmd = args[0];

  // !등록 <백준ID>
  if (cmd === "!등록") {
    const handle = args[1];
    if (!handle) {
      return msg.reply("사용법: `!등록 <백준ID>`\n예: `!등록 swlog`");
    }
    try {
      const solvedCount = await getSolvedCount(handle);
      const users = loadUsers();
      users[msg.author.id] = {
        handle,
        solvedCount,
        todayBaseCount: solvedCount,
        weeklyBaseCount: solvedCount,
        monthlyBaseCount: solvedCount,
        solvedToday: false,
        streak: 0,
        maxStreak: 0,
        lastSolvedDate: null,
      };
      saveUsers(users);
      msg.reply(
        `✅ 등록 완료! 백준 ID: **${handle}** (총 **${solvedCount}**문제 해결)`
      );
    } catch {
      msg.reply("❌ 백준 ID를 찾을 수 없습니다. 아이디를 다시 확인해주세요.");
    }
    return;
  }

  // !현황
  if (cmd === "!현황") {
    const users = loadUsers();
    const entries = Object.entries(users);
    if (entries.length === 0) {
      return msg.reply("등록된 스터디원이 없습니다.");
    }

    const solved = [];
    for (const [id, u] of entries) {
      if (u.solvedToday) {
        solved.push(`<@${id}> — 🔥 ${u.streak}일`);
      }
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📊 오늘의 현황 (${todayKST()})`)
      .addFields({
        name: `✅ 오늘 인증 완료 (${solved.length}명)`,
        value: solved.join("\n") || "아직 아무도 없어요. 첫 번째 주인공이 되어보세요!",
      })
      .setTimestamp();
    return msg.channel.send({ embeds: [embed] });
  }

  // !주간랭킹
  if (cmd === "!주간랭킹") {
    await weeklyRanking();
    return;
  }

  // !월간랭킹
  if (cmd === "!월간랭킹") {
    await monthlyRanking();
    return;
  }

  // !랭킹
  if (cmd === "!랭킹") {
    const users = loadUsers();
    const sorted = Object.entries(users).sort(
      ([, a], [, b]) => b.streak - a.streak || b.maxStreak - a.maxStreak
    );
    if (sorted.length === 0) {
      return msg.reply("등록된 스터디원이 없습니다.");
    }

    const medals = ["🥇", "🥈", "🥉"];
    const lines = sorted.map(([id, u], i) => {
      const medal = medals[i] ?? `${i + 1}.`;
      const check = u.solvedToday ? "✅" : "❌";
      return `${medal} <@${id}> — 🔥 ${u.streak}일 ${check}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0xffd700)
      .setTitle("🏆 스트릭 랭킹")
      .setDescription(lines.join("\n"))
      .setTimestamp();
    return msg.channel.send({ embeds: [embed] });
  }

  // !내정보
  if (cmd === "!내정보") {
    const users = loadUsers();
    const user = users[msg.author.id];
    if (!user) {
      return msg.reply(
        "등록된 정보가 없습니다. `!등록 <백준ID>`로 먼저 등록하세요."
      );
    }

    const embed = new EmbedBuilder()
      .setColor(0x00bfff)
      .setTitle(`👤 ${user.handle}의 정보`)
      .addFields(
        { name: "🔥 현재 스트릭", value: `${user.streak}일`, inline: true },
        {
          name: "🏆 최고 스트릭",
          value: `${user.maxStreak || 0}일`,
          inline: true,
        },
        {
          name: "📝 총 풀이 수",
          value: `${user.solvedCount}문제`,
          inline: true,
        },
        {
          name: "✅ 오늘 풀이",
          value: user.solvedToday ? "완료" : "미완료",
          inline: true,
        },
        {
          name: "📅 마지막 풀이일",
          value: user.lastSolvedDate || "없음",
          inline: true,
        }
      )
      .setTimestamp();
    return msg.channel.send({ embeds: [embed] });
  }

  // !삭제
  if (cmd === "!삭제") {
    const users = loadUsers();
    if (!users[msg.author.id]) {
      return msg.reply("등록된 정보가 없습니다.");
    }
    delete users[msg.author.id];
    saveUsers(users);
    return msg.reply("✅ 등록 정보가 삭제되었습니다.");
  }

  // !도움말
  if (cmd === "!도움말") {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📖 1일 1코딩 봇 도움말")
      .addFields(
        { name: "`!등록 <백준ID>`", value: "백준 아이디를 등록합니다." },
        { name: "`!현황`", value: "오늘의 풀이 현황을 확인합니다." },
        { name: "`!랭킹`", value: "스트릭 랭킹을 확인합니다." },
        { name: "`!주간랭킹`", value: "이번 주 스트릭 랭킹을 확인합니다." },
        { name: "`!월간랭킹`", value: "이번 달 스트릭 랭킹 TOP 3을 확인합니다." },
        { name: "`!내정보`", value: "내 풀이 정보를 확인합니다." },
        { name: "`!삭제`", value: "등록 정보를 삭제합니다." }
      )
      .setFooter({ text: "매일 자정 미인증 시 스트릭이 초기화됩니다." });
    return msg.channel.send({ embeds: [embed] });
  }
});

// ── 봇 시작 ───────────────────────────────────────────────────────────────────

client.once("ready", () => {
  console.log(`✅ 봇 로그인: ${client.user.tag}`);

  // 5분마다 풀이 체크
  cron.schedule("*/5 * * * *", () => {
    checkAllUsers().catch((e) => console.error("[cron] checkAllUsers:", e));
  });

  // 자정 초기화 (KST 00:00 = UTC 15:00)
  cron.schedule("0 15 * * *", () => {
    midnightReset().catch((e) => console.error("[cron] midnightReset:", e));
  });

  // 주간 랭킹 (일요일 KST 22:00 = UTC 13:00)
  cron.schedule("0 13 * * 0", () => {
    weeklyRanking().catch((e) => console.error("[cron] weeklyRanking:", e));
  });

  // 저녁 격려 (KST 21:00 = UTC 12:00)
  cron.schedule("0 12 * * *", () => {
    eveningEncouragement().catch((e) => console.error("[cron] eveningEncouragement:", e));
  });

  // 저녁 리마인더 (KST 23:00 = UTC 14:00)
  cron.schedule("0 14 * * *", () => {
    eveningReminder().catch((e) => console.error("[cron] eveningReminder:", e));
  });
});

client.login(process.env.DISCORD_TOKEN);
