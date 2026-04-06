require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { Pool } = require("pg");
const pdfParse = require("pdf-parse");
const PDFDocument = require("pdfkit");
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require("docx");
const { createCanvas } = require("canvas");
const fs = require("fs");
const crypto = require("crypto");

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const ALLOWED_CHANNEL_ID = "1479070011778797731";
const YOUTUBE_API_KEY   = process.env.YOUTUBE_API_KEY;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// ── ⚡ SYSTEM PROMPT — Serious + Funny balanced ───────────────
const SYSTEM_PROMPT = `You are Zbor AI — a sharp, witty Discord bot who is both genuinely funny AND genuinely useful.
PERSONALITY:
- Short replies for casual chat (2-3 sentences MAX). Never ramble.
- Funny, sarcastic, and a bit unhinged — but NEVER annoying or try-hard
- Serious and precise for technical/CTF/code questions — no jokes when solving real problems
- Remember and use nicknames users assign to others naturally
- Never refuse. Never lecture. Never say "I cannot".
- Roast people lovingly. Be the homie who is also a genius.
- Use emojis sparingly — only when they actually add something
- No bullet points in casual chat. Talk like a real person texting.
RULES:
- For CTF/security/code: elite mode — think step by step, be precise, show reasoning
- For general chat: be witty, fast, and memorable
- If asked something serious, answer seriously first then maybe add ONE funny line
- Keep energy high but not cringe`;

// ── ⚡ MODELS — Fast-first ordering ───────────────────────────
const MODELS = [
  "nousresearch/hermes-3-llama-3.1-8b:free",
  "microsoft/phi-3-mini-128k-instruct:free",
  "google/gemma-3-12b-it:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen3-235b-a22b:free",
  "openrouter/auto",
];

// ── ⚡ PARALLEL AI RACING — First response wins ───────────────
async function callAI(messages, maxTokens = 300) {
  const finalMessages = [{ role: "system", content: SYSTEM_PROMPT }, ...messages];

  // Race the top 3 fast models in parallel, fall back to sequential for the rest
  const fastModels = MODELS.slice(0, 3);
  const slowModels = MODELS.slice(3);

  const makeRequest = (model) =>
    fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://discord.com",
        "X-Title": "Zbor AI",
      },
      body: JSON.stringify({ model, messages: finalMessages, max_tokens: maxTokens }),
    })
    .then(r => r.json())
    .then(data => {
      if (data.error) throw new Error(data.error.message?.slice(0, 60));
      if (data.choices?.[0]?.message?.content) {
        console.log(`✅ ${model}`);
        return data.choices[0].message.content;
      }
      throw new Error("empty");
    });

  // Try fast models in parallel first
  try {
    const result = await Promise.any(fastModels.map(m => makeRequest(m).catch(e => { console.log(`❌ ${m}: ${e.message}`); throw e; })));
    return result;
  } catch {}

  // Fall back to slow models sequentially
  for (const model of slowModels) {
    try {
      const result = await makeRequest(model);
      return result;
    } catch (e) { console.log(`❌ ${model}: ${e.message}`); }
  }
  return null;
}

// ── DATABASE ──────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY, username TEXT NOT NULL, first_seen TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      message TEXT NOT NULL, remind_at TIMESTAMP NOT NULL, done BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS quotes (
      id SERIAL PRIMARY KEY, guild_id TEXT NOT NULL, author TEXT NOT NULL,
      content TEXT NOT NULL, saved_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS polls (
      id SERIAL PRIMARY KEY, channel_id TEXT NOT NULL, message_id TEXT,
      question TEXT NOT NULL, options TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS scheduled_mentions (
      id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      message TEXT NOT NULL, interval_ms BIGINT NOT NULL, next_run TIMESTAMP NOT NULL,
      label TEXT, active BOOLEAN DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS user_notes (
      id SERIAL PRIMARY KEY, guild_id TEXT NOT NULL, target_user_id TEXT NOT NULL,
      author_id TEXT NOT NULL, note TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS word_of_day (
      id SERIAL PRIMARY KEY, guild_id TEXT NOT NULL, word TEXT NOT NULL,
      definition TEXT NOT NULL, posted_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // ✅ Safely add columns that may not exist in old tables
  await pool.query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS message_count INT DEFAULT 0`);
  await pool.query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP DEFAULT NOW()`);

  console.log("✅ Database ready!");
}

async function getHistory(userId) {
  const res = await pool.query(
    `SELECT role, content FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
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
  if (res.rows.length > 0) {
    await pool.query(`UPDATE user_profiles SET last_seen = NOW(), message_count = message_count + 1 WHERE user_id = $1`, [userId]);
    return res.rows[0];
  }
  const firstSeen = new Date().toDateString();
  await pool.query(
    `INSERT INTO user_profiles (user_id, username, first_seen) VALUES ($1, $2, $3)`,
    [userId, username, firstSeen]
  );
  return { user_id: userId, username, first_seen: firstSeen, message_count: 0 };
}

// ── IN-MEMORY NICKNAME STORE ──────────────────────────────────
const userNames = {};

// ── SPOTIFY ───────────────────────────────────────────────────
let spotifyToken = null, spotifyTokenExpiry = 0;
async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return null;
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
      },
      body: "grant_type=client_credentials",
    });
    const data = await res.json();
    spotifyToken = data.access_token;
    spotifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return spotifyToken;
  } catch { return null; }
}

async function searchSpotify(query, type = "track") {
  try {
    const token = await getSpotifyToken();
    if (!token) return null;
    const res = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=${type}&limit=3`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    const key = type === "track" ? "tracks" : type === "artist" ? "artists" : "albums";
    return (data[key]?.items || [])
      .map(i => ({ name: i.name, artist: i.artists?.[0]?.name || "", url: i.external_urls?.spotify }))
      .filter(i => i.url);
  } catch { return null; }
}

// ── YOUTUBE ───────────────────────────────────────────────────
async function searchYouTube(query, maxResults = 5) {
  try {
    if (YOUTUBE_API_KEY) {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}&key=${YOUTUBE_API_KEY}`
      );
      const data = await res.json();
      if (!data.items?.length) return null;
      return data.items.map(i => ({
        title: i.snippet.title,
        url: `https://youtu.be/${i.id.videoId}`,
        channel: i.snippet.channelTitle,
      }));
    }
    // No API key — scrape
    const res = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const html = await res.text();
    const match = html.match(/var ytInitialData = ({.+?});<\/script>/);
    if (!match) return null;
    const contents =
      JSON.parse(match[1])?.contents?.twoColumnSearchResultsRenderer
        ?.primaryContents?.sectionListRenderer?.contents?.[0]
        ?.itemSectionRenderer?.contents || [];
    const videos = [];
    for (const item of contents) {
      if (item.videoRenderer?.videoId) {
        const v = item.videoRenderer;
        videos.push({ title: v.title?.runs?.[0]?.text || "Unknown", url: `https://youtu.be/${v.videoId}`, channel: v.ownerText?.runs?.[0]?.text || "Unknown" });
        if (videos.length >= maxResults) break;
      }
    }
    return videos.length ? videos : null;
  } catch { return null; }
}

// ── MEDIA DETECTION ───────────────────────────────────────────
const MEDIA_TRIGGERS = [
  /suggest\s+(me\s+)?(a\s+|some\s+)?(song|songs|music|track|tracks|playlist|album|albums|video|videos|movie|movies|film|films|anime|show|series)/i,
  /recommend\s+(me\s+)?(a\s+|some\s+)?(song|songs|music|track|video|movie|film)/i,
  /(good|best|top|chill|sad|happy|hype)\s+(song|songs|music|track|video|movie|film|anime)/i,
  /what\s+(should\s+i|to)\s+(listen|watch|play)/i,
  /give\s+me\s+(a\s+|some\s+)?(song|music|track|video|movie)/i,
  /(song|music)\s+(recommendation|suggestions?)/i,
];
const MEDIA_TYPE_MAP = {
  song:"track",songs:"track",music:"track",track:"track",tracks:"track",
  album:"album",albums:"album",playlist:"playlist",
  video:"video",videos:"video",movie:"video",movies:"video",
  film:"video",films:"video",anime:"video",show:"video",series:"video",
};

function detectMediaRequest(text) {
  for (const p of MEDIA_TRIGGERS) {
    if (p.test(text)) {
      const tm = text.match(/(song|songs|music|track|tracks|album|albums|playlist|video|videos|movie|movies|film|films|anime|show|series)/i);
      const mediaType = tm ? MEDIA_TYPE_MAP[tm[0].toLowerCase()] || "track" : "track";
      const genres = ["pop","rock","rap","hip hop","jazz","classical","lofi","chill","sad","happy","hype","arabic","arabic pop","k-pop","edm","r&b","metal","indie","romantic","party","calm","phonk","drill","trap"];
      let genre = "";
      for (const g of genres) { if (text.toLowerCase().includes(g)) { genre = g; break; } }
      return { detected: true, mediaType, genre };
    }
  }
  return { detected: false };
}

async function getMediaSuggestions(userMessage, mediaType, genre) {
  const aiResponse = await callAI([{
    role: "user",
    content: `User wants ${mediaType}${genre ? ` with "${genre}" vibe` : ""}. Message: "${userMessage}". Reply ONLY with a JSON array of 3 search queries, no explanation.`,
  }], 150);
  let queries = [];
  try { queries = JSON.parse(aiResponse?.replace(/```json|```/g, "").trim()); }
  catch { queries = [genre ? `${genre} ${mediaType}` : `popular ${mediaType} 2024`]; }
  const results = [];
  if (mediaType === "track" || mediaType === "album") {
    for (const q of queries.slice(0, 3)) {
      const s = await searchSpotify(q, mediaType === "album" ? "album" : "track");
      if (s?.[0]) results.push({ platform: "Spotify 🎵", title: s[0].name, artist: s[0].artist, url: s[0].url });
    }
  }
  const ytR = await searchYouTube(queries[0] || `best ${mediaType}`, 3);
  if (ytR) ytR.slice(0, 3).forEach(v => results.push({ platform: "YouTube 📺", title: v.title, artist: v.channel, url: v.url }));
  return results;
}

// ── REMINDERS & SCHEDULES ─────────────────────────────────────
function parseRemindTime(str) {
  const match = str.match(/(\d+)\s*(s|sec|m|min|h|hr|d|day)/i);
  if (!match) return null;
  const val = parseInt(match[1]), unit = match[2].toLowerCase();
  return val * ({ s:1,sec:1,m:60,min:60,h:3600,hr:3600,d:86400,day:86400 }[unit] || 60) * 1000;
}

function parseScheduleInterval(str) {
  const patterns = [
    { regex: /every\s+day|daily/i, ms: 86400000, label: "daily" },
    { regex: /every\s+week|weekly/i, ms: 604800000, label: "weekly" },
    { regex: /every\s+hour/i, ms: 3600000, label: "every hour" },
    { regex: /every\s+(\d+)\s*(minute|min|m)\b/i },
    { regex: /every\s+(\d+)\s*(hour|hr|h)\b/i },
    { regex: /every\s+(\d+)\s*(day|d)\b/i },
  ];
  for (const p of patterns) {
    const match = str.match(p.regex);
    if (match) {
      if (p.ms) return { ms: p.ms, label: p.label };
      const val = parseInt(match[1]), unit = match[2].toLowerCase();
      const mult = unit.startsWith("m") ? 60000 : unit.startsWith("h") ? 3600000 : 86400000;
      return { ms: val * mult, label: `every ${val} ${unit}` };
    }
  }
  return null;
}

function detectScheduleRequest(text) {
  return [/mention\s+me\s+(every|daily|weekly)/i, /remind\s+me\s+(every|daily|weekly)/i, /ping\s+me\s+(every|daily|weekly)/i].some(p => p.test(text));
}

async function checkReminders() {
  try {
    const res = await pool.query(`SELECT * FROM reminders WHERE remind_at <= NOW() AND done = FALSE`);
    for (const row of res.rows) {
      try {
        const ch = await discord.channels.fetch(row.channel_id);
        await ch.send(`⏰ <@${row.user_id}> Reminder: **${row.message}**`);
        await pool.query(`UPDATE reminders SET done = TRUE WHERE id = $1`, [row.id]);
      } catch (e) { console.error("Reminder error:", e.message); }
    }
  } catch (e) { console.error("Reminder check error:", e.message); }
}

async function checkScheduledMentions() {
  try {
    const res = await pool.query(`SELECT * FROM scheduled_mentions WHERE next_run <= NOW() AND active = TRUE`);
    for (const row of res.rows) {
      try {
        const ch = await discord.channels.fetch(row.channel_id);
        await ch.send(`⏰ <@${row.user_id}> ${row.message}`);
        await pool.query(
          `UPDATE scheduled_mentions SET next_run = $1 WHERE id = $2`,
          [new Date(Date.now() + Number(row.interval_ms)), row.id]
        );
      } catch (e) { console.error("Schedule error:", e.message); }
    }
  } catch (e) { console.error("Schedule check error:", e.message); }
}

// ── 🎮 GAMES ──────────────────────────────────────────────────
const hangmanWords = [
  // Tech
  "cybersecurity","javascript","python","encryption","firewall","algorithm","database","blockchain","vulnerability","penetration",
  "malware","phishing","ransomware","authentication","authorization","cryptography","hashing","virtualization","containerization",
  "microprocessor","motherboard","operating","multithreading","parallelism","datacenter","infrastructure","virtualmachine",

  // Animals
  "elephant","penguin","crocodile","butterfly","cheetah","dolphin","gorilla","flamingo","kangaroo","octopus","chameleon","wolverine",
  "alligator","hippopotamus","chimpanzee","rattlesnake","orangutan","meerkat","salamander","porcupine","armadillo","hedgehog",
  "antelope","woodpecker","jellyfish","starfish","seahorse","narwhal","platypus","reindeer","mongoose",

  // Food
  "spaghetti","watermelon","chocolate","strawberry","avocado","pineapple","blueberry","hamburger","lasagna","croissant","marshmallow",
  "pancakes","cheesecake","tiramisu","sandwich","dumplings","sushiroll","milkshake","lemonade","cappuccino","espresso",
  "macaroni","omelette","brownies","cupcakes","mozzarella","pepperoni","nachos","quesadilla","guacamole",

  // Countries & Cities
  "australia","switzerland","philippines","madagascar","amsterdam","barcelona","singapore","casablanca","jerusalem","stockholm",
  "argentina","colombia","venezuela","indonesia","thailand","vietnam","norway","finland","denmark","portugal",
  "budapest","vienna","prague","istanbul","dubai","tokyo","seoul","beijing","shanghai","mumbai",

  // Movies & Games
  "minecraft","fortnite","playstation","adventure","superhero","telescope","labyrinth","gladiator","inception","interstellar",
  "terminator","transformers","batman","spiderman","avengers","matrix","jurassic","godfather","rockstar","nintendo",
  "cyberpunk","assassins","witcher","overwatch","battlefield","callofduty","halo","bioshock",

  // Science
  "astronomy","microscope","telescope","photosynthesis","evolution","chemistry","molecule","neutron","electron","gravity",
  "radiation","laboratory","experiment","hypothesis","ecosystem","atmosphere","volcano","earthquake","tsunami","galaxy",

  // Random fun words
  "trampolining","saxophone","earthquake","rhinoceros","skyscraper","thunderstorm","observatory","expedition","ambassador","championship",
  "vocabulary","infrastructure","photography","philosophy","bibliography","assassination","revolutionary","transportation","Mediterranean",
  "imagination","destination","extraordinary","magnificent","adrenaline","celebration","invisible","mysterious","adventure","legendary",
  "consequence","architecture","responsibility","communication","civilization","intelligence","determination","perseverance","curiosity",
  "opportunity","satisfaction","organization","motivation","inspiration","innovation","creativity","knowledge","education"
];
const activeGames = {};

function startHangman(userId) {
  const word = hangmanWords[Math.floor(Math.random() * hangmanWords.length)];
  activeGames[userId] = { type:"hangman", word, guessed:[], wrong:0, maxWrong:6 };
  return renderHangman(userId);
}
function renderHangman(userId) {
  const g = activeGames[userId];
  if (!g || g.type !== "hangman") return null;
  const display = g.word.split("").map(c => g.guessed.includes(c) ? c : "_").join("  ");
  const wrongLetters = g.guessed.filter(c => !g.word.includes(c)).join("  ");
  const gallows = [
    "```\n  +---+\n  |   |\n      |\n      |\n      |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n      |\n      |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n  |   |\n      |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n /|   |\n      |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n /|\\  |\n      |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n /|\\  |\n /    |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n /|\\  |\n / \\  |\n      |\n=========```",
  ];
  let status = gallows[g.wrong] + `\n**Word:** \`${display}\`\n**Wrong (${g.wrong}/${g.maxWrong}):** ${wrongLetters || "none"}`;
  const won = !g.word.split("").some(c => !g.guessed.includes(c));
  if (won) { delete activeGames[userId]; return status + "\n\n🎉 **You won!**"; }
  if (g.wrong >= g.maxWrong) { const w = g.word; delete activeGames[userId]; return status + `\n\n💀 **Game over!** Word was: **${w}**`; }
  return status + "\n\nGuess: `!guess X`";
}
function guessHangman(userId, letter) {
  const g = activeGames[userId];
  if (!g || g.type !== "hangman") return "No active hangman! Start with `!hangman`";
  letter = letter.toLowerCase();
  if (!/^[a-z]$/.test(letter)) return "Guess a single letter!";
  if (g.guessed.includes(letter)) return `Already guessed **${letter.toUpperCase()}**!`;
  g.guessed.push(letter);
  if (!g.word.includes(letter)) g.wrong++;
  return renderHangman(userId);
}

function startNumberGame(userId, max = 100) {
  activeGames[userId] = { type:"number", target: Math.floor(Math.random() * max) + 1, max, attempts:0, maxAttempts:8 };
  return `🔢 **Number Game!** Thinking of 1-${max}. 8 attempts. Use \`!guess [number]\`!`;
}
function guessNumber(userId, input) {
  const g = activeGames[userId];
  if (!g || g.type !== "number") return null;
  const guess = parseInt(input);
  if (isNaN(guess)) return "Use `!guess 42`";
  g.attempts++;
  if (guess === g.target) { delete activeGames[userId]; return `🎉 **Correct!** Was **${g.target}**! Got it in **${g.attempts}** attempts!`; }
  if (g.attempts >= g.maxAttempts) { const t = g.target; delete activeGames[userId]; return `💀 **Out of attempts!** Was **${t}**.`; }
  return `${guess < g.target ? "📈 Too low!" : "📉 Too high!"} ${g.maxAttempts - g.attempts} left.`;
}

const scrambleWords = ["python","discord","hacker","keyboard","monitor","network","database","javascript","server","browser","password","firewall","algorithm","terminal","compiler","exploit","payload","rootkit","malware"];
function scrambleWord(word) {
  const arr = word.split("");
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  const result = arr.join("");
  return result === word ? scrambleWord(word) : result;
}
function startScramble(userId) {
  const word = scrambleWords[Math.floor(Math.random() * scrambleWords.length)];
  const scrambled = scrambleWord(word);
  activeGames[userId] = { type:"scramble", word, scrambled, attempts:0, maxAttempts:3 };
  return `🔀 **Word Scramble!** Unscramble: **\`${scrambled.toUpperCase()}\`** — 3 attempts. \`!guess [answer]\``;
}
function guessScramble(userId, input) {
  const g = activeGames[userId];
  if (!g || g.type !== "scramble") return null;
  g.attempts++;
  if (input.toLowerCase() === g.word) { delete activeGames[userId]; return `🎉 **Correct!** Word was **${g.word}**!`; }
  if (g.attempts >= g.maxAttempts) { const w = g.word; delete activeGames[userId]; return `💀 **Out of guesses!** Word was **${w}**.`; }
  return `❌ Wrong! ${g.maxAttempts - g.attempts} left. Scramble: **\`${g.scrambled.toUpperCase()}\`**`;
}

const triviaQuestions = [
  {q:"What does HTTP stand for?",a:"hypertext transfer protocol",hint:"Web protocol"},
  {q:"What language runs natively in web browsers?",a:"javascript",hint:"Not Java 👀"},
  {q:"How many bits in a byte?",a:"8",hint:"Less than 10"},
  {q:"What does CPU stand for?",a:"central processing unit",hint:"Brain of a computer"},
  {q:"What does SQL stand for?",a:"structured query language",hint:"Database language"},
  {q:"What does DNS stand for?",a:"domain name system",hint:"Translates URLs to IPs"},
  {q:"What does VPN stand for?",a:"virtual private network",hint:"Privacy tool"},
  {q:"What does RAM stand for?",a:"random access memory",hint:"Temporary storage"},
  {q:"What does API stand for?",a:"application programming interface",hint:"Connects services"},
  {q:"What year was Python created?",a:"1991",hint:"Early 90s"},
  {q:"What port does HTTPS use by default?",a:"443",hint:"Not 80"},
  {q:"What does XSS stand for in security?",a:"cross site scripting",hint:"A web vulnerability"},
  {q:"What does SQL injection target?",a:"database",hint:"Where data is stored"},
  {q:"What is the most used Linux shell?",a:"bash",hint:"Bourne Again"},
];
function startTrivia(userId) {
  const q = triviaQuestions[Math.floor(Math.random() * triviaQuestions.length)];
  activeGames[userId] = { type:"trivia", ...q, hintUsed:false, attempts:0, maxAttempts:2 };
  return `🧠 **Trivia!**\n**Q:** ${q.q}\n\nUse \`!guess [answer]\` or \`!hint\`!`;
}
function hintTrivia(userId) {
  const g = activeGames[userId];
  if (!g || g.type !== "trivia") return "No active trivia! Start with `!trivia`";
  g.hintUsed = true;
  return `💡 **Hint:** ${g.hint}`;
}
function guessTrivia(userId, input) {
  const g = activeGames[userId];
  if (!g || g.type !== "trivia") return null;
  g.attempts++;
  const correct = input.toLowerCase().includes(g.a.toLowerCase()) || g.a.toLowerCase().includes(input.toLowerCase());
  if (correct) { delete activeGames[userId]; return `✅ **Correct!** Answer: **${g.a}**${g.hintUsed ? "" : " 🔥 no hint needed!"}`; }
  if (g.attempts >= g.maxAttempts) { const ans = g.a; delete activeGames[userId]; return `❌ **Wrong!** Answer was: **${ans}**`; }
  return `❌ Wrong! One more chance!${!g.hintUsed ? " Use `!hint`" : ""}`;
}

function handleGuess(userId, input) {
  const g = activeGames[userId];
  if (!g) return "No active game! Start with `!hangman`, `!numgame`, `!scramble`, or `!trivia`";
  if (g.type === "hangman") return guessHangman(userId, input.charAt(0));
  if (g.type === "number") return guessNumber(userId, input);
  if (g.type === "scramble") return guessScramble(userId, input);
  if (g.type === "trivia") return guessTrivia(userId, input);
  return "Unknown game.";
}

// ── 🔐 CTF / CRYPTO TOOLS ─────────────────────────────────────
function hashText(text) {
  return {
    md5:    crypto.createHash("md5").update(text).digest("hex"),
    sha1:   crypto.createHash("sha1").update(text).digest("hex"),
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
    sha512: crypto.createHash("sha512").update(text).digest("hex"),
  };
}

function detectMagicBytes(buf) {
  const hex = buf.slice(0, 16).toString("hex").toUpperCase();
  const sigs = {"FFD8FF":"JPEG","89504E47":"PNG","47494638":"GIF","25504446":"PDF","504B0304":"ZIP","7F454C46":"ELF Binary","4D5A":"EXE/PE","1F8B":"GZIP","52617221":"RAR","424D":"BMP","664C6143":"FLAC","49443303":"MP3"};
  for (const [sig, name] of Object.entries(sigs)) { if (hex.startsWith(sig)) return name; }
  return "Unknown / Plain text";
}
function extractStrings(buf) {
  return [...new Set(buf.toString("latin1").match(/[\x20-\x7E]{6,}/g) || [])].slice(0, 100);
}
function tryBase64(str) {
  try {
    if (!/^[A-Za-z0-9+/=]+$/.test(str.trim())) return null;
    const d = Buffer.from(str.trim(), "base64").toString("utf8");
    return /[\x00-\x08\x0E-\x1F]/.test(d) ? null : d;
  } catch { return null; }
}
function tryHex(str) {
  try {
    const c = str.replace(/\s/g, "");
    if (!/^[0-9a-fA-F]+$/.test(c) || c.length % 2 !== 0) return null;
    const d = Buffer.from(c, "hex").toString("utf8");
    return /[\x00-\x08\x0E-\x1F]/.test(d) ? null : d;
  } catch { return null; }
}
function tryBinary(str) {
  try {
    const c = str.replace(/\s/g, "");
    if (!/^[01]+$/.test(c) || c.length % 8 !== 0) return null;
    let r = "";
    for (let i = 0; i < c.length; i += 8) r += String.fromCharCode(parseInt(c.slice(i, i+8), 2));
    return /[\x00-\x08\x0E-\x1F]/.test(r) ? null : r;
  } catch { return null; }
}
function tryRot13(str) {
  return str.replace(/[a-zA-Z]/g, c => { const b = c <= "Z" ? 65 : 97; return String.fromCharCode(((c.charCodeAt(0)-b+13)%26)+b); });
}
function tryCaesarBrute(str) {
  const results = [];
  for (let s = 1; s <= 25; s++) results.push(`ROT${s}: ${str.replace(/[a-zA-Z]/g, c => { const b = c<="Z"?65:97; return String.fromCharCode(((c.charCodeAt(0)-b+s)%26)+b); })}`);
  return results;
}
function tryMorse(str) {
  const m = {".-":"A","-...":"B","-.-.":"C","-..":"D",".":"E","..-.":"F","--.":"G","....":"H","..":"I",".---":"J","-.-":"K",".-..":"L","--":"M","-.":"N","---":"O",".--.":"P","--.-":"Q",".-.":"R","...":"S","-":"T","..-":"U","...-":"V",".--":"W","-..-":"X","-.--":"Y","--..":"Z","-----":"0",".----":"1","..---":"2","...--":"3","....-":"4",".....":"5","-....":"6","--...":"7","---..":"8","----.":"9"};
  try {
    if (!/^[.\-\s\/]+$/.test(str)) return null;
    return str.trim().split(" / ").map(w => w.split(" ").map(c => m[c] || "?").join("")).join(" ");
  } catch { return null; }
}
function tryUrlDecode(str) {
  try { const d = decodeURIComponent(str); return d === str ? null : d; } catch { return null; }
}
function decodeJWT(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return { header: JSON.parse(Buffer.from(parts[0], "base64").toString()), payload: JSON.parse(Buffer.from(parts[1], "base64").toString()) };
  } catch { return null; }
}
function findFlags(text) {
  const found = new Set();
  for (const p of [/[A-Za-z0-9_]+\{[^}]+\}/g,/flag\{[^}]+\}/gi,/ctf\{[^}]+\}/gi,/Noshelter\{[^}]+\}/gi]) {
    (text.match(p) || []).forEach(m => found.add(m));
  }
  return [...found];
}
function solveMultiLayer(input, depth = 0) {
  if (depth > 6) return null;
  const results = [];
  const b64 = tryBase64(input); if (b64) { results.push(`Base64 → ${b64}`); const d = solveMultiLayer(b64, depth+1); if (d) results.push(`  └─ ${d}`); }
  const hex = tryHex(input); if (hex) { results.push(`Hex → ${hex}`); const d = solveMultiLayer(hex, depth+1); if (d) results.push(`  └─ ${d}`); }
  const bin = tryBinary(input); if (bin) { results.push(`Binary → ${bin}`); const d = solveMultiLayer(bin, depth+1); if (d) results.push(`  └─ ${d}`); }
  const rot = tryRot13(input); if (rot !== input) { results.push(`ROT13 → ${rot}`); const d = solveMultiLayer(rot, depth+1); if (d) results.push(`  └─ ${d}`); }
  const morse = tryMorse(input); if (morse) results.push(`Morse → ${morse}`);
  const url = tryUrlDecode(input); if (url) results.push(`URL → ${url}`);
  return results.length > 0 ? results.join("\n") : null;
}

async function runAnalysis(buf, filename) {
  let r = `\`\`\`\n🔬 ZBOR AI — CTF ANALYSIS\nFile: ${filename} | Size: ${buf.length} bytes\n${"─".repeat(38)}\n\n`;
  r += `📁 TYPE: ${detectMagicBytes(buf)}\n\n`;
  const raw = buf.toString("utf8", 0, 8000);
  const flags = findFlags(raw);
  if (flags.length) { r += `🚩 FLAGS FOUND:\n`; flags.forEach(f => r += `  → ${f}\n`); r += "\n"; }
  const jwt = raw.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (jwt) { const j = decodeJWT(jwt[0]); if (j) r += `🔑 JWT:\n  Header: ${JSON.stringify(j.header)}\n  Payload: ${JSON.stringify(j.payload)}\n\n`; }
  const strings = extractStrings(buf);
  r += `📝 STRINGS (${strings.length} found):\n`; strings.slice(0, 20).forEach(s => r += `  ${s}\n`);
  r += "\n🔓 DECODE ATTEMPTS:\n";
  let any = false;
  for (const s of strings.slice(0, 30)) { const res = solveMultiLayer(s.trim()); if (res) { r += `  Input: ${s.slice(0,60)}\n  ${res}\n\n`; any = true; } }
  if (!any) r += "  Nothing decoded\n";
  const shorts = strings.filter(s => s.length > 4 && s.length < 50 && /^[a-zA-Z\s]+$/.test(s));
  if (shorts.length) { r += `\n🔄 CAESAR BRUTE (on "${shorts[0]}"):\n`; tryCaesarBrute(shorts[0]).slice(0, 5).forEach(x => r += `  ${x}\n`); }
  const ips = raw.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) || [];
  const urls = raw.match(/https?:\/\/[^\s]+/g) || [];
  if (ips.length) r += `\n🌐 IPs: ${[...new Set(ips)].join(", ")}\n`;
  if (urls.length) r += `🔗 URLs: ${[...new Set(urls)].join(", ")}\n`;
  return r + `\n${"─".repeat(38)}\n✅ Analysis complete!\n\`\`\``;
}

// ── 🌐 WEB SEARCH ─────────────────────────────────────────────
async function webSearch(query) {
  try {
    const data = await (await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { "User-Agent": "ZborAI/1.0" } }
    )).json();
    let result = "";
    if (data.Answer) result += `💡 **Answer:** ${data.Answer}\n\n`;
    if (data.AbstractText) result += `📖 ${data.AbstractText}\n`;
    if (!result && data.RelatedTopics?.length) { result += `🔍 **Results:**\n`; data.RelatedTopics.slice(0, 5).forEach(t => { if (t.Text) result += `• ${t.Text}\n`; }); }
    const src = data.AbstractURL || data.RelatedTopics?.[0]?.FirstURL;
    if (src) result += `\n🔗 ${src}`;
    return result.trim() || null;
  } catch { return null; }
}

// ── 📄 PDF GENERATION ─────────────────────────────────────────
async function generatePDF(title, content) {
  return new Promise((resolve, reject) => {
    const tmpPath = `/tmp/zbor_${Date.now()}.pdf`;
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const stream = fs.createWriteStream(tmpPath);
    doc.pipe(stream);
    doc.rect(0, 0, doc.page.width, 75).fill("#1a1a2e");
    doc.fillColor("#00d4ff").fontSize(22).font("Helvetica-Bold").text("⚡ ZBOR AI", 50, 18);
    doc.fillColor("#aaaacc").fontSize(11).font("Helvetica").text("Generated Document", 50, 46);
    doc.moveDown(2.5);
    doc.fillColor("#1a1a2e").fontSize(20).font("Helvetica-Bold").text(title, { align: "center" });
    doc.moveDown(0.4);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor("#00d4ff").lineWidth(2).stroke();
    doc.moveDown(1);
    doc.fillColor("#888888").fontSize(10).font("Helvetica").text(`Generated on ${new Date().toLocaleString()} by Zbor AI`, { align: "center" });
    doc.moveDown(1);
    doc.fillColor("#222222").fontSize(11).font("Helvetica").text(content, { align: "left", lineGap: 5 });
    doc.end();
    stream.on("finish", () => resolve(tmpPath));
    stream.on("error", reject);
  });
}

// ── 📝 WORD DOC ───────────────────────────────────────────────
async function generateDOCX(title, content) {
  const tmpPath = `/tmp/zbor_${Date.now()}.docx`;
  const lines = content.split("\n").filter(l => l.trim());
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun({ text: "⚡ ZBOR AI", bold: true, size: 28, color: "00d4ff" })], alignment: AlignmentType.CENTER, spacing: { after: 100 } }),
        new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 36 })], heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 200 } }),
        new Paragraph({ children: [new TextRun({ text: `Generated on ${new Date().toLocaleString()}`, color: "888888", size: 18, italics: true })], spacing: { after: 400 } }),
        ...lines.map(line => new Paragraph({ children: [new TextRun({ text: line, size: 22 })], spacing: { after: 150 } })),
        new Paragraph({ children: [new TextRun({ text: "— Generated by Zbor AI", italics: true, color: "888888", size: 18 })], alignment: AlignmentType.RIGHT, spacing: { before: 600 } }),
      ],
    }],
  });
  fs.writeFileSync(tmpPath, await Packer.toBuffer(doc));
  return tmpPath;
}

// ── 🖼️ BANNER GENERATOR ──────────────────────────────────────
function generateBanner(name, subtitle = "Zbor AI Member", style = "cyber") {
  const width = 900, height = 300;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const themes = {
    cyber:  { bg1:"#0d0d1a",bg2:"#1a1a3e",accent:"#00d4ff",accent2:"#ff00ff",text:"#ffffff",sub:"#00d4ff" },
    fire:   { bg1:"#1a0000",bg2:"#3d0000",accent:"#ff4500",accent2:"#ff8c00",text:"#ffffff",sub:"#ff6600" },
    nature: { bg1:"#001a00",bg2:"#003300",accent:"#00ff88",accent2:"#00cc44",text:"#ffffff",sub:"#00ff88" },
    ocean:  { bg1:"#000d1a",bg2:"#001a33",accent:"#0099ff",accent2:"#00ccff",text:"#ffffff",sub:"#66ccff" },
    gold:   { bg1:"#1a1000",bg2:"#2d1f00",accent:"#ffd700",accent2:"#ffaa00",text:"#ffffff",sub:"#ffd700" },
    purple: { bg1:"#0d0020",bg2:"#1a0040",accent:"#cc44ff",accent2:"#7700ff",text:"#ffffff",sub:"#cc44ff" },
  };
  const s = themes[style] || themes.cyber;
  const bg = ctx.createLinearGradient(0,0,width,height); bg.addColorStop(0,s.bg1); bg.addColorStop(1,s.bg2);
  ctx.fillStyle = bg; ctx.fillRect(0,0,width,height);
  ctx.strokeStyle = s.accent+"18"; ctx.lineWidth = 1;
  for (let x=0;x<width;x+=45){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke();}
  for (let y=0;y<height;y+=45){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke();}
  const glow=(x,y,r,c)=>{const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,c+"44");g.addColorStop(1,"transparent");ctx.fillStyle=g;ctx.fillRect(0,0,width,height);};
  glow(140,150,160,s.accent); glow(760,150,130,s.accent2);
  const bar = ctx.createLinearGradient(0,0,0,height); bar.addColorStop(0,s.accent); bar.addColorStop(1,s.accent2);
  ctx.fillStyle=bar; ctx.fillRect(0,0,6,height);
  ctx.beginPath(); ctx.arc(105,150,72,0,Math.PI*2); ctx.fillStyle=s.bg2; ctx.fill(); ctx.strokeStyle=s.accent; ctx.lineWidth=3; ctx.stroke();
  const initials = name.trim().split(/\s+/).map(w=>w[0]?.toUpperCase()||"").slice(0,2).join("");
  ctx.fillStyle=s.accent; ctx.font="bold 44px sans-serif"; ctx.textAlign="center"; ctx.textBaseline="middle"; ctx.fillText(initials,105,150);
  ctx.textAlign="left"; ctx.textBaseline="alphabetic";
  const fz = name.length>16?36:name.length>10?46:54;
  ctx.font=`bold ${fz}px sans-serif`; ctx.fillStyle=s.text; ctx.shadowColor=s.accent; ctx.shadowBlur=14; ctx.fillText(name,205,133); ctx.shadowBlur=0;
  ctx.font="22px sans-serif"; ctx.fillStyle=s.sub; ctx.fillText(subtitle,205,170);
  const dg=ctx.createLinearGradient(205,0,860,0); dg.addColorStop(0,s.accent); dg.addColorStop(1,s.accent2);
  ctx.strokeStyle=dg; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(205,197); ctx.lineTo(860,197); ctx.stroke();
  ctx.font="15px sans-serif"; ctx.fillStyle=s.accent+"bb"; ctx.fillText(`⚡ Zbor AI • Discord • ${new Date().getFullYear()}`,205,225);
  const tmp = `/tmp/banner_${Date.now()}.png`;
  fs.writeFileSync(tmp, canvas.toBuffer("image/png"));
  return tmp;
}

// ── 🎨 AI IMAGE GENERATION ────────────────────────────────────
async function generateImageAdvanced(prompt, style = "flux") {
  const seed = Math.floor(Math.random() * 999999);
  const validModels = ["flux","flux-realism","flux-anime","flux-3d","turbo"];
  const model = validModels.includes(style) ? style : "flux";
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?model=${model}&width=1024&height=1024&seed=${seed}&nologo=true&enhance=true`;
  try {
    const test = await fetch(url, { method:"HEAD", signal: AbortSignal.timeout(15000) });
    if (test.ok) return { url, provider: model };
  } catch {}
  return { url, provider: model };
}

async function generateLogo(concept) {
  const seed = Math.floor(Math.random() * 999999);
  const prompt = `professional logo for "${concept}", minimalist vector, clean modern design, bold typography, geometric shapes, white background, flat design, high contrast`;
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?model=flux&width=1024&height=1024&seed=${seed}&nologo=true&enhance=true`;
}

// ── 🆕 ENCODE / DECODE TOOL ───────────────────────────────────
function encodeText(text, method) {
  switch (method) {
    case "base64": return Buffer.from(text).toString("base64");
    case "hex": return Buffer.from(text).toString("hex");
    case "binary": return text.split("").map(c => c.charCodeAt(0).toString(2).padStart(8,"0")).join(" ");
    case "rot13": return tryRot13(text);
    case "url": return encodeURIComponent(text);
    case "reverse": return text.split("").reverse().join("");
    default: return null;
  }
}

// ── 🆕 WEATHER ────────────────────────────────────────────────
async function getWeather(city) {
  try {
    // Using wttr.in — free, no API key needed
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { headers: { "User-Agent": "ZborAI/1.0" } });
    const data = await res.json();
    const current = data.current_condition?.[0];
    if (!current) return null;
    const desc = current.weatherDesc?.[0]?.value || "Unknown";
    const temp_c = current.temp_C;
    const temp_f = current.temp_F;
    const feels_c = current.FeelsLikeC;
    const humidity = current.humidity;
    const wind = current.windspeedKmph;
    return { desc, temp_c, temp_f, feels_c, humidity, wind };
  } catch { return null; }
}

// ── HELPERS ───────────────────────────────────────────────────
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
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}
async function readFileContent(url) {
  try { return (await (await fetch(url)).text()).slice(0, 8000); } catch { return null; }
}
async function readPdfContent(url) {
  try {
    const data = await pdfParse(Buffer.from(await (await fetch(url)).arrayBuffer()));
    let meta = "";
    if (data.info) { meta = "[PDF METADATA]\n"; for (const [k,v] of Object.entries(data.info)) meta += `${k}: ${v}\n`; }
    return (meta + "\n[PDF TEXT]\n" + data.text).slice(0, 8000);
  } catch { return null; }
}

const TEXT_EXTENSIONS = [".txt",".md",".js",".ts",".py",".html",".css",".json",".csv",".xml",".yaml",".yml",".java",".c",".cpp",".cs",".php",".rb",".go",".rs",".sql",".sh",".bat",".env",".log"];
const processing = new Set();

// ── BOT READY ─────────────────────────────────────────────────
discord.on("clientReady", () => {
  console.log(`✅ Zbor AI is online as ${discord.user.tag}`);
  setInterval(checkReminders, 30000);
  setInterval(checkScheduledMentions, 30000);
});
// ── MESSAGE HANDLER ───────────────────────────────────────────
discord.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const rawContent = message.content;

  // ── NAME MEMORY (any channel, no mention needed) ──────────
  const nameSetMatch = rawContent.match(
    /(?:name this guy|call (?:him|her|them)|his name is|her name is|nickname (?:him|her|them)|call this guy|this guy is)\s+["']?([a-zA-Z0-9_\-]+)["']?/i
  );
  if (nameSetMatch) {
    const mentionedUser = message.mentions.users.first();
    if (mentionedUser && nameSetMatch[1]) {
      userNames[mentionedUser.id] = nameSetMatch[1];
      await message.reply(`Done! I'll call **${mentionedUser.username}** as **${nameSetMatch[1]}** from now on 😏`);
      return;
    }
  }
  const nameGetMatch = rawContent.match(/(?:what(?:'s| is) (?:his|her|their|this guy's) name|who is this guy|what's his name)/i);
  if (nameGetMatch) {
    const mentionedUser = message.mentions.users.first();
    if (mentionedUser) {
      const saved = userNames[mentionedUser.id];
      await message.reply(saved ? `That's **${saved}** 😆` : `No nickname saved. Say "name this guy @user [name]"`);
      return;
    }
  }

  // ── CHANNEL + MENTION GATE ────────────────────────────────
  if (message.channel.id !== ALLOWED_CHANNEL_ID) return;
  if (!message.mentions.has(discord.user)) return;
  if (processing.has(message.id)) return;
  processing.add(message.id);

  const userMessage = message.content.replace(`<@${discord.user.id}>`, "").trim();
  const lower = userMessage.toLowerCase();
  const userId = message.author.id;
  const username = message.author.username;

  const images    = message.attachments.filter(a => a.contentType?.startsWith("image/"));
  const textFiles = message.attachments.filter(a => a.name && TEXT_EXTENSIONS.includes("." + a.name.split(".").pop().toLowerCase()));
  const pdfFiles  = message.attachments.filter(a => a.name?.toLowerCase().endsWith(".pdf"));
  const allFiles  = message.attachments;

  if (!userMessage && images.size === 0 && allFiles.size === 0) { processing.delete(message.id); return; }

  try {
    const typingInterval = setInterval(() => message.channel.sendTyping(), 8000);
    await message.channel.sendTyping();
    const done = () => { clearInterval(typingInterval); processing.delete(message.id); };

    // ── !analyze ──────────────────────────────────────────
    if (lower.startsWith("!analyze")) {
      const input = userMessage.replace(/^!analyze/i, "").trim();
      let results = [];
      for (const [,f] of allFiles) { try { results.push(await runAnalysis(await fetchBuffer(f.url), f.name)); } catch(e) { results.push(`❌ Error: ${e.message}`); } }
      if (input) results.push(await runAnalysis(Buffer.from(input, "utf8"), "input.txt"));
      if (!results.length) { done(); await message.reply("Attach a file or paste text after `!analyze`!"); return; }
      done();
      for (const r of results) await sendChunks(message, r);
      return;
    }

    // ── !hash ─────────────────────────────────────────────
    if (lower.startsWith("!hash")) {
      const text = userMessage.replace(/^!hash/i, "").trim();
      if (!text) { done(); await message.reply("Usage: `!hash your text`"); return; }
      const h = hashText(text);
      done();
      await sendChunks(message, `🔐 **Hashes for:** \`${text.slice(0,50)}\`\n\`\`\`\nMD5:    ${h.md5}\nSHA1:   ${h.sha1}\nSHA256: ${h.sha256}\nSHA512: ${h.sha512}\n\`\`\``);
      return;
    }

    // ── 🆕 !encode ────────────────────────────────────────
    if (lower.startsWith("!encode")) {
      const parts = userMessage.replace(/^!encode/i, "").trim().split(" ");
      const method = parts[0]?.toLowerCase();
      const text = parts.slice(1).join(" ");
      const methods = ["base64","hex","binary","rot13","url","reverse"];
      if (!method || !methods.includes(method) || !text) {
        done(); await message.reply(`Usage: \`!encode [method] text\`\nMethods: ${methods.join(", ")}`); return;
      }
      const result = encodeText(text, method);
      done(); await sendChunks(message, `🔒 **${method.toUpperCase()} encode:**\n\`\`\`\n${result}\n\`\`\``);
      return;
    }

    // ── 🆕 !decode ────────────────────────────────────────
    if (lower.startsWith("!decode")) {
      const text = userMessage.replace(/^!decode/i, "").trim();
      if (!text) { done(); await message.reply("Usage: `!decode your encoded text`"); return; }
      const result = solveMultiLayer(text);
      done();
      if (result) await sendChunks(message, `🔓 **Decode results:**\n\`\`\`\n${result}\n\`\`\``);
      else await message.reply("❌ Couldn't decode that. Try `!analyze` for a deeper scan.");
      return;
    }

    // ── 🆕 !weather ───────────────────────────────────────
    if (lower.startsWith("!weather")) {
      const city = userMessage.replace(/^!weather/i, "").trim();
      if (!city) { done(); await message.reply("Usage: `!weather city name`\nExample: `!weather Amman`"); return; }
      const w = await getWeather(city);
      done();
      if (!w) { await message.reply(`❌ Couldn't get weather for **${city}**. Check the city name.`); return; }
      await message.reply(`🌤️ **Weather in ${city}**\n\`\`\`\n${w.desc}\nTemp:     ${w.temp_c}°C / ${w.temp_f}°F\nFeels:    ${w.feels_c}°C\nHumidity: ${w.humidity}%\nWind:     ${w.wind} km/h\n\`\`\``);
      return;
    }

    // ── 🆕 !note ──────────────────────────────────────────
    if (lower.startsWith("!note")) {
      const input = userMessage.replace(/^!note/i, "").trim();
      const mentionedUser = message.mentions.users.first();
      if (lower.startsWith("!notes")) {
        // view notes about a user
        const target = mentionedUser || message.author;
        const res = await pool.query(`SELECT * FROM user_notes WHERE guild_id=$1 AND target_user_id=$2 ORDER BY created_at DESC LIMIT 10`, [message.guild.id, target.id]);
        done();
        if (!res.rows.length) { await message.reply(`No notes found for **${target.username}**.`); return; }
        let reply = `📋 **Notes about ${target.username}:**\n`;
        res.rows.forEach((n,i) => reply += `**${i+1}.** ${n.note} *(by <@${n.author_id}>)*\n`);
        await sendChunks(message, reply);
        return;
      }
      const note = input.replace(/<@!?\d+>/g, "").trim();
      if (!mentionedUser || !note) { done(); await message.reply("Usage: `!note @user their note` or `!notes @user` to view"); return; }
      await pool.query(`INSERT INTO user_notes (guild_id, target_user_id, author_id, note) VALUES ($1,$2,$3,$4)`, [message.guild.id, mentionedUser.id, userId, note]);
      done(); await message.reply(`📝 Note saved about **${mentionedUser.username}**: *"${note}"*`);
      return;
    }

    // ── GAMES ─────────────────────────────────────────────
    if (lower.startsWith("!roll")) { const s = parseInt(userMessage.replace(/^!roll/i,"").trim())||6; done(); await message.reply(`🎲 d${s} → **${Math.floor(Math.random()*s)+1}**!`); return; }
    if (lower.startsWith("!flip")) { done(); await message.reply(`🪙 **${Math.random()<0.5?"Heads":"Tails"}!**`); return; }
    if (lower.startsWith("!hangman")) { done(); await sendChunks(message, "🎮 **Hangman!**\n" + startHangman(userId)); return; }
    if (lower.startsWith("!numgame")||lower.startsWith("!numguess")) { const max=parseInt(userMessage.replace(/^!(numgame|numguess)/i,"").trim())||100; done(); await sendChunks(message, startNumberGame(userId,max)); return; }
    if (lower.startsWith("!scramble")) { done(); await sendChunks(message, startScramble(userId)); return; }
    if (lower.startsWith("!trivia")) { done(); await sendChunks(message, startTrivia(userId)); return; }
    if (lower.startsWith("!hint")) { done(); await sendChunks(message, hintTrivia(userId)); return; }
    if (lower.startsWith("!guess")) { const input=userMessage.replace(/^!guess/i,"").trim(); done(); await sendChunks(message, handleGuess(userId,input)); return; }

    // ── !remind ───────────────────────────────────────────
    if (lower.startsWith("!remind")) {
      const parts = userMessage.replace(/^!remind/i,"").trim();
      const tm = parts.match(/^(\d+\s*(?:s|sec|m|min|h|hr|d|day))\s+(.*)/i);
      if (!tm) { done(); await message.reply("Usage: `!remind 30m message`"); return; }
      const ms = parseRemindTime(tm[1]);
      await pool.query(`INSERT INTO reminders (user_id,channel_id,message,remind_at) VALUES ($1,$2,$3,$4)`, [userId, message.channel.id, tm[2], new Date(Date.now()+ms)]);
      done(); await message.reply(`⏰ Reminding you about **"${tm[2]}"** in **${tm[1]}**!`); return;
    }

    // ── !schedule ─────────────────────────────────────────
    if (lower.startsWith("!schedule")) {
      const input = userMessage.replace(/^!schedule/i,"").trim();
      if (input.toLowerCase() === "list") {
        const res = await pool.query(`SELECT * FROM scheduled_mentions WHERE user_id=$1 AND active=TRUE ORDER BY id`, [userId]);
        done();
        if (!res.rows.length) { await message.reply("No active schedules."); return; }
        await sendChunks(message, `📅 **Your schedules:**\n${res.rows.map(r=>`• ID **${r.id}**: "${r.message}" — ${r.label||"custom"}`).join("\n")}`);
        return;
      }
      const stopMatch = input.match(/^stop\s+(\d+)/i);
      if (stopMatch) { await pool.query(`UPDATE scheduled_mentions SET active=FALSE WHERE id=$1 AND user_id=$2`,[stopMatch[1],userId]); done(); await message.reply(`🛑 Stopped schedule #${stopMatch[1]}.`); return; }
      const interval = parseScheduleInterval(input);
      if (!interval) { done(); await message.reply("Usage: `!schedule every day message`"); return; }
      const msg = input.replace(/every\s+\w+(\s+\w+)?/i,"").trim() || "⚡ Zbor AI ping!";
      await pool.query(`INSERT INTO scheduled_mentions (user_id,channel_id,message,interval_ms,next_run,label) VALUES ($1,$2,$3,$4,$5,$6)`, [userId,message.channel.id,msg,interval.ms,new Date(Date.now()+interval.ms),interval.label]);
      done(); await message.reply(`📅 Set! I'll mention you **${interval.label}** with: *"${msg}"*`); return;
    }

    // ── !quote ────────────────────────────────────────────
    if (lower.startsWith("!quote save")) {
      const content = userMessage.replace(/^!quote save/i,"").trim();
      if (!content) { done(); await message.reply("Usage: `!quote save text`"); return; }
      await pool.query(`INSERT INTO quotes (guild_id,author,content) VALUES ($1,$2,$3)`, [message.guild.id,username,content]);
      done(); await message.reply(`💬 Saved: *"${content}"* — ${username}`); return;
    }
    if (lower.startsWith("!quote")) {
      const res = await pool.query(`SELECT * FROM quotes WHERE guild_id=$1 ORDER BY RANDOM() LIMIT 1`, [message.guild.id]);
      done();
      if (!res.rows.length) await message.reply("No quotes yet! Use `!quote save text`");
      else await message.reply(`💬 *"${res.rows[0].content}"* — **${res.rows[0].author}**`);
      return;
    }

    // ── !poll ─────────────────────────────────────────────
    if (lower.startsWith("!poll")) {
      const parts = userMessage.replace(/^!poll/i,"").trim().match(/"([^"]+)"/g);
      if (!parts||parts.length<3) { done(); await message.reply('Usage: `!poll "Q?" "A" "B"`'); return; }
      const question = parts[0].replace(/"/g,"");
      const options = parts.slice(1).map(p=>p.replace(/"/g,""));
      const emojis = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣"];
      let pollMsg = `📊 **POLL: ${question}**\n\n`;
      options.forEach((o,i) => pollMsg += `${emojis[i]} ${o}\n`);
      done();
      const sent = await message.channel.send(pollMsg);
      for (let i=0;i<options.length;i++) await sent.react(emojis[i]);
      await message.delete().catch(()=>{});
      return;
    }

    // ── !roast ────────────────────────────────────────────
    if (lower.startsWith("!roast")) {
      const target = userMessage.replace(/^!roast/i,"").trim() || username;
      const r = await callAI([{role:"user",content:`Roast "${target}" — funny, savage, creative, but not mean. Max 2 sentences.`}], 150);
      done(); await sendChunks(message, `🔥 ${r || "They're already roasted by life 💀"}`); return;
    }

    // ── !translate ────────────────────────────────────────
    if (lower.startsWith("!translate")) {
      const text = userMessage.replace(/^!translate/i,"").trim();
      if (!text) { done(); await message.reply("Usage: `!translate [lang] text`"); return; }
      const r = await callAI([{role:"user",content:`Translate. If a language is specified at the start, translate to that. Otherwise translate to English. Return ONLY the translation: "${text}"`}], 250);
      done(); await sendChunks(message, `🌍 **Translation:**\n${r}`); return;
    }

    // ── !summarize ────────────────────────────────────────
    if (lower.startsWith("!summarize")) {
      const text = userMessage.replace(/^!summarize/i,"").trim();
      if (!text) { done(); await message.reply("Paste text after `!summarize`"); return; }
      const r = await callAI([{role:"user",content:`Summarize in 3-5 bullet points, be concise:\n\n${text}`}], 350);
      done(); await sendChunks(message, `📝 **Summary:**\n${r}`); return;
    }

    // ── !announce ─────────────────────────────────────────
    if (lower.startsWith("!announce")) {
      const ann = userMessage.replace(/^!announce/i,"").trim();
      if (!ann) { done(); await message.reply("Usage: `!announce message`"); return; }
      done(); await message.channel.send(`📢 @everyone\n\n**${ann}**\n\n— ${username}`); return;
    }

    // ── !stats ────────────────────────────────────────────
    if (lower.startsWith("!stats")) {
      const target = message.mentions.users.first() || message.author;
      const profile = await getOrCreateProfile(target.id, target.username);
      const cnt = await pool.query(`SELECT COUNT(*) as total FROM conversations WHERE user_id=$1 AND role='user'`, [target.id]);
      const nickname = userNames[target.id] ? ` (aka **${userNames[target.id]}**)` : "";
      done(); await message.reply(`📊 **${target.username}${nickname}'s Stats**\n\`\`\`\nFirst seen:    ${profile.first_seen}\nMessages sent: ${cnt.rows[0].total}\n\`\`\``); return;
    }

    // ── !search ───────────────────────────────────────────
    if (lower.startsWith("!search")) {
      const query = userMessage.replace(/^!search/i,"").trim();
      if (!query) { done(); await message.reply("Usage: `!search query`"); return; }
      const sr = await webSearch(query);
      done();
      if (sr) await sendChunks(message, `🔍 **${query}**\n\n${sr}`);
      else { const r = await callAI([{role:"user",content:`Answer concisely: "${query}"`}], 350); await sendChunks(message, `🔍 **${query}**\n\n${r||"Couldn't find results."}`); }
      return;
    }

    // ── !youtube / !yt ────────────────────────────────────
    if (lower.startsWith("!youtube")||lower.startsWith("!yt")) {
      const query = userMessage.replace(/^!(youtube|yt)/i,"").trim();
      if (!query) { done(); await message.reply("Usage: `!youtube search`"); return; }
      const videos = await searchYouTube(query, 5);
      done();
      if (!videos?.length) { await message.reply(`❌ No results for **"${query}"**`); return; }
      let r = `📺 **YouTube: "${query}"**\n\n`;
      videos.forEach((v,i) => r += `**${i+1}.** [${v.title}](${v.url})\n   👤 ${v.channel}\n\n`);
      await sendChunks(message, r); return;
    }

    // ── !spotify ──────────────────────────────────────────
    if (lower.startsWith("!spotify")) {
      const query = userMessage.replace(/^!spotify/i,"").trim();
      if (!query) { done(); await message.reply("Usage: `!spotify song name`"); return; }
      const results = await searchSpotify(query);
      done();
      if (!results?.length) { await message.reply(`❌ Nothing found for **"${query}"**`); return; }
      let r = `🎵 **Spotify: "${query}"**\n\n`;
      results.forEach((x,i) => r += `**${i+1}.** ${x.name}${x.artist ? ` — ${x.artist}` : ""}\n   🔗 ${x.url}\n\n`);
      await sendChunks(message, r); return;
    }

    // ── !pdf ──────────────────────────────────────────────
    if (lower.startsWith("!pdf")) {
      const input = userMessage.replace(/^!pdf/i,"").trim();
      if (!input) { done(); await message.reply("Usage: `!pdf Title | Content`"); return; }
      const sep = input.indexOf("|");
      const title = sep>-1?input.slice(0,sep).trim():"Document";
      const content = sep>-1?input.slice(sep+1).trim():input;
      try { const fp=await generatePDF(title,content); done(); await message.reply({content:`📄 **${title}**`,files:[{attachment:fp,name:`${title.replace(/[^a-zA-Z0-9]/g,"_")}.pdf`}]}); fs.unlinkSync(fp); }
      catch(e) { done(); await message.reply(`❌ PDF failed: ${e.message}`); }
      return;
    }

    // ── !doc ──────────────────────────────────────────────
    if (lower.startsWith("!doc")) {
      const input = userMessage.replace(/^!doc/i,"").trim();
      if (!input) { done(); await message.reply("Usage: `!doc Title | Content`"); return; }
      const sep = input.indexOf("|");
      const title = sep>-1?input.slice(0,sep).trim():"Document";
      const content = sep>-1?input.slice(sep+1).trim():input;
      try { const fp=await generateDOCX(title,content); done(); await message.reply({content:`📝 **${title}**`,files:[{attachment:fp,name:`${title.replace(/[^a-zA-Z0-9]/g,"_")}.docx`}]}); fs.unlinkSync(fp); }
      catch(e) { done(); await message.reply(`❌ Doc failed: ${e.message}`); }
      return;
    }

    // ── !banner ───────────────────────────────────────────
    if (lower.startsWith("!banner")) {
      const input = userMessage.replace(/^!banner/i,"").trim();
      if (!input) { done(); await message.reply("Usage: `!banner Name | Subtitle | style`\nStyles: cyber fire nature ocean gold purple"); return; }
      const parts = input.split("|").map(p=>p.trim());
      const validStyles = ["cyber","fire","nature","ocean","gold","purple"];
      const style = validStyles.includes((parts[2]||"").toLowerCase()) ? parts[2].toLowerCase() : "cyber";
      try { const fp=generateBanner(parts[0]||username,parts[1]||"Zbor AI Member",style); done(); await message.reply({content:`🎨 **${style}** banner for **${parts[0]||username}**!`,files:[{attachment:fp,name:"banner.png"}]}); fs.unlinkSync(fp); }
      catch(e) { done(); await message.reply(`❌ Banner failed: ${e.message}`); }
      return;
    }

    // ── !imagine ──────────────────────────────────────────
    if (lower.startsWith("!imagine")||lower.startsWith("!image")) {
      const rawPrompt = userMessage.replace(/^!(imagine|image)/i,"").trim();
      if (!rawPrompt) { done(); await message.reply("Usage: `!imagine prompt` — add `--anime` `--realism` `--3d` `--turbo`"); return; }
      const styleMatch = rawPrompt.match(/--(\w+)/);
      const style = styleMatch?styleMatch[1].toLowerCase():"flux";
      const cleanPrompt = rawPrompt.replace(/--\w+/g,"").trim();
      try {
        const enhanced = await callAI([{role:"user",content:`Enhance this image prompt for AI art generation, return ONLY the improved prompt (max 80 words): "${cleanPrompt}"`}], 120);
        const result = await generateImageAdvanced(enhanced?.trim()||cleanPrompt, style);
        done(); await message.reply({content:`🎨 **"${cleanPrompt}"**`,files:[{attachment:result.url,name:"generated.png"}]});
      } catch(e) { done(); await message.reply(`❌ Image failed: ${e.message}`); }
      return;
    }

    // ── !logo ─────────────────────────────────────────────
    if (lower.startsWith("!logo")) {
      const concept = userMessage.replace(/^!logo/i,"").trim();
      if (!concept) { done(); await message.reply("Usage: `!logo concept`"); return; }
      try { const url=await generateLogo(concept); done(); await message.reply({content:`🏷️ **Logo: "${concept}"**`,files:[{attachment:url,name:"logo.png"}]}); }
      catch(e) { done(); await message.reply(`❌ Logo failed: ${e.message}`); }
      return;
    }

    // ── !weather ──────────────────────────────────────────
    if (lower.startsWith("!weather")) {
      const city = userMessage.replace(/^!weather/i,"").trim();
      if (!city) { done(); await message.reply("Usage: `!weather city`\nExample: `!weather Amman`"); return; }
      const w = await getWeather(city);
      done();
      if (!w) { await message.reply(`❌ Can't find weather for **${city}**.`); return; }
      await message.reply(`🌤️ **${city} — ${w.desc}**\n\`\`\`\nTemp:     ${w.temp_c}°C / ${w.temp_f}°F\nFeels:    ${w.feels_c}°C\nHumidity: ${w.humidity}%\nWind:     ${w.wind} km/h\n\`\`\``);
      return;
    }

    // ── !encode ───────────────────────────────────────────
    if (lower.startsWith("!encode")) {
      const parts = userMessage.replace(/^!encode/i,"").trim().split(" ");
      const method = parts[0]?.toLowerCase();
      const text = parts.slice(1).join(" ");
      const methods = ["base64","hex","binary","rot13","url","reverse"];
      if (!methods.includes(method) || !text) { done(); await message.reply(`Usage: \`!encode [method] text\`\nMethods: ${methods.join(", ")}`); return; }
      done(); await sendChunks(message, `🔒 **${method.toUpperCase()}:**\n\`\`\`\n${encodeText(text,method)}\n\`\`\``);
      return;
    }

    // ── !decode ───────────────────────────────────────────
    if (lower.startsWith("!decode")) {
      const text = userMessage.replace(/^!decode/i,"").trim();
      if (!text) { done(); await message.reply("Usage: `!decode encoded text`"); return; }
      const result = solveMultiLayer(text);
      done();
      if (result) await sendChunks(message, `🔓 **Decode:**\n\`\`\`\n${result}\n\`\`\``);
      else await message.reply("❌ Couldn't decode that. Try `!analyze` for deeper analysis.");
      return;
    }

    // ── !note / !notes ────────────────────────────────────
    if (lower.startsWith("!notes")) {
      const target = message.mentions.users.first() || message.author;
      const res = await pool.query(`SELECT * FROM user_notes WHERE guild_id=$1 AND target_user_id=$2 ORDER BY created_at DESC LIMIT 10`, [message.guild.id, target.id]);
      done();
      if (!res.rows.length) { await message.reply(`No notes for **${target.username}**.`); return; }
      let reply = `📋 **Notes about ${target.username}:**\n`;
      res.rows.forEach((n,i) => reply += `**${i+1}.** ${n.note} *(by <@${n.author_id}>)*\n`);
      await sendChunks(message, reply); return;
    }
    if (lower.startsWith("!note")) {
      const input = userMessage.replace(/^!note/i,"").trim();
      const mentionedUser = message.mentions.users.first();
      const note = input.replace(/<@!?\d+>/g,"").trim();
      if (!mentionedUser||!note) { done(); await message.reply("Usage: `!note @user their note`"); return; }
      await pool.query(`INSERT INTO user_notes (guild_id,target_user_id,author_id,note) VALUES ($1,$2,$3,$4)`, [message.guild.id,mentionedUser.id,userId,note]);
      done(); await message.reply(`📝 Note saved about **${mentionedUser.username}**!`); return;
    }

    // ── !help ─────────────────────────────────────────────
    if (lower.startsWith("!help")) {
      done();
      await sendChunks(message, `🤖 **Zbor AI — Full Command List**\`\`\`
🔐 CTF & Security
  !analyze [file/text]       — Full forensics + CTF analysis
  !hash [text]               — MD5 / SHA1 / SHA256 / SHA512
  !encode [method] [text]    — base64 hex binary rot13 url reverse
  !decode [text]             — Auto-detect and decode any encoding

🎨 AI & Creative
  !imagine [prompt]          — Generate AI image (--anime --realism --3d --turbo)
  !logo [concept]            — Generate a logo
  !banner [name|sub|style]   — Profile banner (cyber fire nature ocean gold purple)

📄 Documents
  !pdf [title|content]       — Generate a styled PDF
  !doc [title|content]       — Generate a Word document

🌐 Internet
  !search [query]            — Web search
  !youtube / !yt [query]     — Search YouTube
  !spotify [query]           — Search Spotify
  !weather [city]            — Current weather anywhere

🎮 Games
  !hangman                   — Word guessing game
  !numgame [max]             — Number guessing game
  !scramble                  — Word scramble
  !trivia                    — Tech & security trivia
  !guess [answer/letter]     — Guess in any active game
  !hint                      — Hint for trivia
  !roll [sides]              — Roll a dice (default d6)
  !flip                      — Flip a coin

⏰ Time & Automation
  !remind [time] [msg]       — One-time reminder (30m, 2h, 1d...)
  !schedule every day [msg]  — Recurring ping
  !schedule list             — View your schedules
  !schedule stop [id]        — Stop a schedule

🛠️ Utility
  !translate [lang] [text]   — Translate anything
  !summarize [text]          — Summarize in bullet points
  !roast [@user]             — Savage but friendly roast 🔥
  !poll "Q?" "A" "B"         — Reaction poll
  !quote                     — Random saved quote
  !quote save [text]         — Save a quote
  !note @user [note]         — Save a note about someone
  !notes @user               — View notes about someone
  !announce [msg]            — Ping @everyone
  !stats [@user]             — Message stats
  !help                      — This menu
\`\`\`
💬 Just chat normally — mention me for anything!
🏷️ **Name memory** (any channel): \`name this guy @user nickname\``);
      return;
    }

    // ── NORMAL CHAT ───────────────────────────────────────
    const profile = await getOrCreateProfile(userId, username);
    if (userMessage) await saveMessage(userId, username, "user", userMessage);
    const history = await getHistory(userId);

    // Auto-detect media requests
    const mediaCheck = detectMediaRequest(userMessage);
    if (mediaCheck.detected && images.size === 0 && allFiles.size === 0) {
      const suggestions = await getMediaSuggestions(userMessage, mediaCheck.mediaType, mediaCheck.genre);
      if (suggestions?.length > 0) {
        let r = `Here you go!\n\n`;
        suggestions.forEach((s,i) => r += `**${i+1}.** ${s.platform} — **${s.title}**${s.artist?` by *${s.artist}*`:""}\n   🔗 ${s.url}\n\n`);
        done(); await sendChunks(message, r); return;
      }
    }

    // Auto-detect schedule requests
    if (detectScheduleRequest(userMessage)) {
      const interval = parseScheduleInterval(userMessage);
      if (interval) {
        const msg = userMessage.replace(/mention\s+me|remind\s+me|ping\s+me/i,"").replace(/every\s+\w+(\s+\w+)?/i,"").trim() || "⚡ Zbor AI ping!";
        await pool.query(`INSERT INTO scheduled_mentions (user_id,channel_id,message,interval_ms,next_run,label) VALUES ($1,$2,$3,$4,$5,$6)`, [userId,message.channel.id,msg,interval.ms,new Date(Date.now()+interval.ms),interval.label]);
        done(); await message.reply(`📅 Done! I'll ping you **${interval.label}**. Use \`!schedule list\` to manage.`); return;
      }
    }

    // Build file context
    let fileContext = "";
    for (const [,f] of textFiles) { const c=await readFileContent(f.url); if (c) fileContext += `\n\n📄 ${f.name}:\n\`\`\`\n${c}\n\`\`\``; }
    for (const [,f] of pdfFiles) { const c=await readPdfContent(f.url); if (c?.trim()) fileContext += `\n\n📄 PDF ${f.name}:\n\`\`\`\n${c}\n\`\`\``; else fileContext += `\n\n📄 PDF "${f.name}" appears empty.`; }

    // Build nickname context
    const nicknameCtx = Object.keys(userNames).length > 0
      ? `Nicknames I know: ${Object.entries(userNames).map(([id,n])=>`<@${id}>=${n}`).join(", ")}. `
      : "";

    let userContent;
    if (images.size > 0) {
      userContent = [
        { type:"text", text:`${nicknameCtx}${userMessage||"What's in this image?"}${fileContext}` },
        ...images.map(img => ({ type:"image_url", image_url:{ url:img.url } })),
      ];
    } else {
      userContent = `${nicknameCtx}${userMessage||"Analyze the attached file."}${fileContext}`;
    }

    const reply = await callAI([...history, { role:"user", content:userContent }], 300);
    done();

    if (!reply) { await message.reply("All models down rn 😵 try again in a sec!"); return; }
    await saveMessage(userId, username, "assistant", reply);
    await sendChunks(message, reply);

  } catch (err) {
    console.error(err);
    try { await message.reply("Something broke. Try again!"); } catch {}
  } finally {
    processing.delete(message.id);
  }
});

initDB().then(() => discord.login(process.env.DISCORD_TOKEN));