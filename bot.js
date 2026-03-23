require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const axios = require("axios");
const cron = require("node-cron");
const mongoose = require("mongoose");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const CHANNEL_ID = process.env.CHANNEL_ID;

// ── MongoDB 스키마 ─────────────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  discordId: { type: String, required: true, unique: true },
  handle: String,
  solvedCount: { type: Number, default: 0 },
  todayBaseCount: { type: Number, default: 0 },
  weeklyBaseCount: { type: Number, default: 0 },
  monthlyBaseCount: { type: Number, default: 0 },
  solvedToday: { type: Boolean, default: false },
  streak: { type: Number, default: 0 },
  maxStreak: { type: Number, default: 0 },
  lastSolvedDate: { type: String, default: null },
});

const User = mongoose.model("User", userSchema);

// ── 유틸 ──────────────────────────────────────────────────────────────────────

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

async function checkUser(user) {
  const currentCount = await getSolvedCount(user.handle);

  if (user.todayBaseCount == null) user.todayBaseCount = currentCount;
  if (user.weeklyBaseCount == null) user.weeklyBaseCount = currentCount;
  if (user.monthlyBaseCount == null) user.monthlyBaseCount = currentCount;

  // 이전 체크 이후 새 문제를 풀었을 때만 알림
  if (currentCount > user.solvedCount) {
    const todaySolved = currentCount - user.todayBaseCount;

    // 오늘 첫 풀이면 스트릭 증가
    if (!user.solvedToday) {
      user.solvedToday = true;
      user.streak += 1;
      user.maxStreak = Math.max(user.maxStreak || 0, user.streak);
      user.lastSolvedDate = todayKST();
    }

    user.solvedCount = currentCount;
    await user.save();

    const channel = getChannel();
    if (channel) {
      const embed = new EmbedBuilder()
        .setColor(0x00c851)
        .setTitle("✅ 문제 풀이 인증!")
        .setDescription(`<@${user.discordId}> 문제를 풀었습니다! 🎉`)
        .addFields(
          { name: "🔥 스트릭", value: `${user.streak}일`, inline: true },
          { name: "📅 오늘 푼 문제", value: `${todaySolved}문제`, inline: true }
        )
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }
  }
}

async function checkAllUsers() {
  const users = await User.find();
  for (const user of users) {
    try {
      await checkUser(user);
    } catch (err) {
      console.error(`[checkAllUsers] ${user.handle}: ${err.message}`);
    }
  }
}

async function midnightReset() {
  const users = await User.find();
  const praised = [];

  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);

  for (const user of users) {
    if (user.solvedToday) {
      praised.push({ discordId: user.discordId, streak: user.streak });
    } else {
      user.streak = 0;
    }
    user.todayBaseCount = user.solvedCount;
    user.solvedToday = false;

    // 월요일이면 주간 기준값 초기화
    if (kst.getDay() === 1) {
      user.weeklyBaseCount = user.solvedCount;
    }

    await user.save();
  }

  const channel = getChannel();
  if (!channel) return;

  // 매월 1일이면 월간 랭킹 발송 후 기준값 초기화
  if (kst.getDate() === 1) {
    await monthlyRanking();
    for (const user of users) {
      user.monthlyBaseCount = user.solvedCount;
      await user.save();
    }
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

async function eveningReminder() {
  const users = await User.find();
  const channel = getChannel();
  if (!channel) return;

  const done = users
    .filter((u) => u.solvedToday)
    .map((u) => `<@${u.discordId}> 🔥 ${u.streak}일`);

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

async function monthlyRanking() {
  const users = await User.find();
  const channel = getChannel();
  if (!channel) return;
  if (users.length === 0) return;

  const sorted = [...users]
    .sort((a, b) => {
      if (b.streak !== a.streak) return b.streak - a.streak;
      const aMonthly = a.solvedCount - (a.monthlyBaseCount ?? a.solvedCount);
      const bMonthly = b.solvedCount - (b.monthlyBaseCount ?? b.solvedCount);
      return bMonthly - aMonthly;
    })
    .slice(0, 3);

  const medals = ["🥇", "🥈", "🥉"];
  const lines = sorted.map((u, i) => {
    const monthly = u.solvedCount - (u.monthlyBaseCount ?? u.solvedCount);
    return `${medals[i]} <@${u.discordId}> — 🔥 ${u.streak}일 | 이번 달 ${monthly}문제`;
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

async function weeklyRanking() {
  const users = await User.find();
  const channel = getChannel();
  if (!channel) return;
  if (users.length === 0) return;

  const sorted = [...users].sort((a, b) => {
    if (b.streak !== a.streak) return b.streak - a.streak;
    const aWeekly = a.solvedCount - (a.weeklyBaseCount ?? a.solvedCount);
    const bWeekly = b.solvedCount - (b.weeklyBaseCount ?? b.solvedCount);
    return bWeekly - aWeekly;
  });

  const medals = ["🥇", "🥈", "🥉"];
  const lines = sorted.map((u, i) => {
    const medal = medals[i] ?? `${i + 1}.`;
    const weekly = u.solvedCount - (u.weeklyBaseCount ?? u.solvedCount);
    return `${medal} <@${u.discordId}> — 🔥 ${u.streak}일 | 이번 주 ${weekly}문제`;
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
      await User.findOneAndUpdate(
        { discordId: msg.author.id },
        {
          discordId: msg.author.id,
          handle,
          solvedCount,
          todayBaseCount: solvedCount,
          weeklyBaseCount: solvedCount,
          monthlyBaseCount: solvedCount,
          solvedToday: false,
          streak: 0,
          maxStreak: 0,
          lastSolvedDate: null,
        },
        { upsert: true, new: true }
      );
      msg.reply(`✅ 등록 완료! 백준 ID: **${handle}** (총 **${solvedCount}**문제 해결)`);
    } catch {
      msg.reply("❌ 백준 ID를 찾을 수 없습니다. 아이디를 다시 확인해주세요.");
    }
    return;
  }

  // !현황
  if (cmd === "!현황") {
    const users = await User.find();
    if (users.length === 0) return msg.reply("등록된 스터디원이 없습니다.");

    const solved = users
      .filter((u) => u.solvedToday)
      .map((u) => `<@${u.discordId}> — 🔥 ${u.streak}일`);

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
    const users = await User.find();
    if (users.length === 0) return msg.reply("등록된 스터디원이 없습니다.");

    const sorted = [...users].sort(
      (a, b) => b.streak - a.streak || b.maxStreak - a.maxStreak
    );

    const medals = ["🥇", "🥈", "🥉"];
    const lines = sorted.map((u, i) => {
      const medal = medals[i] ?? `${i + 1}.`;
      const check = u.solvedToday ? "✅" : "❌";
      return `${medal} <@${u.discordId}> — 🔥 ${u.streak}일 ${check}`;
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
    const user = await User.findOne({ discordId: msg.author.id });
    if (!user) {
      return msg.reply("등록된 정보가 없습니다. `!등록 <백준ID>`로 먼저 등록하세요.");
    }

    const embed = new EmbedBuilder()
      .setColor(0x00bfff)
      .setTitle(`👤 ${user.handle}의 정보`)
      .addFields(
        { name: "🔥 현재 스트릭", value: `${user.streak}일`, inline: true },
        { name: "🏆 최고 스트릭", value: `${user.maxStreak || 0}일`, inline: true },
        { name: "📝 총 풀이 수", value: `${user.solvedCount}문제`, inline: true },
        { name: "✅ 오늘 풀이", value: user.solvedToday ? "완료" : "미완료", inline: true },
        { name: "📅 마지막 풀이일", value: user.lastSolvedDate || "없음", inline: true }
      )
      .setTimestamp();
    return msg.channel.send({ embeds: [embed] });
  }

  // !삭제
  if (cmd === "!삭제") {
    const result = await User.findOneAndDelete({ discordId: msg.author.id });
    if (!result) return msg.reply("등록된 정보가 없습니다.");
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

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("✅ MongoDB 연결 성공");

  await client.login(process.env.DISCORD_TOKEN);
}

client.once("ready", () => {
  console.log(`✅ 봇 로그인: ${client.user.tag}`);

  cron.schedule("* * * * *", () => {
    checkAllUsers().catch((e) => console.error("[cron] checkAllUsers:", e));
  });

  cron.schedule("0 15 * * *", () => {
    midnightReset().catch((e) => console.error("[cron] midnightReset:", e));
  });

  cron.schedule("0 13 * * 0", () => {
    weeklyRanking().catch((e) => console.error("[cron] weeklyRanking:", e));
  });

  cron.schedule("0 12 * * *", () => {
    eveningEncouragement().catch((e) => console.error("[cron] eveningEncouragement:", e));
  });

  cron.schedule("0 14 * * *", () => {
    eveningReminder().catch((e) => console.error("[cron] eveningReminder:", e));
  });
});

main().catch((e) => {
  console.error("시작 실패:", e);
  process.exit(1);
});
