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
  const res = await pool.query(
    `SELECT * FROM user_profiles WHERE user_id = $1`,
    [userId]
  );
  if (res.rows.length > 0) return res.rows[0];
  const firstSeen = new Date().toDateString();
  await pool.query(
    `INSERT INTO user_profiles (user_id, username, first_seen) VALUES ($1, $2, $3)`,
    [userId, username, firstSeen]
  );
  return { user_id: userId, username, first_seen: firstSeen };
}

// ── ANALYSIS TOOLS ──────────────────────────────────────────

function detectMagicBytes(buf) {
  const hex = buf.slice(0, 16).toString("hex").toUpperCase();
  const sigs = {
    "FFD8FF": "JPEG Image",
    "89504E47": "PNG Image",
    "47494638": "GIF Image",
    "25504446": "PDF Document",
    "504B0304": "ZIP Archive",
    "7F454C46": "ELF Binary (Linux executable)",
    "4D5A": "PE/EXE Binary (Windows executable)",
    "1F8B": "GZIP Archive",
    "52617221": "RAR Archive",
    "75737461": "TAR Archive",
    "3C3F786D": "XML File",
    "3C21444F": "HTML File",
    "424D": "BMP Image",
    "OGG": "OGG Audio",
    "664C6143": "FLAC Audio",
    "49443303": "MP3 Audio",
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
    return words.map(w =>
      w.split(" ").map(c => morseMap[c] || "?").join("")
    ).join(" ");
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
  if (depth > 5) return null;
  const results = [];

  const b64 = tryBase64(input);
  if (b64) {
    results.push(`Base64 → ${b64}`);
    const deeper = solveMultiLayer(b64, depth + 1);
    if (deeper) results.push(`  └─ ${deeper}`);
  }

  const hex = tryHex(input);
  if (hex) {
    results.push(`Hex → ${hex}`);
    const deeper = solveMultiLayer(hex, depth + 1);
    if (deeper) results.push(`  └─ ${deeper}`);
  }

  const bin = tryBinary(input);
  if (bin) {
    results.push(`Binary → ${bin}`);
    const deeper = solveMultiLayer(bin, depth + 1);
    if (deeper) results.push(`  └─ ${deeper}`);
  }

  const rot = tryRot13(input);
  if (rot !== input) {
    results.push(`ROT13 → ${rot}`);
    const deeper = solveMultiLayer(rot, depth + 1);
    if (deeper) results.push(`  └─ ${deeper}`);
  }

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

  // Magic bytes
  const fileType = detectMagicBytes(buf);
  report += `📁 FILE TYPE: ${fileType}\n\n`;

  // Convert to string for text analysis
  const rawText = buf.toString("utf8", 0, 8000);

  // Flag finder
  const flags = findFlags(rawText);
  if (flags.length > 0) {
    report += `🚩 FLAGS FOUND:\n`;
    flags.forEach(f => report += `  → ${f}\n`);
    report += "\n";
  }

  // JWT detection
  const jwtMatch = rawText.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (jwtMatch) {
    const jwt = decodeJWT(jwtMatch[0]);
    if (jwt) {
      report += `🔑 JWT TOKEN FOUND:\n`;
      report += `  Header: ${JSON.stringify(jwt.header)}\n`;
      report += `  Payload: ${JSON.stringify(jwt.payload)}\n\n`;
    }
  }

  // Extract strings
  const strings = extractStrings(buf);
  report += `📝 INTERESTING STRINGS (${strings.length} found):\n`;
  strings.slice(0, 20).forEach(s => report += `  ${s}\n`);
  report += "\n";

  // Multi-layer decode on each interesting string
  report += `🔓 MULTI-LAYER DECODE ATTEMPTS:\n`;
  let decodedAny = false;
  for (const str of strings.slice(0, 30)) {
    const result = solveMultiLayer(str.trim());
    if (result) {
      report += `  Input: ${str.slice(0, 60)}\n`;
      report += `  ${result}\n\n`;
      decodedAny = true;
    }
  }
  if (!decodedAny) report += `  Nothing decoded from strings\n`;
  report += "\n";

  // Caesar brute on short strings
  const shortStrings = strings.filter(s => s.length > 4 && s.length < 50 && /^[a-zA-Z\s]+$/.test(s));
  if (shortStrings.length > 0) {
    report += `🔄 CAESAR BRUTE FORCE (on: "${shortStrings[0]}"):\n`;
    tryCaesarBrute(shortStrings[0]).slice(0, 5).forEach(r => report += `  ${r}\n`);
    report += "\n";
  }

  // IP/URL/Email extractor
  const ips = rawText.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) || [];
  const urls = rawText.match(/https?:\/\/[^\s]+/g) || [];
  const emails = rawText.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];

  if (ips.length) report += `🌐 IPs FOUND: ${[...new Set(ips)].join(", ")}\n`;
  if (urls.length) report += `🔗 URLs FOUND: ${[...new Set(urls)].join(", ")}\n`;
  if (emails.length) report += `📧 EMAILS FOUND: ${[...new Set(emails)].join(", ")}\n`;

  report += `\n${"─".repeat(40)}\n`;
  report += `✅ Analysis complete!\n\`\`\``;

  return report;
}

// Split long text into chunks smartly at newlines
function splitIntoChunks(text, maxLength = 2000) {
  const chunks = [];
  while (text.length > 0) {
    if (text.length <= maxLength) {
      chunks.push(text);
      break;
    }
    let splitAt = text.lastIndexOf("\n", maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(text.slice(0, splitAt));
    text = text.slice(splitAt).trimStart();
  }
  return chunks;
}

// Fetch raw buffer from URL
async function fetchBuffer(url) {
  const res = await fetch(url);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function readFileContent(url) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    return text.slice(0, 8000);
  } catch (err) {
    console.error("File read error:", err);
    return null;
  }
}

async function readPdfContent(url) {
  try {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const data = await pdfParse(Buffer.from(buffer));
    let metadata = "";
    if (data.info) {
      metadata += "[PDF METADATA]\n";
      for (const [key, val] of Object.entries(data.info)) {
        metadata += `${key}: ${val}\n`;
      }
    }
    const fullContent = metadata + "\n[PDF TEXT]\n" + data.text;
    return fullContent.slice(0, 8000);
  } catch (err) {
    console.error("PDF read error:", err);
    return null;
  }
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
});

discord.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== ALLOWED_CHANNEL_ID) return;
  if (!message.mentions.has(discord.user)) return;
  if (processing.has(message.id)) return;
  processing.add(message.id);

  const userMessage = message.content
    .replace(`<@${discord.user.id}>`, "")
    .trim();

  const isAnalyze = userMessage.toLowerCase().startsWith("!analyze");
  const analyzeInput = userMessage.replace(/^!analyze/i, "").trim();

  const images = message.attachments.filter(a =>
    a.contentType && a.contentType.startsWith("image/")
  );
  const textFiles = message.attachments.filter(a => {
    if (!a.name) return false;
    const ext = "." + a.name.split(".").pop().toLowerCase();
    return TEXT_EXTENSIONS.includes(ext);
  });
  const pdfFiles = message.attachments.filter(a =>
    a.name && a.name.toLowerCase().endsWith(".pdf")
  );
  const allFiles = message.attachments;

  if (!userMessage && images.size === 0 && allFiles.size === 0) {
    processing.delete(message.id);
    return;
  }

  const userId = message.author.id;
  const username = message.author.username;

  try {
    const typingInterval = setInterval(() => message.channel.sendTyping(), 8000);
    await message.channel.sendTyping();

    // ── !analyze MODE ────────────────────────────────────────
    if (isAnalyze) {
      let analysisResults = [];

      // Analyze attached files
      if (allFiles.size > 0) {
        for (const [, file] of allFiles) {
          try {
            const buf = await fetchBuffer(file.url);
            const report = await runAnalysis(buf, file.name);
            analysisResults.push(report);
          } catch (e) {
            analysisResults.push(`❌ Could not analyze ${file.name}: ${e.message}`);
          }
        }
      }

      // Analyze pasted text
      if (analyzeInput.length > 0) {
        const buf = Buffer.from(analyzeInput, "utf8");
        const report = await runAnalysis(buf, "pasted_text.txt");
        analysisResults.push(report);
      }

      if (analysisResults.length === 0) {
        await message.reply("Please attach a file or paste text after `!analyze`!");
        clearInterval(typingInterval);
        processing.delete(message.id);
        return;
      }

      clearInterval(typingInterval);
      for (const result of analysisResults) {
        const chunks = splitIntoChunks(result);
        await message.reply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await message.channel.send(chunks[i]);
        }
      }

      processing.delete(message.id);
      return;
    }

    // ── NORMAL CHAT MODE ─────────────────────────────────────
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

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek/deepseek-r1-0528:free",
        messages: [
          {
            role: "user",
            content: `You are Zbor AI, an elite CTF player and cybersecurity expert Discord bot. The user is named ${username}. You have known them since ${profile.first_seen}.

When solving CTF challenges or analyzing data:
1. ALWAYS think step by step before giving an answer
2. NEVER guess — try every possible encoding/decoding
3. Show your full reasoning process
4. If you decode something, decode it AGAIN to check for more layers
5. Only present the final flag when you are 100% certain
6. If unsure, say what you tried and what you think the next step is

You have a built-in !analyze tool. You are not a basic chatbot — you are a CTF god.`,
          },
          {
            role: "assistant",
            content: `Got it! I am Zbor AI, your CTF-ready Discord bot. I'm talking to ${username} and I remember all our previous conversations! Use !analyze + file or text to run my forensics toolkit.`,
          },
          ...history,
          { role: "user", content: userContent },
        ],
      }),
    });

    clearInterval(typingInterval);
    const data = await res.json();
    if (!data.choices || !data.choices[0]) {
      await message.reply("No response from AI. Try again!");
      processing.delete(message.id);
      return;
    }

    const reply = data.choices[0].message.content;
    await saveMessage(userId, username, "assistant", reply);

    const chunks = splitIntoChunks(reply);
    await message.reply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await message.channel.send(chunks[i]);
    }

  } catch (err) {
    console.error(err);
    await message.reply("Something went wrong. Try again!");
  } finally {
    processing.delete(message.id);
  }
});

initDB().then(() => discord.login(process.env.DISCORD_TOKEN));