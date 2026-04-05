require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { Pool } = require("pg");
const pdfParse = require("pdf-parse");

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const ALLOWED_CHANNEL_ID = "1479070011778797731";

const MODELS = [
  "qwen/qwen3-235b-a22b:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "nvidia/llama-3.1-nemotron-70b-instruct:free",
  "openrouter/auto",
];

async function callAI(messages) {
  for (const model of MODELS) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages }),
      });
      const data = await res.json();
      if (data.choices && data.choices[0]) {
        console.log(`✅ Success with model: ${model}`);
        return data.choices[0].message.content;
      }
      console.log(`❌ Failed: ${model}`);
    } catch (err) {
      console.log(`❌ Error with ${model}:`, err.message);
    }
  }
  return null;
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      first_seen TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message TEXT NOT NULL,
      remind_at TIMESTAMP NOT NULL,
      done BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS quotes (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      saved_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS polls (
      id SERIAL PRIMARY KEY,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("✅ Database ready!");
}

async function getHistory(userId) {
  const res = await pool.query(
    `SELECT role, content FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );
  return res.rows.reverse();
}

async function saveMessage(userId, username, role, content) {
  await pool.query(
    `INSERT INTO conversations (user_id, username, role, content) VALUES ($1, $2, $3, $4)`,
    [userId, username, role, content]
  );
}

async function getOrCreateProfile(userId, username) {
  const res = await pool.query(`SELECT * FROM user_profiles WHERE user_id = $1`, [userId]);
  if (res.rows.length > 0) return res.rows[0];
  const firstSeen = new Date().toDateString();
  await pool.query(
    `INSERT INTO user_profiles (user_id, username, first_seen) VALUES ($1, $2, $3)`,
    [userId, username, firstSeen]
  );
  return { user_id: userId, username, first_seen: firstSeen };
}

// ── REMINDER SYSTEM ──────────────────────────────────────────
function parseRemindTime(str) {
  const match = str.match(/(\d+)\s*(s|sec|m|min|h|hr|d|day)/i);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1, sec: 1, m: 60, min: 60, h: 3600, hr: 3600, d: 86400, day: 86400 };
  return val * (multipliers[unit] || 60) * 1000;
}

async function checkReminders() {
  try {
    const res = await pool.query(
      `SELECT * FROM reminders WHERE remind_at <= NOW() AND done = FALSE`
    );
    for (const row of res.rows) {
      try {
        const channel = await discord.channels.fetch(row.channel_id);
        await channel.send(`⏰ <@${row.user_id}> Reminder: **${row.message}**`);
        await pool.query(`UPDATE reminders SET done = TRUE WHERE id = $1`, [row.id]);
      } catch (e) {
        console.error("Reminder send error:", e.message);
      }
    }
  } catch (e) {
    console.error("Reminder check error:", e.message);
  }
}

// ── GAMES ─────────────────────────────────────────────────────
const hangmanWords = ["cybersecurity", "discord", "javascript", "python", "hacking", "encryption", "firewall", "noshelter", "algorithm", "database"];
const activeGames = {};

function startHangman(userId) {
  const word = hangmanWords[Math.floor(Math.random() * hangmanWords.length)];
  activeGames[userId] = { word, guessed: [], wrong: 0, maxWrong: 6 };
  return renderHangman(userId);
}

function renderHangman(userId) {
  const game = activeGames[userId];
  if (!game) return null;
  const display = game.word.split("").map(c => game.guessed.includes(c) ? c : "_").join(" ");
  const wrongLetters = game.guessed.filter(c => !game.word.includes(c)).join(", ");
  const hangmanArt = ["", "O", "O\n|", "O\n/|", "O\n/|\\", "O\n/|\\\n/", "O\n/|\\\n/ \\"][game.wrong];
  let status = `\`\`\`\n${hangmanArt}\n\`\`\``;
  status += `\nWord: **${display}**\nWrong (${game.wrong}/${game.maxWrong}): ${wrongLetters || "none"}`;
  if (!display.includes("_")) {
    delete activeGames[userId];
    return status + "\n\n🎉 **You won!**";
  }
  if (game.wrong >= game.maxWrong) {
    const w = game.word;
    delete activeGames[userId];
    return status + `\n\n💀 **Game over!** Word was: **${w}**`;
  }
  return status + "\n\nGuess a letter: `@Zbor AI !guess X`";
}

function guessHangman(userId, letter) {
  const game = activeGames[userId];
  if (!game) return "No active game! Start one with `!hangman`";
  letter = letter.toLowerCase();
  if (game.guessed.includes(letter)) return "Already guessed that letter!";
  game.guessed.push(letter);
  if (!game.word.includes(letter)) game.wrong++;
  return renderHangman(userId);
}

function rollDice(sides = 6) {
  return Math.floor(Math.random() * sides) + 1;
}

function flipCoin() {
  return Math.random() < 0.5 ? "Heads 🪙" : "Tails 🪙";
}

// ── HASH TOOLS ───────────────────────────────────────────────
const crypto = require("crypto");
function hashText(text) {
  return {
    md5: crypto.createHash("md5").update(text).digest("hex"),
    sha1: crypto.createHash("sha1").update(text).digest("hex"),
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
    sha512: crypto.createHash("sha512").update(text).digest("hex"),
  };
}

// ── ANALYSIS TOOLS ───────────────────────────────────────────
function detectMagicBytes(buf) {
  const hex = buf.slice(0, 16).toString("hex").toUpperCase();
  const sigs = {
    "FFD8FF": "JPEG Image", "89504E47": "PNG Image",
    "47494638": "GIF Image", "25504446": "PDF Document",
    "504B0304": "ZIP Archive", "7F454C46": "ELF Binary (Linux executable)",
    "4D5A": "PE/EXE Binary (Windows executable)", "1F8B": "GZIP Archive",
    "52617221": "RAR Archive", "75737461": "TAR Archive",
    "3C3F786D": "XML File", "3C21444F": "HTML File",
    "424D": "BMP Image", "664C6143": "FLAC Audio", "49443303": "MP3 Audio",
  };
  for (const [sig, name] of Object.entries(sigs)) {
    if (hex.startsWith(sig)) return name;
  }
  return "Unknown / Plain text";
}

function extractStrings(buf) {
  const text = buf.toString("latin1");
  const matches = text.match(/[\x20-\x7E]{6,}/g) || [];
  return [...new Set(matches)].slice(0, 100);
}

function tryBase64(str) {
  try {
    if (!/^[A-Za-z0-9+/=]+$/.test(str.trim())) return null;
    const decoded = Buffer.from(str.trim(), "base64").toString("utf8");
    if (/[\x00-\x08\x0E-\x1F]/.test(decoded)) return null;
    return decoded;
  } catch { return null; }
}

function tryHex(str) {
  try {
    const clean = str.replace(/\s/g, "");
    if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) return null;
    const decoded = Buffer.from(clean, "hex").toString("utf8");
    if (/[\x00-\x08\x0E-\x1F]/.test(decoded)) return null;
    return decoded;
  } catch { return null; }
}

function tryBinary(str) {
  try {
    const clean = str.replace(/\s/g, "");
    if (!/^[01]+$/.test(clean) || clean.length % 8 !== 0) return null;
    let result = "";
    for (let i = 0; i < clean.length; i += 8) {
      result += String.fromCharCode(parseInt(clean.slice(i, i + 8), 2));
    }
    if (/[\x00-\x08\x0E-\x1F]/.test(result)) return null;
    return result;
  } catch { return null; }
}

function tryRot13(str) {
  return str.replace(/[a-zA-Z]/g, c => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function tryCaesarBrute(str) {
  const results = [];
  for (let shift = 1; shift <= 25; shift++) {
    const decoded = str.replace(/[a-zA-Z]/g, c => {
      const base = c <= "Z" ? 65 : 97;
      return String.fromCharCode(((c.charCodeAt(0) - base + shift) % 26) + base);
    });
    results.push(`ROT${shift}: ${decoded}`);
  }
  return results;
}

function tryMorse(str) {
  const morseMap = {
    ".-": "A", "-...": "B", "-.-.": "C", "-..": "D", ".": "E",
    "..-.": "F", "--.": "G", "....": "H", "..": "I", ".---": "J",
    "-.-": "K", ".-..": "L", "--": "M", "-.": "N", "---": "O",
    ".--.": "P", "--.-": "Q", ".-.": "R", "...": "S", "-": "T",
    "..-": "U", "...-": "V", ".--": "W", "-..-": "X", "-.--": "Y",
    "--..": "Z", "-----": "0", ".----": "1", "..---": "2",
    "...--": "3", "....-": "4", ".....": "5", "-....": "6",
    "--...": "7", "---..": "8", "----.": "9",
  };
  try {
    if (!/^[.\-\s\/]+$/.test(str)) return null;
    const words = str.trim().split(" / ");
    return words.map(w => w.split(" ").map(c => morseMap[c] || "?").join("")).join(" ");
  } catch { return null; }
}

function tryUrlDecode(str) {
  try {
    const decoded = decodeURIComponent(str);
    if (decoded === str) return null;
    return decoded;
  } catch { return null; }
}

function decodeJWT(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(Buffer.from(parts[0], "base64").toString());
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
    return { header, payload };
  } catch { return null; }
}

function findFlags(text) {
  const patterns = [
    /[A-Za-z0-9_]+\{[^}]+\}/g,
    /flag\{[^}]+\}/gi,
    /ctf\{[^}]+\}/gi,
    /Noshelter\{[^}]+\}/gi,
  ];
  const found = new Set();
  for (const pattern of patterns) {
    const matches = text.match(pattern) || [];
    matches.forEach(m => found.add(m));
  }
  return [...found];
}

function solveMultiLayer(input, depth = 0) {
  if (depth > 6) return null;
  const results = [];
  const b64 = tryBase64(input);
  if (b64) { results.push(`Base64 → ${b64}`); const d = solveMultiLayer(b64, depth + 1); if (d) results.push(`  └─ ${d}`); }
  const hex = tryHex(input);
  if (hex) { results.push(`Hex → ${hex}`); const d = solveMultiLayer(hex, depth + 1); if (d) results.push(`  └─ ${d}`); }
  const bin = tryBinary(input);
  if (bin) { results.push(`Binary → ${bin}`); const d = solveMultiLayer(bin, depth + 1); if (d) results.push(`  └─ ${d}`); }
  const rot = tryRot13(input);
  if (rot !== input) { results.push(`ROT13 → ${rot}`); const d = solveMultiLayer(rot, depth + 1); if (d) results.push(`  └─ ${d}`); }
  const morse = tryMorse(input);
  if (morse) results.push(`Morse → ${morse}`);
  const url = tryUrlDecode(input);
  if (url) results.push(`URL Decode → ${url}`);
  return results.length > 0 ? results.join("\n") : null;
}

async function runAnalysis(buf, filename) {
  let report = `\`\`\`\n🔬 ZBOR AI — CTF ANALYSIS REPORT\n`;
  report += `File: ${filename} | Size: ${buf.length} bytes\n`;
  report += `${"─".repeat(40)}\n\n`;
  const fileType = detectMagicBytes(buf);
  report += `📁 FILE TYPE: ${fileType}\n\n`;
  const rawText = buf.toString("utf8", 0, 8000);
  const flags = findFlags(rawText);
  if (flags.length > 0) { report += `🚩 FLAGS FOUND:\n`; flags.forEach(f => report += `  → ${f}\n`); report += "\n"; }
  const jwtMatch = rawText.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (jwtMatch) {
    const jwt = decodeJWT(jwtMatch[0]);
    if (jwt) { report += `🔑 JWT TOKEN FOUND:\n  Header: ${JSON.stringify(jwt.header)}\n  Payload: ${JSON.stringify(jwt.payload)}\n\n`; }
  }
  const strings = extractStrings(buf);
  report += `📝 INTERESTING STRINGS (${strings.length} found):\n`;
  strings.slice(0, 20).forEach(s => report += `  ${s}\n`);
  report += "\n🔓 MULTI-LAYER DECODE ATTEMPTS:\n";
  let decodedAny = false;
  for (const str of strings.slice(0, 30)) {
    const result = solveMultiLayer(str.trim());
    if (result) { report += `  Input: ${str.slice(0, 60)}\n  ${result}\n\n`; decodedAny = true; }
  }
  if (!decodedAny) report += `  Nothing decoded from strings\n`;
  report += "\n";
  const shortStrings = strings.filter(s => s.length > 4 && s.length < 50 && /^[a-zA-Z\s]+$/.test(s));
  if (shortStrings.length > 0) {
    report += `🔄 CAESAR BRUTE FORCE (on: "${shortStrings[0]}"):\n`;
    tryCaesarBrute(shortStrings[0]).slice(0, 5).forEach(r => report += `  ${r}\n`);
    report += "\n";
  }
  const ips = rawText.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) || [];
  const urls = rawText.match(/https?:\/\/[^\s]+/g) || [];
  const emails = rawText.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
  if (ips.length) report += `🌐 IPs FOUND: ${[...new Set(ips)].join(", ")}\n`;
  if (urls.length) report += `🔗 URLs FOUND: ${[...new Set(urls)].join(", ")}\n`;
  if (emails.length) report += `📧 EMAILS FOUND: ${[...new Set(emails)].join(", ")}\n`;
  report += `\n${"─".repeat(40)}\n✅ Analysis complete!\n\`\`\``;
  return report;
}

function splitIntoChunks(text, maxLength = 2000) {
  const chunks = [];
  while (text.length > 0) {
    if (text.length <= maxLength) { chunks.push(text); break; }
    let splitAt = text.lastIndexOf("\n", maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(text.slice(0, splitAt));
    text = text.slice(splitAt).trimStart();
  }
  return chunks;
}

async function sendChunks(message, text) {
  const chunks = splitIntoChunks(text);
  await message.reply(chunks[0]);
  for (let i = 1; i < chunks.length; i++) await message.channel.send(chunks[i]);
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function readFileContent(url) {
  try {
    const res = await fetch(url);
    return (await res.text()).slice(0, 8000);
  } catch (err) { return null; }
}

async function readPdfContent(url) {
  try {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const data = await pdfParse(Buffer.from(buffer));
    let metadata = "";
    if (data.info) {
      metadata += "[PDF METADATA]\n";
      for (const [key, val] of Object.entries(data.info)) metadata += `${key}: ${val}\n`;
    }
    return (metadata + "\n[PDF TEXT]\n" + data.text).slice(0, 8000);
  } catch (err) { return null; }
}

const TEXT_EXTENSIONS = [
  ".txt", ".md", ".js", ".ts", ".py", ".html", ".css",
  ".json", ".csv", ".xml", ".yaml", ".yml", ".java",
  ".c", ".cpp", ".cs", ".php", ".rb", ".go", ".rs",
  ".sql", ".sh", ".bat", ".env", ".log"
];

const processing = new Set();

discord.on("ready", () => {
  console.log(`✅ Bot is online as Zbor AI`);
  // Check reminders every 30 seconds
  setInterval(checkReminders, 30000);
});

discord.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== ALLOWED_CHANNEL_ID) return;
  if (!message.mentions.has(discord.user)) return;
  if (processing.has(message.id)) return;
  processing.add(message.id);

  const userMessage = message.content.replace(`<@${discord.user.id}>`, "").trim();
  const lower = userMessage.toLowerCase();
  const userId = message.author.id;
  const username = message.author.username;

  const images = message.attachments.filter(a => a.contentType && a.contentType.startsWith("image/"));
  const textFiles = message.attachments.filter(a => {
    if (!a.name) return false;
    const ext = "." + a.name.split(".").pop().toLowerCase();
    return TEXT_EXTENSIONS.includes(ext);
  });
  const pdfFiles = message.attachments.filter(a => a.name && a.name.toLowerCase().endsWith(".pdf"));
  const allFiles = message.attachments;

  if (!userMessage && images.size === 0 && allFiles.size === 0) {
    processing.delete(message.id);
    return;
  }

  try {
    const typingInterval = setInterval(() => message.channel.sendTyping(), 8000);
    await message.channel.sendTyping();

    // ── !analyze ──────────────────────────────────────────────
    if (lower.startsWith("!analyze")) {
      const analyzeInput = userMessage.replace(/^!analyze/i, "").trim();
      let analysisResults = [];
      if (allFiles.size > 0) {
        for (const [, file] of allFiles) {
          try {
            const buf = await fetchBuffer(file.url);
            analysisResults.push(await runAnalysis(buf, file.name));
          } catch (e) {
            analysisResults.push(`❌ Could not analyze ${file.name}: ${e.message}`);
          }
        }
      }
      if (analyzeInput.length > 0) {
        const buf = Buffer.from(analyzeInput, "utf8");
        analysisResults.push(await runAnalysis(buf, "pasted_text.txt"));
      }
      if (analysisResults.length === 0) {
        await message.reply("Attach a file or paste text after `!analyze`!");
        clearInterval(typingInterval);
        processing.delete(message.id);
        return;
      }
      clearInterval(typingInterval);
      for (const result of analysisResults) await sendChunks(message, result);
      processing.delete(message.id);
      return;
    }

    // ── !hash ─────────────────────────────────────────────────
    if (lower.startsWith("!hash")) {
      const text = userMessage.replace(/^!hash/i, "").trim();
      if (!text) { await message.reply("Usage: `!hash your text here`"); clearInterval(typingInterval); processing.delete(message.id); return; }
      const h = hashText(text);
      const reply = `🔐 **Hash results for:** \`${text}\`\n\`\`\`\nMD5:    ${h.md5}\nSHA1:   ${h.sha1}\nSHA256: ${h.sha256}\nSHA512: ${h.sha512}\n\`\`\``;
      clearInterval(typingInterval);
      await sendChunks(message, reply);
      processing.delete(message.id);
      return;
    }

    // ── !roll ─────────────────────────────────────────────────
    if (lower.startsWith("!roll")) {
      const sides = parseInt(userMessage.replace(/^!roll/i, "").trim()) || 6;
      const result = rollDice(sides);
      clearInterval(typingInterval);
      await message.reply(`🎲 Rolled a **d${sides}** — you got **${result}**!`);
      processing.delete(message.id);
      return;
    }

    // ── !flip ─────────────────────────────────────────────────
    if (lower.startsWith("!flip")) {
      clearInterval(typingInterval);
      await message.reply(`🪙 **${flipCoin()}**`);
      processing.delete(message.id);
      return;
    }

    // ── !hangman ──────────────────────────────────────────────
    if (lower.startsWith("!hangman")) {
      clearInterval(typingInterval);
      await sendChunks(message, "🎮 **Hangman started!**\n" + startHangman(userId));
      processing.delete(message.id);
      return;
    }

    // ── !guess ────────────────────────────────────────────────
    if (lower.startsWith("!guess")) {
      const letter = userMessage.replace(/^!guess/i, "").trim().charAt(0);
      clearInterval(typingInterval);
      await sendChunks(message, guessHangman(userId, letter));
      processing.delete(message.id);
      return;
    }

    // ── !remind ───────────────────────────────────────────────
    if (lower.startsWith("!remind")) {
      const parts = userMessage.replace(/^!remind/i, "").trim();
      const timeMatch = parts.match(/^(\d+\s*(?:s|sec|m|min|h|hr|d|day))\s+(.*)/i);
      if (!timeMatch) {
        clearInterval(typingInterval);
        await message.reply("Usage: `!remind 30m your reminder message`");
        processing.delete(message.id);
        return;
      }
      const ms = parseRemindTime(timeMatch[1]);
      const reminderMsg = timeMatch[2];
      const remindAt = new Date(Date.now() + ms);
      await pool.query(
        `INSERT INTO reminders (user_id, channel_id, message, remind_at) VALUES ($1, $2, $3, $4)`,
        [userId, message.channel.id, reminderMsg, remindAt]
      );
      clearInterval(typingInterval);
      await message.reply(`⏰ Got it! I'll remind you about **"${reminderMsg}"** in **${timeMatch[1]}**!`);
      processing.delete(message.id);
      return;
    }

    // ── !quote save ───────────────────────────────────────────
    if (lower.startsWith("!quote save")) {
      const content = userMessage.replace(/^!quote save/i, "").trim();
      if (!content) {
        clearInterval(typingInterval);
        await message.reply("Usage: `!quote save your quote here`");
        processing.delete(message.id);
        return;
      }
      await pool.query(
        `INSERT INTO quotes (guild_id, author, content) VALUES ($1, $2, $3)`,
        [message.guild.id, username, content]
      );
      clearInterval(typingInterval);
      await message.reply(`💬 Quote saved: *"${content}"* — ${username}`);
      processing.delete(message.id);
      return;
    }

    // ── !quote ────────────────────────────────────────────────
    if (lower.startsWith("!quote")) {
      const res = await pool.query(
        `SELECT * FROM quotes WHERE guild_id = $1 ORDER BY RANDOM() LIMIT 1`,
        [message.guild.id]
      );
      clearInterval(typingInterval);
      if (res.rows.length === 0) {
        await message.reply("No quotes saved yet! Use `!quote save your quote`");
      } else {
        const q = res.rows[0];
        await message.reply(`💬 *"${q.content}"* — **${q.author}**`);
      }
      processing.delete(message.id);
      return;
    }

    // ── !poll ─────────────────────────────────────────────────
    if (lower.startsWith("!poll")) {
      const pollText = userMessage.replace(/^!poll/i, "").trim();
      const parts = pollText.match(/"([^"]+)"/g);
      if (!parts || parts.length < 3) {
        clearInterval(typingInterval);
        await message.reply('Usage: `!poll "Question?" "Option1" "Option2" "Option3"`');
        processing.delete(message.id);
        return;
      }
      const question = parts[0].replace(/"/g, "");
      const options = parts.slice(1).map(p => p.replace(/"/g, ""));
      const emojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
      let pollMsg = `📊 **POLL: ${question}**\n\n`;
      options.forEach((opt, i) => pollMsg += `${emojis[i]} ${opt}\n`);
      clearInterval(typingInterval);
      const sent = await message.channel.send(pollMsg);
      for (let i = 0; i < options.length; i++) await sent.react(emojis[i]);
      await message.delete().catch(() => {});
      processing.delete(message.id);
      return;
    }

    // ── !roast ────────────────────────────────────────────────
    if (lower.startsWith("!roast")) {
      const target = userMessage.replace(/^!roast/i, "").trim() || username;
      const roastReply = await callAI([
        {
          role: "user",
          content: `You are Zbor AI, a funny Discord bot. Roast "${target}" in a hilarious but friendly way. Keep it under 3 sentences. Be creative and funny, not mean. No bullet points, just one funny roast.`,
        },
      ]);
      clearInterval(typingInterval);
      await sendChunks(message, `🔥 ${roastReply || "I tried to roast them but they're already burnt 💀"}`);
      processing.delete(message.id);
      return;
    }

    // ── !translate ────────────────────────────────────────────
    if (lower.startsWith("!translate")) {
      const translateText = userMessage.replace(/^!translate/i, "").trim();
      if (!translateText) {
        clearInterval(typingInterval);
        await message.reply("Usage: `!translate [language] your text here`\nExample: `!translate Arabic hello how are you`");
        processing.delete(message.id);
        return;
      }
      const translateReply = await callAI([
        {
          role: "user",
          content: `Translate the following text. If a target language is specified at the start, translate to that language. Otherwise translate to English. Just give the translation, nothing else: "${translateText}"`,
        },
      ]);
      clearInterval(typingInterval);
      await sendChunks(message, `🌍 **Translation:**\n${translateReply}`);
      processing.delete(message.id);
      return;
    }

    // ── !summarize ────────────────────────────────────────────
    if (lower.startsWith("!summarize")) {
      const textToSum = userMessage.replace(/^!summarize/i, "").trim();
      if (!textToSum) {
        clearInterval(typingInterval);
        await message.reply("Paste the text after `!summarize`");
        processing.delete(message.id);
        return;
      }
      const sumReply = await callAI([
        {
          role: "user",
          content: `Summarize this text in 3-5 bullet points, keep it short and clear:\n\n${textToSum}`,
        },
      ]);
      clearInterval(typingInterval);
      await sendChunks(message, `📝 **Summary:**\n${sumReply}`);
      processing.delete(message.id);
      return;
    }

    // ── !announce ─────────────────────────────────────────────
    if (lower.startsWith("!announce")) {
      const announcement = userMessage.replace(/^!announce/i, "").trim();
      if (!announcement) {
        clearInterval(typingInterval);
        await message.reply("Usage: `!announce your message here`");
        processing.delete(message.id);
        return;
      }
      clearInterval(typingInterval);
      await message.channel.send(`📢 @everyone\n\n**${announcement}**\n\n— ${username}`);
      processing.delete(message.id);
      return;
    }

    // ── !stats ────────────────────────────────────────────────
    if (lower.startsWith("!stats")) {
      const profile = await getOrCreateProfile(userId, username);
      const countRes = await pool.query(
        `SELECT COUNT(*) as total FROM conversations WHERE user_id = $1 AND role = 'user'`,
        [userId]
      );
      const total = countRes.rows[0].total;
      clearInterval(typingInterval);
      await message.reply(`📊 **${username}'s Stats**\n\`\`\`\nFirst seen:    ${profile.first_seen}\nMessages sent: ${total}\n\`\`\``);
      processing.delete(message.id);
      return;
    }

    // ── !help ─────────────────────────────────────────────────
    if (lower.startsWith("!help")) {
      clearInterval(typingInterval);
      const helpMsg = `🤖 **Zbor AI — Command List**\`\`\`
🔐 CTF & Security
  !analyze [text/file] — Full forensics analysis
  !hash [text]         — MD5/SHA1/SHA256/SHA512

🎮 Games
  !hangman             — Start a hangman game
  !guess [letter]      — Guess a letter
  !roll [sides]        — Roll a dice (default d6)
  !flip                — Flip a coin

🛠️ Useful Tools
  !remind [time] [msg] — Set a reminder (e.g. 30m)
  !translate [lang] [text] — Translate text
  !summarize [text]    — Summarize long text
  !roast [@user]       — Roast someone 🔥
  !poll "Q?" "A" "B"   — Create a poll
  !quote               — Random saved quote
  !quote save [text]   — Save a quote
  !announce [msg]      — Ping @everyone
  !stats               — Your chat stats
  !help                — This menu
\`\`\`
Just chat normally for anything else! 💬`;
      await sendChunks(message, helpMsg);
      processing.delete(message.id);
      return;
    }

    // ── NORMAL CHAT MODE ──────────────────────────────────────
    const profile = await getOrCreateProfile(userId, username);
    if (userMessage) await saveMessage(userId, username, "user", userMessage);
    const history = await getHistory(userId);

    let fileContext = "";
    for (const [, file] of textFiles) {
      const content = await readFileContent(file.url);
      if (content) fileContext += `\n\n📄 File: ${file.name}\n\`\`\`\n${content}\n\`\`\``;
    }
    for (const [, file] of pdfFiles) {
      const content = await readPdfContent(file.url);
      if (content && content.trim().length > 0) {
        fileContext += `\n\n📄 PDF File: ${file.name}\n\`\`\`\n${content}\n\`\`\``;
      } else {
        fileContext += `\n\n📄 PDF "${file.name}" appears empty.`;
      }
    }

    let userContent;
    if (images.size > 0) {
      userContent = [
        { type: "text", text: (userMessage || "What is in this image?") + fileContext },
        ...images.map(img => ({ type: "image_url", image_url: { url: img.url } }))
      ];
    } else {
      userContent = (userMessage || "Please analyze the attached file.") + fileContext;
    }

    const reply = await callAI([
      {
        role: "user",
        content: `You are Zbor AI — a chill, smart Discord bot and a genuine friend to ${username}. You have known them since ${profile.first_seen}.

Your personality:
- Friendly, funny, and casual — talk like a real person not a robot
- You remember ${username} and care about them genuinely
- Talk about ANYTHING — games, life, random stuff, jokes, advice, whatever
- Never act like you only exist for CTF or cybersecurity
- Have opinions, humor, and personality — don't be boring
- Keep replies natural and conversational — not too long unless needed
- Never use bullet points for casual chat — just talk normally

When ${username} needs CTF or cybersecurity help:
- Switch into elite mode and think step by step
- Try every possible encoding/decoding systematically
- Never guess — reason carefully and show your work
- Only give a flag when 100% certain

Available commands they can use: !analyze, !hash, !roll, !flip, !hangman, !guess, !remind, !translate, !summarize, !roast, !poll, !quote, !announce, !stats, !help`,
      },
      {
        role: "assistant",
        content: `Yo! I'm Zbor AI. Been talking to ${username} since ${profile.first_seen}. What's good?`,
      },
      ...history,
      { role: "user", content: userContent },
    ]);

    clearInterval(typingInterval);

    if (!reply) {
      await message.reply("All AI models are down right now. Try again in a minute!");
      processing.delete(message.id);
      return;
    }

    await saveMessage(userId, username, "assistant", reply);
    await sendChunks(message, reply);

  } catch (err) {
    console.error(err);
    await message.reply("Something went wrong. Try again!");
  } finally {
    processing.delete(message.id);
  }
});

initDB().then(() => discord.login(process.env.DISCORD_TOKEN));