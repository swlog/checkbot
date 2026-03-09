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
  const missed = [];

  for (const [discordId, user] of Object.entries(users)) {
    if (!user.solvedToday && user.streak > 0) {
      missed.push({ discordId, prevStreak: user.streak });
    }
    if (!user.solvedToday) {
      user.streak = 0;
    }
    // 새 날을 위한 기준값 초기화
    user.todayBaseCount = user.solvedCount;
    user.solvedToday = false;
  }

  saveUsers(users);

  const channel = getChannel();
  if (!channel) return;

  if (missed.length > 0) {
    const lines = missed.map(
      (u) => `<@${u.discordId}> — 🔥 ${u.prevStreak}일 → 0일`
    );
    const embed = new EmbedBuilder()
      .setColor(0xff4444)
      .setTitle("😢 어제 미인증 목록 — 스트릭 초기화")
      .setDescription(lines.join("\n"))
      .setFooter({ text: "오늘도 화이팅! 새로운 스트릭을 시작하세요." })
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } else {
    await channel.send("🎉 어제 모든 스터디원이 인증 완료! 오늘도 화이팅!");
  }
}

/**
 * 매일 23:00 KST: 아직 풀지 않은 사람에게 리마인더
 */
async function eveningReminder() {
  const users = loadUsers();
  const channel = getChannel();
  if (!channel) return;

  const notYet = Object.entries(users)
    .filter(([, u]) => !u.solvedToday)
    .map(([id]) => `<@${id}>`);

  if (notYet.length === 0) {
    await channel.send("🎉 오늘 모든 스터디원이 문제를 풀었습니다! 최고!");
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xffaa00)
    .setTitle("⏰ 아직 오늘 문제를 안 푸셨나요?")
    .setDescription(notYet.join(" "))
    .setFooter({ text: "자정까지 1문제 이상 풀면 스트릭이 유지됩니다!" })
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
    const notSolved = [];
    for (const [id, u] of entries) {
      const line = `<@${id}> — 🔥 ${u.streak}일`;
      (u.solvedToday ? solved : notSolved).push(line);
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📊 오늘의 현황 (${todayKST()})`)
      .addFields(
        {
          name: `✅ 완료 (${solved.length}명)`,
          value: solved.join("\n") || "없음",
        },
        {
          name: `❌ 미완료 (${notSolved.length}명)`,
          value: notSolved.join("\n") || "없음",
        }
      )
      .setTimestamp();
    return msg.channel.send({ embeds: [embed] });
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

  // 저녁 리마인더 (KST 23:00 = UTC 14:00)
  cron.schedule("0 14 * * *", () => {
    eveningReminder().catch((e) => console.error("[cron] eveningReminder:", e));
  });
});

client.login(process.env.DISCORD_TOKEN);
