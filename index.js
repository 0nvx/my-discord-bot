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
  ],
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const ALLOWED_CHANNEL_ID = "1479070011778797731";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

const MODELS = [
  "qwen/qwen3-235b-a22b:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "nvidia/llama-3.1-nemotron-70b-instruct:free",
  "openrouter/auto",
];

// ── ⚡ FASTER AI: Race all models with 15s timeout ────────────
async function callAI(messages, maxTokens = 600) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  const promises = MODELS.map(model =>
    fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    })
    .then(r => r.json())
    .then(data => {
      if (data.choices?.[0]?.message?.content) {
        console.log(`✅ First response from: ${model}`);
        clearTimeout(timeout);
        return data.choices[0].message.content;
      }
      throw new Error(`No valid response from ${model}`);
    })
    .catch(err => { console.log(`❌ ${model}: ${err.message}`); throw err; })
  );

  try { return await Promise.any(promises); }
  catch { clearTimeout(timeout); console.log("❌ All models failed"); return null; }
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      user_id TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW()
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
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message TEXT NOT NULL,
      interval_ms BIGINT NOT NULL,
      next_run TIMESTAMP NOT NULL,
      label TEXT,
      active BOOLEAN DEFAULT TRUE
    );
  `);
  console.log("✅ Database ready!");
}

async function getHistory(userId) {
  const res = await pool.query(`SELECT role, content FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`, [userId]);
  return res.rows.reverse();
}

async function saveMessage(userId, username, role, content) {
  await pool.query(`INSERT INTO conversations (user_id, username, role, content) VALUES ($1, $2, $3, $4)`, [userId, username, role, content]);
}

async function getOrCreateProfile(userId, username) {
  const res = await pool.query(`SELECT * FROM user_profiles WHERE user_id = $1`, [userId]);
  if (res.rows.length > 0) return res.rows[0];
  const firstSeen = new Date().toDateString();
  await pool.query(`INSERT INTO user_profiles (user_id, username, first_seen) VALUES ($1, $2, $3)`, [userId, username, firstSeen]);
  return { user_id: userId, username, first_seen: firstSeen };
}

// ── 🎵 SPOTIFY TOKEN ──────────────────────────────────────────
let spotifyToken = null;
let spotifyTokenExpiry = 0;

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
    const res = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=${type}&limit=3`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    const items = data[type === "track" ? "tracks" : type === "artist" ? "artists" : "albums"]?.items || [];
    return items.map(item => ({
      name: item.name,
      artist: item.artists?.[0]?.name || "",
      url: item.external_urls?.spotify,
      image: item.album?.images?.[0]?.url || item.images?.[0]?.url,
    })).filter(i => i.url);
  } catch { return null; }
}

// ── 📺 YOUTUBE SEARCH ─────────────────────────────────────────
async function searchYouTube(query, maxResults = 5) {
  try {
    if (YOUTUBE_API_KEY) {
      const apiUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}&key=${YOUTUBE_API_KEY}`;
      const res = await fetch(apiUrl);
      const data = await res.json();
      if (!data.items?.length) return null;
      return data.items.map(item => ({
        title: item.snippet.title,
        url: `https://youtu.be/${item.id.videoId}`,
        channel: item.snippet.channelTitle,
      }));
    } else {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
      const res = await fetch(searchUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
      });
      const html = await res.text();
      const jsonMatch = html.match(/var ytInitialData = ({.+?});<\/script>/);
      if (!jsonMatch) return null;
      const ytData = JSON.parse(jsonMatch[1]);
      const contents = ytData?.contents?.twoColumnSearchResultsRenderer?.primaryContents
        ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];
      const videos = [];
      for (const item of contents) {
        if (item.videoRenderer) {
          const v = item.videoRenderer;
          const title = v.title?.runs?.[0]?.text || "Unknown Title";
          const videoId = v.videoId;
          const channel = v.ownerText?.runs?.[0]?.text || "Unknown";
          if (videoId) videos.push({ title, url: `https://youtu.be/${videoId}`, channel });
          if (videos.length >= maxResults) break;
        }
      }
      return videos.length > 0 ? videos : null;
    }
  } catch (err) { console.error("YouTube search error:", err.message); return null; }
}

// ── 🎵 SMART MEDIA DETECTION ──────────────────────────────────
// Detects if user is asking for music/video/movie recommendations in normal chat
const MEDIA_TRIGGERS = [
  /suggest\s+(me\s+)?(a\s+|some\s+)?(song|songs|music|track|tracks|playlist|album|albums|video|videos|movie|movies|film|films|anime|show|series|podcast)/i,
  /recommend\s+(me\s+)?(a\s+|some\s+)?(song|songs|music|track|tracks|playlist|album|albums|video|videos|movie|movies|film|films)/i,
  /(good|best|top|popular|trending|nice|chill|sad|happy|hype|pump)\s+(song|songs|music|track|tracks|playlist|video|videos|movie|movies|film|films|anime)/i,
  /what\s+(should\s+i|to)\s+(listen|watch|play)/i,
  /i\s+(wanna|want\s+to|need\s+to)\s+(listen|watch|hear)/i,
  /(listen|watching|watch)\s+to\s+some/i,
  /give\s+me\s+(a\s+|some\s+)?(song|music|track|video|movie|film)/i,
  /play\s+(something|some|a)/i,
  /(song|music)\s+(recommendation|suggestions?)/i,
];

const MEDIA_TYPE_MAP = {
  song: "track", songs: "track", music: "track", track: "track", tracks: "track",
  album: "album", albums: "album", playlist: "playlist",
  video: "video", videos: "video",
  movie: "video", movies: "video", film: "video", films: "video",
  anime: "video", show: "video", series: "video",
};

function detectMediaRequest(text) {
  for (const pattern of MEDIA_TRIGGERS) {
    if (pattern.test(text)) {
      // Extract what type of media
      const typeMatch = text.match(/(song|songs|music|track|tracks|album|albums|playlist|video|videos|movie|movies|film|films|anime|show|series|podcast)/i);
      const mediaType = typeMatch ? MEDIA_TYPE_MAP[typeMatch[0].toLowerCase()] || "track" : "track";

      // Try to extract genre or mood or artist
      const genreMoods = ["pop", "rock", "rap", "hip hop", "jazz", "classical", "lofi", "lo-fi", "chill", "sad", "happy",
        "hype", "workout", "study", "sleep", "arabic", "arabic pop", "k-pop", "edm", "r&b", "rnb", "metal", "indie",
        "romantic", "party", "calm", "relaxing", "motivational", "gym"];
      let genre = "";
      for (const g of genreMoods) {
        if (text.toLowerCase().includes(g)) { genre = g; break; }
      }

      return { detected: true, mediaType, genre };
    }
  }
  return { detected: false };
}

async function getMediaSuggestions(userMessage, mediaType, genre) {
  // Ask AI to suggest specific titles, then search for them
  const aiPrompt = `The user said: "${userMessage}"
They want ${mediaType} recommendations${genre ? ` with a "${genre}" vibe/genre` : ""}.
Reply with ONLY a JSON array of 3 search queries to find on YouTube/Spotify. Example:
["Dua Lipa Levitating", "The Weeknd Blinding Lights", "Harry Styles Watermelon Sugar"]
No explanation, just the JSON array.`;

  const aiResponse = await callAI([{ role: "user", content: aiPrompt }], 200);
  let queries = [];
  try {
    const cleaned = aiResponse?.replace(/```json|```/g, "").trim();
    queries = JSON.parse(cleaned);
  } catch { queries = [genre ? `${genre} ${mediaType}` : `popular ${mediaType} 2024`]; }

  const results = [];

  // Try Spotify first for music
  if (mediaType === "track" || mediaType === "album") {
    for (const q of queries.slice(0, 3)) {
      const spotify = await searchSpotify(q, mediaType === "album" ? "album" : "track");
      if (spotify?.[0]) {
        results.push({ platform: "Spotify 🎵", title: spotify[0].name, artist: spotify[0].artist, url: spotify[0].url });
      }
    }
  }

  // YouTube for videos or as fallback
  const ytQuery = queries[0] || (genre ? `${genre} ${mediaType}` : `best ${mediaType}`);
  const ytResults = await searchYouTube(ytQuery, 3);
  if (ytResults) {
    ytResults.slice(0, 3).forEach(v => {
      results.push({ platform: "YouTube 📺", title: v.title, artist: v.channel, url: v.url });
    });
  }

  return results;
}

// ── ⏰ SCHEDULED MENTIONS ─────────────────────────────────────
function parseScheduleInterval(str) {
  // e.g. "every day", "every 2 hours", "every 30 minutes", "every week"
  const patterns = [
    { regex: /every\s+day|daily/i, ms: 86400000, label: "daily" },
    { regex: /every\s+week|weekly/i, ms: 604800000, label: "weekly" },
    { regex: /every\s+hour/i, ms: 3600000, label: "every hour" },
    { regex: /every\s+(\d+)\s*(minute|min|m)\b/i, ms: null, label: null },
    { regex: /every\s+(\d+)\s*(hour|hr|h)\b/i, ms: null, label: null },
    { regex: /every\s+(\d+)\s*(day|d)\b/i, ms: null, label: null },
  ];

  for (const p of patterns) {
    const match = str.match(p.regex);
    if (match) {
      if (p.ms) return { ms: p.ms, label: p.label };
      const val = parseInt(match[1]);
      const unit = match[2].toLowerCase();
      const multiplier = unit.startsWith("m") ? 60000 : unit.startsWith("h") ? 3600000 : 86400000;
      return { ms: val * multiplier, label: `every ${val} ${unit}` };
    }
  }
  return null;
}

// Detect if someone is asking to be mentioned/reminded on a schedule in chat
function detectScheduleRequest(text) {
  const patterns = [
    /mention\s+me\s+(every\s+\w+|\w+ly)/i,
    /remind\s+me\s+(every\s+\w+|\w+ly)/i,
    /ping\s+me\s+(every\s+\w+|\w+ly)/i,
    /tell\s+me\s+(every\s+\w+|\w+ly)/i,
    /every\s+(day|week|hour|\d+\s*(minute|hour|day))/i,
  ];
  return patterns.some(p => p.test(text));
}

async function checkScheduledMentions() {
  try {
    const res = await pool.query(`SELECT * FROM scheduled_mentions WHERE next_run <= NOW() AND active = TRUE`);
    for (const row of res.rows) {
      try {
        const channel = await discord.channels.fetch(row.channel_id);
        await channel.send(`⏰ <@${row.user_id}> ${row.message}`);
        const nextRun = new Date(Date.now() + Number(row.interval_ms));
        await pool.query(`UPDATE scheduled_mentions SET next_run = $1 WHERE id = $2`, [nextRun, row.id]);
      } catch (e) { console.error("Schedule send error:", e.message); }
    }
  } catch (e) { console.error("Schedule check error:", e.message); }
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
    const res = await pool.query(`SELECT * FROM reminders WHERE remind_at <= NOW() AND done = FALSE`);
    for (const row of res.rows) {
      try {
        const channel = await discord.channels.fetch(row.channel_id);
        await channel.send(`⏰ <@${row.user_id}> Reminder: **${row.message}**`);
        await pool.query(`UPDATE reminders SET done = TRUE WHERE id = $1`, [row.id]);
      } catch (e) { console.error("Reminder send error:", e.message); }
    }
  } catch (e) { console.error("Reminder check error:", e.message); }
}

// ── 🎮 GAMES ──────────────────────────────────────────────────
const hangmanWords = ["cybersecurity", "discord", "javascript", "python", "hacking", "encryption",
  "firewall", "noshelter", "algorithm", "database", "blockchain", "cryptocurrency", "artificial", "intelligence"];
const activeGames = {};

function startHangman(userId) {
  const word = hangmanWords[Math.floor(Math.random() * hangmanWords.length)];
  activeGames[userId] = { type: "hangman", word, guessed: [], wrong: 0, maxWrong: 6 };
  return renderHangman(userId);
}

function renderHangman(userId) {
  const game = activeGames[userId];
  if (!game || game.type !== "hangman") return null;

  // FIX: spaces between letters so missing ones are clearly visible
  const display = game.word.split("").map(c => game.guessed.includes(c) ? c : "_").join("  ");
  const wrongLetters = game.guessed.filter(c => !game.word.includes(c)).join("  ");

  const gallows = [
    "```\n  +---+\n  |   |\n      |\n      |\n      |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n      |\n      |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n  |   |\n      |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n /|   |\n      |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n /|\\  |\n      |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n /|\\  |\n /    |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n /|\\  |\n / \\  |\n      |\n=========```",
  ];

  let status = gallows[game.wrong];
  status += `\n**Word:** \`${display}\``;
  status += `\n**Wrong letters (${game.wrong}/${game.maxWrong}):** ${wrongLetters || "none yet"}`;
  status += `\n**Letters left:** ${Math.max(0, 6 - game.wrong)} chances`;

  const won = !game.word.split("").some(c => !game.guessed.includes(c));
  if (won) { delete activeGames[userId]; return status + "\n\n🎉 **You won! Nice one!**"; }
  if (game.wrong >= game.maxWrong) { const w = game.word; delete activeGames[userId]; return status + `\n\n💀 **Game over!** The word was: **${w}**`; }
  return status + "\n\nGuess a letter: `!guess X`";
}

function guessHangman(userId, letter) {
  const game = activeGames[userId];
  if (!game || game.type !== "hangman") return "No active hangman game! Start one with `!hangman`";
  letter = letter.toLowerCase();
  if (!/^[a-z]$/.test(letter)) return "Please guess a single letter!";
  if (game.guessed.includes(letter)) return `Already guessed **${letter.toUpperCase()}**! Try a different letter.`;
  game.guessed.push(letter);
  if (!game.word.includes(letter)) game.wrong++;
  return renderHangman(userId);
}

// ── 🔢 NUMBER GUESSING GAME ──────────────────────────────────
function startNumberGame(userId, max = 100) {
  const target = Math.floor(Math.random() * max) + 1;
  activeGames[userId] = { type: "number", target, max, attempts: 0, maxAttempts: 8 };
  return `🔢 **Number Guessing Game!**\nI'm thinking of a number between **1 and ${max}**.\nYou have **${8} attempts**. Type \`!guess [number]\` to guess!`;
}

function guessNumber(userId, input) {
  const game = activeGames[userId];
  if (!game || game.type !== "number") return null;
  const guess = parseInt(input);
  if (isNaN(guess)) return "That's not a number! Use `!guess 42`";
  game.attempts++;
  const remaining = game.maxAttempts - game.attempts;
  if (guess === game.target) {
    delete activeGames[userId];
    return `🎉 **Correct! The number was ${game.target}!** You got it in **${game.attempts}** attempts!`;
  }
  if (game.attempts >= game.maxAttempts) {
    const t = game.target; delete activeGames[userId];
    return `💀 **Out of attempts!** The number was **${t}**. Better luck next time!`;
  }
  const hint = guess < game.target ? "📈 **Too low!**" : "📉 **Too high!**";
  return `${hint} Attempts left: **${remaining}**. Guess again with \`!guess [number]\``;
}

// ── 🔀 WORD SCRAMBLE GAME ─────────────────────────────────────
const scrambleWords = ["python", "discord", "hacker", "keyboard", "monitor", "network", "database",
  "javascript", "server", "browser", "password", "firewall", "algorithm", "terminal", "compiler"];

function scrambleWord(word) {
  const arr = word.split("");
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const result = arr.join("");
  return result === word ? scrambleWord(word) : result; // re-scramble if same
}

function startScramble(userId) {
  const word = scrambleWords[Math.floor(Math.random() * scrambleWords.length)];
  const scrambled = scrambleWord(word);
  activeGames[userId] = { type: "scramble", word, scrambled, attempts: 0, maxAttempts: 3 };
  return `🔀 **Word Scramble!**\nUnscramble this: **\`${scrambled.toUpperCase()}\`**\nUse \`!guess [your answer]\` — you have **3 attempts**!`;
}

function guessScramble(userId, input) {
  const game = activeGames[userId];
  if (!game || game.type !== "scramble") return null;
  game.attempts++;
  const remaining = game.maxAttempts - game.attempts;
  if (input.toLowerCase() === game.word) {
    delete activeGames[userId];
    return `🎉 **Correct!** The word was **${game.word}**! You got it in ${game.attempts} attempt${game.attempts !== 1 ? "s" : ""}!`;
  }
  if (game.attempts >= game.maxAttempts) {
    const w = game.word; delete activeGames[userId];
    return `💀 **Out of guesses!** The word was **${w}**. The scramble was: \`${game.scrambled.toUpperCase()}\``;
  }
  return `❌ Wrong! Attempts left: **${remaining}**. The scramble: **\`${game.scrambled.toUpperCase()}\`** — try again with \`!guess [answer]\``;
}

// ── 🧠 TRIVIA GAME ────────────────────────────────────────────
const triviaQuestions = [
  { q: "What does HTTP stand for?", a: "hypertext transfer protocol", hint: "It's a web protocol" },
  { q: "What language runs in web browsers?", a: "javascript", hint: "It's not Java 👀" },
  { q: "How many bits are in a byte?", a: "8", hint: "Less than 10" },
  { q: "What does CPU stand for?", a: "central processing unit", hint: "It's the brain of a computer" },
  { q: "What does SQL stand for?", a: "structured query language", hint: "Used for databases" },
  { q: "Which company made Discord?", a: "discord inc", hint: "They renamed themselves after the app" },
  { q: "What does DNS stand for?", a: "domain name system", hint: "It translates URLs to IP addresses" },
  { q: "What is the most used programming language in 2024?", a: "javascript", hint: "Runs everywhere" },
  { q: "What does VPN stand for?", a: "virtual private network", hint: "Privacy tool" },
  { q: "What year was Python created?", a: "1991", hint: "Early 90s" },
  { q: "What does RAM stand for?", a: "random access memory", hint: "It's temporary storage" },
  { q: "What does API stand for?", a: "application programming interface", hint: "Used to connect services" },
];

function startTrivia(userId) {
  const q = triviaQuestions[Math.floor(Math.random() * triviaQuestions.length)];
  activeGames[userId] = { type: "trivia", ...q, hintUsed: false, attempts: 0, maxAttempts: 2 };
  return `🧠 **Trivia Time!**\n**Q:** ${q.q}\n\nUse \`!guess [answer]\` to answer or \`!hint\` for a clue!`;
}

function hintTrivia(userId) {
  const game = activeGames[userId];
  if (!game || game.type !== "trivia") return "No active trivia game! Start one with `!trivia`";
  game.hintUsed = true;
  return `💡 **Hint:** ${game.hint}`;
}

function guessTrivia(userId, input) {
  const game = activeGames[userId];
  if (!game || game.type !== "trivia") return null;
  game.attempts++;
  const correct = input.toLowerCase().includes(game.a.toLowerCase()) || game.a.toLowerCase().includes(input.toLowerCase());
  if (correct) {
    delete activeGames[userId];
    const bonus = game.hintUsed ? "" : " (no hint used! 🔥)";
    return `✅ **Correct!** The answer was: **${game.a}**${bonus}`;
  }
  if (game.attempts >= game.maxAttempts) {
    const ans = game.a; delete activeGames[userId];
    return `❌ **Wrong!** The correct answer was: **${ans}**. Better luck next time!`;
  }
  return `❌ **Wrong!** One more chance! ${!game.hintUsed ? "Use `!hint` if you need help." : ""}`;
}

// ── Universal guess handler ───────────────────────────────────
function handleGuess(userId, input) {
  const game = activeGames[userId];
  if (!game) return "You don't have an active game! Start one with `!hangman`, `!numgame`, `!scramble`, or `!trivia`";

  if (game.type === "hangman") {
    return guessHangman(userId, input.charAt(0));
  } else if (game.type === "number") {
    return guessNumber(userId, input);
  } else if (game.type === "scramble") {
    return guessScramble(userId, input);
  } else if (game.type === "trivia") {
    return guessTrivia(userId, input);
  }
  return "Unknown game state. Start a new game!";
}

// ── HASH TOOLS ───────────────────────────────────────────────
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
    "FFD8FF": "JPEG Image", "89504E47": "PNG Image", "47494638": "GIF Image",
    "25504446": "PDF Document", "504B0304": "ZIP Archive", "7F454C46": "ELF Binary (Linux executable)",
    "4D5A": "PE/EXE Binary (Windows executable)", "1F8B": "GZIP Archive",
    "52617221": "RAR Archive", "75737461": "TAR Archive", "3C3F786D": "XML File",
    "3C21444F": "HTML File", "424D": "BMP Image", "664C6143": "FLAC Audio", "49443303": "MP3 Audio",
  };
  for (const [sig, name] of Object.entries(sigs)) { if (hex.startsWith(sig)) return name; }
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
    for (let i = 0; i < clean.length; i += 8) result += String.fromCharCode(parseInt(clean.slice(i, i + 8), 2));
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
    ".-":"A","-...":"B","-.-.":"C","-..":"D",".":"E","..-.":"F","--.":"G","....":"H","..":"I",
    ".---":"J","-.-":"K",".-..":"L","--":"M","-.":"N","---":"O",".--.":"P","--.-":"Q",".-.":"R",
    "...":"S","-":"T","..-":"U","...-":"V",".--":"W","-..-":"X","-.--":"Y","--..":"Z",
    "-----":"0",".----":"1","..---":"2","...--":"3","....-":"4",".....":"5",
    "-....":"6","--...":"7","---..":"8","----.":"9",
  };
  try {
    if (!/^[.\-\s\/]+$/.test(str)) return null;
    const words = str.trim().split(" / ");
    return words.map(w => w.split(" ").map(c => morseMap[c] || "?").join("")).join(" ");
  } catch { return null; }
}

function tryUrlDecode(str) {
  try { const decoded = decodeURIComponent(str); if (decoded === str) return null; return decoded; }
  catch { return null; }
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
  const patterns = [/[A-Za-z0-9_]+\{[^}]+\}/g, /flag\{[^}]+\}/gi, /ctf\{[^}]+\}/gi, /Noshelter\{[^}]+\}/gi];
  const found = new Set();
  for (const pattern of patterns) { const matches = text.match(pattern) || []; matches.forEach(m => found.add(m)); }
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
  if (jwtMatch) { const jwt = decodeJWT(jwtMatch[0]); if (jwt) report += `🔑 JWT TOKEN FOUND:\n  Header: ${JSON.stringify(jwt.header)}\n  Payload: ${JSON.stringify(jwt.payload)}\n\n`; }
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

// ── 🌐 WEB SEARCH ─────────────────────────────────────────────
async function webSearch(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { headers: { "User-Agent": "ZborAI-Discord-Bot/1.0" } });
    const data = await res.json();
    let result = "";
    if (data.Answer) result += `💡 **Answer:** ${data.Answer}\n\n`;
    if (data.AbstractText) result += `📖 ${data.AbstractText}\n`;
    if (!result && data.RelatedTopics?.length > 0) {
      result += `🔍 **Top results for "${query}":**\n`;
      data.RelatedTopics.slice(0, 5).forEach(t => { if (t.Text) result += `• ${t.Text}\n`; });
    }
    const sourceUrl = data.AbstractURL || (data.RelatedTopics?.[0]?.FirstURL) || null;
    if (sourceUrl) result += `\n🔗 ${sourceUrl}`;
    return result.trim() || null;
  } catch (err) { console.error("Search error:", err.message); return null; }
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
    doc.fillColor("#888888").fontSize(10).font("Helvetica")
       .text(`Generated on ${new Date().toLocaleString()} by Zbor AI`, { align: "center" });
    doc.moveDown(1);
    doc.fillColor("#222222").fontSize(11).font("Helvetica").text(content, { align: "left", lineGap: 5 });
    const footerY = doc.page.height - 45;
    doc.moveTo(50, footerY - 8).lineTo(doc.page.width - 50, footerY - 8).strokeColor("#cccccc").lineWidth(1).stroke();
    doc.fillColor("#aaaaaa").fontSize(9).text(`Zbor AI  •  ${new Date().toLocaleDateString()}`, 50, footerY, { align: "center" });
    doc.end();
    stream.on("finish", () => resolve(tmpPath));
    stream.on("error", reject);
  });
}

// ── 📝 WORD DOC GENERATION ────────────────────────────────────
async function generateDOCX(title, content) {
  const tmpPath = `/tmp/zbor_${Date.now()}.docx`;
  const lines = content.split("\n").filter(l => l.trim());
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          children: [new TextRun({ text: "⚡ ZBOR AI — Generated Document", bold: true, size: 28, color: "00d4ff" })],
          alignment: AlignmentType.CENTER,
          spacing: { after: 100 },
        }),
        new Paragraph({
          children: [new TextRun({ text: title, bold: true, size: 36, color: "1a1a2e" })],
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 300, after: 200 },
        }),
        new Paragraph({
          children: [new TextRun({ text: `Generated on ${new Date().toLocaleString()}`, color: "888888", size: 18, italics: true })],
          spacing: { after: 400 },
        }),
        ...lines.map(line =>
          new Paragraph({
            children: [new TextRun({ text: line, size: 22 })],
            spacing: { after: 150 },
          })
        ),
        new Paragraph({
          children: [new TextRun({ text: "— Generated by Zbor AI", italics: true, color: "888888", size: 18 })],
          alignment: AlignmentType.RIGHT,
          spacing: { before: 600 },
        }),
      ],
    }],
  });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(tmpPath, buffer);
  return tmpPath;
}

// ── 🖼️ BANNER GENERATION ──────────────────────────────────────
function generateBanner(name, subtitle = "Zbor AI Member", style = "cyber") {
  const width = 900, height = 300;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const themes = {
    cyber:  { bg1: "#0d0d1a", bg2: "#1a1a3e", accent: "#00d4ff", accent2: "#ff00ff", text: "#ffffff", sub: "#00d4ff" },
    fire:   { bg1: "#1a0000", bg2: "#3d0000", accent: "#ff4500", accent2: "#ff8c00", text: "#ffffff", sub: "#ff6600" },
    nature: { bg1: "#001a00", bg2: "#003300", accent: "#00ff88", accent2: "#00cc44", text: "#ffffff", sub: "#00ff88" },
    ocean:  { bg1: "#000d1a", bg2: "#001a33", accent: "#0099ff", accent2: "#00ccff", text: "#ffffff", sub: "#66ccff" },
    gold:   { bg1: "#1a1000", bg2: "#2d1f00", accent: "#ffd700", accent2: "#ffaa00", text: "#ffffff", sub: "#ffd700" },
  };
  const s = themes[style] || themes.cyber;
  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, s.bg1); bgGrad.addColorStop(1, s.bg2);
  ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = s.accent + "18"; ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 45) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  for (let y = 0; y < height; y += 45) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
  const addGlow = (x, y, r, color) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color + "44"); g.addColorStop(1, "transparent");
    ctx.fillStyle = g; ctx.fillRect(0, 0, width, height);
  };
  addGlow(140, 150, 160, s.accent); addGlow(760, 150, 130, s.accent2);
  const barGrad = ctx.createLinearGradient(0, 0, 0, height);
  barGrad.addColorStop(0, s.accent); barGrad.addColorStop(1, s.accent2);
  ctx.fillStyle = barGrad; ctx.fillRect(0, 0, 6, height);
  const ax = 105, ay = 150, ar = 72;
  ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2);
  ctx.fillStyle = s.bg2; ctx.fill();
  ctx.strokeStyle = s.accent; ctx.lineWidth = 3; ctx.stroke();
  const initials = name.trim().split(/\s+/).map(w => w[0]?.toUpperCase() || "").slice(0, 2).join("");
  ctx.fillStyle = s.accent; ctx.font = "bold 44px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(initials, ax, ay);
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  const fontSize = name.length > 16 ? 36 : name.length > 10 ? 46 : 54;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.fillStyle = s.text;
  ctx.shadowColor = s.accent; ctx.shadowBlur = 14;
  ctx.fillText(name, 205, 133);
  ctx.shadowBlur = 0;
  ctx.font = "22px sans-serif"; ctx.fillStyle = s.sub;
  ctx.fillText(subtitle, 205, 170);
  const divGrad = ctx.createLinearGradient(205, 0, width - 40, 0);
  divGrad.addColorStop(0, s.accent); divGrad.addColorStop(1, s.accent2);
  ctx.strokeStyle = divGrad; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(205, 197); ctx.lineTo(width - 40, 197); ctx.stroke();
  ctx.font = "15px sans-serif"; ctx.fillStyle = s.accent + "bb";
  ctx.fillText(`⚡ Zbor AI  •  Discord  •  ${new Date().getFullYear()}`, 205, 225);
  ctx.textAlign = "right"; ctx.font = "13px sans-serif"; ctx.fillStyle = s.accent + "55";
  ctx.fillText("Generated by Zbor AI", width - 18, height - 14);
  const tmpPath = `/tmp/banner_${Date.now()}.png`;
  fs.writeFileSync(tmpPath, canvas.toBuffer("image/png"));
  return tmpPath;
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
  const res = await fetch(url);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function readFileContent(url) {
  try { const res = await fetch(url); return (await res.text()).slice(0, 8000); }
  catch { return null; }
}

async function readPdfContent(url) {
  try {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const data = await pdfParse(Buffer.from(buffer));
    let metadata = "";
    if (data.info) { metadata += "[PDF METADATA]\n"; for (const [key, val] of Object.entries(data.info)) metadata += `${key}: ${val}\n`; }
    return (metadata + "\n[PDF TEXT]\n" + data.text).slice(0, 8000);
  } catch { return null; }
}

const TEXT_EXTENSIONS = [
  ".txt", ".md", ".js", ".ts", ".py", ".html", ".css", ".json", ".csv",
  ".xml", ".yaml", ".yml", ".java", ".c", ".cpp", ".cs", ".php", ".rb",
  ".go", ".rs", ".sql", ".sh", ".bat", ".env", ".log"
];

const processing = new Set();

discord.on("ready", () => {
  console.log(`✅ Bot is online as Zbor AI`);
  setInterval(checkReminders, 30000);
  setInterval(checkScheduledMentions, 30000);
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

  if (!userMessage && images.size === 0 && allFiles.size === 0) { processing.delete(message.id); return; }

  try {
    const typingInterval = setInterval(() => message.channel.sendTyping(), 8000);
    await message.channel.sendTyping();

    // ── !analyze ──────────────────────────────────────────────
    if (lower.startsWith("!analyze")) {
      const analyzeInput = userMessage.replace(/^!analyze/i, "").trim();
      let analysisResults = [];
      if (allFiles.size > 0) {
        for (const [, file] of allFiles) {
          try { const buf = await fetchBuffer(file.url); analysisResults.push(await runAnalysis(buf, file.name)); }
          catch (e) { analysisResults.push(`❌ Could not analyze ${file.name}: ${e.message}`); }
        }
      }
      if (analyzeInput.length > 0) { const buf = Buffer.from(analyzeInput, "utf8"); analysisResults.push(await runAnalysis(buf, "pasted_text.txt")); }
      if (analysisResults.length === 0) { await message.reply("Attach a file or paste text after `!analyze`!"); clearInterval(typingInterval); processing.delete(message.id); return; }
      clearInterval(typingInterval);
      for (const result of analysisResults) await sendChunks(message, result);
      processing.delete(message.id); return;
    }

    // ── !hash ─────────────────────────────────────────────────
    if (lower.startsWith("!hash")) {
      const text = userMessage.replace(/^!hash/i, "").trim();
      if (!text) { await message.reply("Usage: `!hash your text here`"); clearInterval(typingInterval); processing.delete(message.id); return; }
      const h = hashText(text);
      clearInterval(typingInterval);
      await sendChunks(message, `🔐 **Hash results for:** \`${text}\`\n\`\`\`\nMD5:    ${h.md5}\nSHA1:   ${h.sha1}\nSHA256: ${h.sha256}\nSHA512: ${h.sha512}\n\`\`\``);
      processing.delete(message.id); return;
    }

    // ── !roll ─────────────────────────────────────────────────
    if (lower.startsWith("!roll")) {
      const sides = parseInt(userMessage.replace(/^!roll/i, "").trim()) || 6;
      clearInterval(typingInterval);
      await message.reply(`🎲 Rolled a **d${sides}** — you got **${Math.floor(Math.random() * sides) + 1}**!`);
      processing.delete(message.id); return;
    }

    // ── !flip ─────────────────────────────────────────────────
    if (lower.startsWith("!flip")) {
      clearInterval(typingInterval);
      await message.reply(`🪙 **${Math.random() < 0.5 ? "Heads" : "Tails"} 🪙**`);
      processing.delete(message.id); return;
    }

    // ── !hangman ──────────────────────────────────────────────
    if (lower.startsWith("!hangman")) {
      clearInterval(typingInterval);
      await sendChunks(message, "🎮 **Hangman started!**\n" + startHangman(userId));
      processing.delete(message.id); return;
    }

    // ── !numgame / !numguess ──────────────────────────────────
    if (lower.startsWith("!numgame") || lower.startsWith("!numguess")) {
      const maxStr = userMessage.replace(/^!(numgame|numguess)/i, "").trim();
      const max = parseInt(maxStr) || 100;
      clearInterval(typingInterval);
      await sendChunks(message, startNumberGame(userId, max));
      processing.delete(message.id); return;
    }

    // ── !scramble ─────────────────────────────────────────────
    if (lower.startsWith("!scramble")) {
      clearInterval(typingInterval);
      await sendChunks(message, startScramble(userId));
      processing.delete(message.id); return;
    }

    // ── !trivia ───────────────────────────────────────────────
    if (lower.startsWith("!trivia")) {
      clearInterval(typingInterval);
      await sendChunks(message, startTrivia(userId));
      processing.delete(message.id); return;
    }

    // ── !hint ─────────────────────────────────────────────────
    if (lower.startsWith("!hint")) {
      clearInterval(typingInterval);
      await sendChunks(message, hintTrivia(userId));
      processing.delete(message.id); return;
    }

    // ── !guess ────────────────────────────────────────────────
    if (lower.startsWith("!guess")) {
      const input = userMessage.replace(/^!guess/i, "").trim();
      clearInterval(typingInterval);
      await sendChunks(message, handleGuess(userId, input));
      processing.delete(message.id); return;
    }

    // ── !remind ───────────────────────────────────────────────
    if (lower.startsWith("!remind")) {
      const parts = userMessage.replace(/^!remind/i, "").trim();
      const timeMatch = parts.match(/^(\d+\s*(?:s|sec|m|min|h|hr|d|day))\s+(.*)/i);
      if (!timeMatch) { clearInterval(typingInterval); await message.reply("Usage: `!remind 30m your reminder message`"); processing.delete(message.id); return; }
      const ms = parseRemindTime(timeMatch[1]);
      const remindAt = new Date(Date.now() + ms);
      await pool.query(`INSERT INTO reminders (user_id, channel_id, message, remind_at) VALUES ($1, $2, $3, $4)`, [userId, message.channel.id, timeMatch[2], remindAt]);
      clearInterval(typingInterval);
      await message.reply(`⏰ Got it! I'll remind you about **"${timeMatch[2]}"** in **${timeMatch[1]}**!`);
      processing.delete(message.id); return;
    }

    // ── !schedule ─────────────────────────────────────────────
    if (lower.startsWith("!schedule")) {
      const input = userMessage.replace(/^!schedule/i, "").trim();

      // !schedule list
      if (input.toLowerCase() === "list") {
        const res = await pool.query(`SELECT * FROM scheduled_mentions WHERE user_id = $1 AND active = TRUE ORDER BY id`, [userId]);
        clearInterval(typingInterval);
        if (res.rows.length === 0) { await message.reply("You have no active scheduled mentions."); processing.delete(message.id); return; }
        let list = `📅 **Your scheduled mentions:**\n`;
        res.rows.forEach(r => list += `  • ID **${r.id}**: "${r.message}" — ${r.label || "custom interval"}\n`);
        await sendChunks(message, list);
        processing.delete(message.id); return;
      }

      // !schedule stop [id]
      const stopMatch = input.match(/^stop\s+(\d+)/i);
      if (stopMatch) {
        await pool.query(`UPDATE scheduled_mentions SET active = FALSE WHERE id = $1 AND user_id = $2`, [stopMatch[1], userId]);
        clearInterval(typingInterval);
        await message.reply(`🛑 Stopped scheduled mention #${stopMatch[1]}.`);
        processing.delete(message.id); return;
      }

      // !schedule [every X] [message]
      const interval = parseScheduleInterval(input);
      if (!interval) {
        clearInterval(typingInterval);
        await message.reply("Usage: `!schedule every day good morning everyone`\nOr: `!schedule every 2 hours reminder message`\nList yours: `!schedule list` | Stop one: `!schedule stop [id]`");
        processing.delete(message.id); return;
      }

      const scheduleMsg = input.replace(/every\s+\w+(\s+\w+)?/i, "").trim() || "Hey! Just your scheduled ping from Zbor AI ⚡";
      const nextRun = new Date(Date.now() + interval.ms);
      await pool.query(`INSERT INTO scheduled_mentions (user_id, channel_id, message, interval_ms, next_run, label) VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, message.channel.id, scheduleMsg, interval.ms, nextRun, interval.label]);
      clearInterval(typingInterval);
      await message.reply(`📅 Done! I'll mention you **${interval.label}** with: "${scheduleMsg}"\nManage it with \`!schedule list\` or \`!schedule stop [id]\``);
      processing.delete(message.id); return;
    }

    // ── !quote save ───────────────────────────────────────────
    if (lower.startsWith("!quote save")) {
      const content = userMessage.replace(/^!quote save/i, "").trim();
      if (!content) { clearInterval(typingInterval); await message.reply("Usage: `!quote save your quote here`"); processing.delete(message.id); return; }
      await pool.query(`INSERT INTO quotes (guild_id, author, content) VALUES ($1, $2, $3)`, [message.guild.id, username, content]);
      clearInterval(typingInterval);
      await message.reply(`💬 Quote saved: *"${content}"* — ${username}`);
      processing.delete(message.id); return;
    }

    // ── !quote ────────────────────────────────────────────────
    if (lower.startsWith("!quote")) {
      const res = await pool.query(`SELECT * FROM quotes WHERE guild_id = $1 ORDER BY RANDOM() LIMIT 1`, [message.guild.id]);
      clearInterval(typingInterval);
      if (res.rows.length === 0) await message.reply("No quotes saved yet! Use `!quote save your quote`");
      else { const q = res.rows[0]; await message.reply(`💬 *"${q.content}"* — **${q.author}**`); }
      processing.delete(message.id); return;
    }

    // ── !poll ─────────────────────────────────────────────────
    if (lower.startsWith("!poll")) {
      const pollText = userMessage.replace(/^!poll/i, "").trim();
      const parts = pollText.match(/"([^"]+)"/g);
      if (!parts || parts.length < 3) { clearInterval(typingInterval); await message.reply('Usage: `!poll "Question?" "Option1" "Option2"`'); processing.delete(message.id); return; }
      const question = parts[0].replace(/"/g, "");
      const options = parts.slice(1).map(p => p.replace(/"/g, ""));
      const emojis = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣"];
      let pollMsg = `📊 **POLL: ${question}**\n\n`;
      options.forEach((opt, i) => pollMsg += `${emojis[i]} ${opt}\n`);
      clearInterval(typingInterval);
      const sent = await message.channel.send(pollMsg);
      for (let i = 0; i < options.length; i++) await sent.react(emojis[i]);
      await message.delete().catch(() => {});
      processing.delete(message.id); return;
    }

    // ── !roast ────────────────────────────────────────────────
    if (lower.startsWith("!roast")) {
      const target = userMessage.replace(/^!roast/i, "").trim() || username;
      const roastReply = await callAI([{ role: "user", content: `You are Zbor AI, a funny Discord bot. Roast "${target}" in a hilarious but friendly way. Keep it under 3 sentences. Be creative and funny, not mean.` }], 200);
      clearInterval(typingInterval);
      await sendChunks(message, `🔥 ${roastReply || "I tried to roast them but they're already burnt 💀"}`);
      processing.delete(message.id); return;
    }

    // ── !translate ────────────────────────────────────────────
    if (lower.startsWith("!translate")) {
      const translateText = userMessage.replace(/^!translate/i, "").trim();
      if (!translateText) { clearInterval(typingInterval); await message.reply("Usage: `!translate [language] your text`\nExample: `!translate Arabic hello`"); processing.delete(message.id); return; }
      const translateReply = await callAI([{ role: "user", content: `Translate the following text. If a target language is specified at the start, translate to that language. Otherwise translate to English. Just give the translation, nothing else: "${translateText}"` }], 300);
      clearInterval(typingInterval);
      await sendChunks(message, `🌍 **Translation:**\n${translateReply}`);
      processing.delete(message.id); return;
    }

    // ── !summarize ────────────────────────────────────────────
    if (lower.startsWith("!summarize")) {
      const textToSum = userMessage.replace(/^!summarize/i, "").trim();
      if (!textToSum) { clearInterval(typingInterval); await message.reply("Paste the text after `!summarize`"); processing.delete(message.id); return; }
      const sumReply = await callAI([{ role: "user", content: `Summarize this text in 3-5 bullet points:\n\n${textToSum}` }], 400);
      clearInterval(typingInterval);
      await sendChunks(message, `📝 **Summary:**\n${sumReply}`);
      processing.delete(message.id); return;
    }

    // ── !announce ─────────────────────────────────────────────
    if (lower.startsWith("!announce")) {
      const announcement = userMessage.replace(/^!announce/i, "").trim();
      if (!announcement) { clearInterval(typingInterval); await message.reply("Usage: `!announce your message`"); processing.delete(message.id); return; }
      clearInterval(typingInterval);
      await message.channel.send(`📢 @everyone\n\n**${announcement}**\n\n— ${username}`);
      processing.delete(message.id); return;
    }

    // ── !stats ────────────────────────────────────────────────
    if (lower.startsWith("!stats")) {
      const profile = await getOrCreateProfile(userId, username);
      const countRes = await pool.query(`SELECT COUNT(*) as total FROM conversations WHERE user_id = $1 AND role = 'user'`, [userId]);
      clearInterval(typingInterval);
      await message.reply(`📊 **${username}'s Stats**\n\`\`\`\nFirst seen:    ${profile.first_seen}\nMessages sent: ${countRes.rows[0].total}\n\`\`\``);
      processing.delete(message.id); return;
    }

    // ── 🌐 !search ────────────────────────────────────────────
    if (lower.startsWith("!search")) {
      const query = userMessage.replace(/^!search/i, "").trim();
      if (!query) { clearInterval(typingInterval); await message.reply("Usage: `!search your query`"); processing.delete(message.id); return; }
      const searchResult = await webSearch(query);
      clearInterval(typingInterval);
      if (searchResult) {
        await sendChunks(message, `🔍 **Search: ${query}**\n\n${searchResult}`);
      } else {
        const aiAnswer = await callAI([{ role: "user", content: `Answer this search query concisely and factually: "${query}"` }], 400);
        await sendChunks(message, `🔍 **${query}**\n\n${aiAnswer || "Couldn't find results for that."}`);
      }
      processing.delete(message.id); return;
    }

    // ── 📺 !youtube / !yt ─────────────────────────────────────
    if (lower.startsWith("!youtube") || lower.startsWith("!yt")) {
      const query = userMessage.replace(/^!(youtube|yt)/i, "").trim();
      if (!query) { clearInterval(typingInterval); await message.reply("Usage: `!youtube your search`"); processing.delete(message.id); return; }
      const videos = await searchYouTube(query, 5);
      clearInterval(typingInterval);
      if (!videos || videos.length === 0) { await message.reply(`❌ No YouTube results found for **"${query}"**`); }
      else {
        let reply = `📺 **YouTube: "${query}"**\n\n`;
        videos.forEach((v, i) => { reply += `**${i + 1}.** [${v.title}](${v.url})\n   👤 ${v.channel}\n\n`; });
        await sendChunks(message, reply);
      }
      processing.delete(message.id); return;
    }

    // ── 🎵 !spotify ───────────────────────────────────────────
    if (lower.startsWith("!spotify")) {
      const query = userMessage.replace(/^!spotify/i, "").trim();
      if (!query) { clearInterval(typingInterval); await message.reply("Usage: `!spotify song or artist name`"); processing.delete(message.id); return; }
      const results = await searchSpotify(query, "track");
      clearInterval(typingInterval);
      if (!results || results.length === 0) { await message.reply(`❌ Nothing found on Spotify for **"${query}"**`); }
      else {
        let reply = `🎵 **Spotify: "${query}"**\n\n`;
        results.forEach((r, i) => { reply += `**${i + 1}.** ${r.name}${r.artist ? ` — ${r.artist}` : ""}\n   🔗 ${r.url}\n\n`; });
        await sendChunks(message, reply);
      }
      processing.delete(message.id); return;
    }

    // ── 📄 !pdf ───────────────────────────────────────────────
    if (lower.startsWith("!pdf")) {
      const input = userMessage.replace(/^!pdf/i, "").trim();
      if (!input) { clearInterval(typingInterval); await message.reply("Usage: `!pdf Title | Content`"); processing.delete(message.id); return; }
      const sepIdx = input.indexOf("|");
      const title = sepIdx > -1 ? input.slice(0, sepIdx).trim() : "Document";
      const content = sepIdx > -1 ? input.slice(sepIdx + 1).trim() : input;
      try {
        const filePath = await generatePDF(title, content);
        clearInterval(typingInterval);
        await message.reply({ content: `📄 Here's your PDF: **${title}**`, files: [{ attachment: filePath, name: `${title.replace(/[^a-zA-Z0-9]/g, "_")}.pdf` }] });
        fs.unlinkSync(filePath);
      } catch (e) { clearInterval(typingInterval); await message.reply(`❌ PDF generation failed: ${e.message}`); }
      processing.delete(message.id); return;
    }

    // ── 📝 !doc ───────────────────────────────────────────────
    if (lower.startsWith("!doc")) {
      const input = userMessage.replace(/^!doc/i, "").trim();
      if (!input) { clearInterval(typingInterval); await message.reply("Usage: `!doc Title | Content`"); processing.delete(message.id); return; }
      const sepIdx = input.indexOf("|");
      const title = sepIdx > -1 ? input.slice(0, sepIdx).trim() : "Document";
      const content = sepIdx > -1 ? input.slice(sepIdx + 1).trim() : input;
      try {
        const filePath = await generateDOCX(title, content);
        clearInterval(typingInterval);
        await message.reply({ content: `📝 Here's your Word doc: **${title}**`, files: [{ attachment: filePath, name: `${title.replace(/[^a-zA-Z0-9]/g, "_")}.docx` }] });
        fs.unlinkSync(filePath);
      } catch (e) { clearInterval(typingInterval); await message.reply(`❌ Word doc generation failed: ${e.message}`); }
      processing.delete(message.id); return;
    }

    // ── 🖼️ !banner ────────────────────────────────────────────
    if (lower.startsWith("!banner")) {
      const input = userMessage.replace(/^!banner/i, "").trim();
      if (!input) { clearInterval(typingInterval); await message.reply("Usage: `!banner Name | Subtitle | style`\nStyles: `cyber` `fire` `nature` `ocean` `gold`"); processing.delete(message.id); return; }
      const parts = input.split("|").map(p => p.trim());
      const name = parts[0] || username;
      const subtitle = parts[1] || "Zbor AI Member";
      const style = (parts[2] || "cyber").toLowerCase();
      const validStyles = ["cyber", "fire", "nature", "ocean", "gold"];
      try {
        const filePath = generateBanner(name, subtitle, validStyles.includes(style) ? style : "cyber");
        clearInterval(typingInterval);
        await message.reply({ content: `🎨 Here's your **${style}** banner, **${name}**!`, files: [{ attachment: filePath, name: "banner.png" }] });
        fs.unlinkSync(filePath);
      } catch (e) { clearInterval(typingInterval); await message.reply(`❌ Banner generation failed: ${e.message}`); }
      processing.delete(message.id); return;
    }

    // ── 🎨 !imagine ───────────────────────────────────────────
    if (lower.startsWith("!imagine") || lower.startsWith("!image")) {
      const prompt = userMessage.replace(/^!(imagine|image)/i, "").trim();
      if (!prompt) { clearInterval(typingInterval); await message.reply("Usage: `!imagine a hacker cat with neon lights`"); processing.delete(message.id); return; }
      try {
        const seed = Math.floor(Math.random() * 99999);
        const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=768&seed=${seed}&nologo=true&enhance=true`;
        clearInterval(typingInterval);
        await message.reply({ content: `🎨 **"${prompt}"**`, files: [{ attachment: imageUrl, name: "generated.png" }] });
      } catch (e) { clearInterval(typingInterval); await message.reply(`❌ Image generation failed: ${e.message}`); }
      processing.delete(message.id); return;
    }

    // ── !help ─────────────────────────────────────────────────
    if (lower.startsWith("!help")) {
      clearInterval(typingInterval);
      const helpMsg = `🤖 **Zbor AI — Command List**\`\`\`
🔐 CTF & Security
  !analyze [text/file]      — Full forensics analysis
  !hash [text]              — MD5/SHA1/SHA256/SHA512

🎨 AI & Media
  !imagine [prompt]         — Generate an AI image
  !banner [name|sub|style]  — Make a profile banner
                              Styles: cyber fire nature ocean gold

📄 Documents
  !pdf [title|content]      — Generate & send a PDF
  !doc [title|content]      — Generate & send a Word doc

🌐 Internet
  !search [query]           — Search the web
  !youtube / !yt [query]    — Search YouTube videos
  !spotify [query]          — Search Spotify tracks

🎮 Games
  !hangman                  — Classic hangman
  !numgame [max]            — Guess the number (default 1-100)
  !scramble                 — Unscramble a word
  !trivia                   — Tech trivia question
  !guess [letter/answer]    — Guess for active game
  !hint                     — Hint for trivia
  !roll [sides]             — Roll a dice
  !flip                     — Flip a coin

⏰ Scheduling
  !remind [time] [msg]      — One-time reminder (30m, 2h...)
  !schedule every day [msg] — Recurring mention (daily, hourly...)
  !schedule list            — View your schedules
  !schedule stop [id]       — Stop a schedule

🛠️ Tools
  !translate [lang] [text]  — Translate text
  !summarize [text]         — Summarize long text
  !roast [@user]            — Roast someone 🔥
  !poll "Q?" "A" "B"        — Create a reaction poll
  !quote / !quote save      — Random or save a quote
  !announce [msg]           — Ping @everyone
  !stats                    — Your chat stats
  !help                     — This menu
\`\`\`
💬 Just chat normally — I'll suggest music/videos automatically when you ask!`;
      await sendChunks(message, helpMsg);
      processing.delete(message.id); return;
    }

    // ── 🧠 NORMAL CHAT MODE ───────────────────────────────────
    const profile = await getOrCreateProfile(userId, username);
    if (userMessage) await saveMessage(userId, username, "user", userMessage);
    const history = await getHistory(userId);

    // ── 🎵 SMART MEDIA DETECTION (in normal chat) ─────────────
    const mediaCheck = detectMediaRequest(userMessage);
    if (mediaCheck.detected && images.size === 0 && allFiles.size === 0) {
      const suggestions = await getMediaSuggestions(userMessage, mediaCheck.mediaType, mediaCheck.genre);
      if (suggestions && suggestions.length > 0) {
        let mediaReply = `🎵 Here are some suggestions for you, ${username}!\n\n`;
        suggestions.forEach((s, i) => {
          mediaReply += `**${i + 1}.** ${s.platform} — **${s.title}**${s.artist ? ` by ${s.artist}` : ""}\n   🔗 ${s.url}\n\n`;
        });
        mediaReply += `\n*Use \`!youtube\` or \`!spotify\` for more specific searches!*`;
        clearInterval(typingInterval);
        await sendChunks(message, mediaReply);
        processing.delete(message.id); return;
      }
    }

    // ── 📅 SMART SCHEDULE DETECTION (in normal chat) ──────────
    if (detectScheduleRequest(userMessage)) {
      const interval = parseScheduleInterval(userMessage);
      if (interval) {
        // Extract message after the schedule pattern
        const msgPart = userMessage.replace(/mention\s+me|remind\s+me|ping\s+me|tell\s+me/i, "")
          .replace(/every\s+\w+(\s+\w+)?/i, "").trim()
          || "Hey! Zbor AI scheduled mention ⚡";
        const nextRun = new Date(Date.now() + interval.ms);
        await pool.query(`INSERT INTO scheduled_mentions (user_id, channel_id, message, interval_ms, next_run, label) VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, message.channel.id, msgPart, interval.ms, nextRun, interval.label]);
        clearInterval(typingInterval);
        await message.reply(`📅 Got it! I'll mention you **${interval.label}**! Use \`!schedule list\` to manage it.`);
        processing.delete(message.id); return;
      }
    }

    let fileContext = "";
    for (const [, file] of textFiles) {
      const content = await readFileContent(file.url);
      if (content) fileContext += `\n\n📄 File: ${file.name}\n\`\`\`\n${content}\n\`\`\``;
    }
    for (const [, file] of pdfFiles) {
      const content = await readPdfContent(file.url);
      if (content?.trim().length > 0) fileContext += `\n\n📄 PDF File: ${file.name}\n\`\`\`\n${content}\n\`\`\``;
      else fileContext += `\n\n📄 PDF "${file.name}" appears empty.`;
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
        content: `You are Zbor AI — a chill, smart Discord bot and a genuine friend to ${username} (known them since ${profile.first_seen}).

PERSONALITY:
- Casual, funny, real — like texting a smart friend
- Short replies unless they need detail — no essays for simple questions
- Never use bullet points for normal chat — just talk
- Have opinions, make jokes, be real
- Switch to elite CTF/security mode when they need help with challenges

IMPORTANT — REPLY LENGTH:
- Casual chat → 1-3 sentences max
- Questions → answer directly, no padding
- Technical/CTF → as long as needed, step by step

You know about these commands if they ever ask what you can do:
!analyze, !hash, !imagine, !banner, !pdf, !doc, !search, !youtube, !spotify, !roll, !flip, !hangman, !numgame, !scramble, !trivia, !guess, !hint, !remind, !schedule, !translate, !summarize, !roast, !poll, !quote, !announce, !stats, !help`,
      },
      {
        role: "assistant",
        content: `Yo! I'm Zbor AI. What's good?`,
      },
      ...history,
      { role: "user", content: userContent },
    ], 500);

    clearInterval(typingInterval);

    if (!reply) { await message.reply("All AI models are down right now. Try again in a minute!"); processing.delete(message.id); return; }

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