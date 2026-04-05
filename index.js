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

// Fetch and read text from a regular file URL
async function readFileContent(url) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    return text.slice(0, 8000);
  } catch {
    return null;
  }
}

// Fetch and read text from a PDF URL
async function readPdfContent(url) {
  try {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const data = await pdfParse(Buffer.from(buffer));
    return data.text.slice(0, 8000);
  } catch {
    return null;
  }
}

const TEXT_EXTENSIONS = [
  ".txt", ".md", ".js", ".ts", ".py", ".html", ".css",
  ".json", ".csv", ".xml", ".yaml", ".yml", ".java",
  ".c", ".cpp", ".cs", ".php", ".rb", ".go", ".rs",
  ".sql", ".sh", ".bat", ".env", ".log"
];

discord.on("ready", () => {
  console.log(`✅ Bot is online as Zbor AI`);
});

discord.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== ALLOWED_CHANNEL_ID) return;
  if (!message.mentions.has(discord.user)) return;

  const userMessage = message.content
    .replace(`<@${discord.user.id}>`, "")
    .trim();

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

  if (!userMessage && images.size === 0 && textFiles.size === 0 && pdfFiles.size === 0) return;

  const userId = message.author.id;
  const username = message.author.username;

  try {
    await message.channel.sendTyping();

    const profile = await getOrCreateProfile(userId, username);
    if (userMessage) await saveMessage(userId, username, "user", userMessage);
    const history = await getHistory(userId);

    // Read text file contents
    let fileContext = "";
    for (const [, file] of textFiles) {
      const content = await readFileContent(file.url);
      if (content) {
        fileContext += `\n\n📄 File: ${file.name}\n\`\`\`\n${content}\n\`\`\``;
      }
    }

    // Read PDF contents
    for (const [, file] of pdfFiles) {
      const content = await readPdfContent(file.url);
      if (content) {
        fileContext += `\n\n📄 PDF File: ${file.name}\n\`\`\`\n${content}\n\`\`\``;
      } else {
        fileContext += `\n\n📄 Could not read PDF: ${file.name}. Ask the user to copy paste the text instead.`;
      }
    }

    // Build message content
    let userContent;
    if (images.size > 0) {
      userContent = [
        {
          type: "text",
          text: (userMessage || "What is in this image?") + fileContext
        },
        ...images.map(img => ({
          type: "image_url",
          image_url: { url: img.url }
        }))
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
        model: "openrouter/auto",
        messages: [
          {
            role: "user",
            content: `From now on you are Zbor AI, a helpful and friendly Discord bot. The user talking to you is named ${username}. You have known them since ${profile.first_seen}. Use their name naturally in conversation.`,
          },
          {
            role: "assistant",
            content: `Got it! I am Zbor AI. I'm talking to ${username} and I remember all our previous conversations!`,
          },
          ...history,
          {
            role: "user",
            content: userContent,
          }
        ],
      }),
    });

    const data = await res.json();
    console.log("OpenRouter response:", JSON.stringify(data));
    if (!data.choices || !data.choices[0]) {
      await message.reply("No response from AI. Try again!");
      return;
    }

    const reply = data.choices[0].message.content;
    await saveMessage(userId, username, "assistant", reply);

    if (reply.length <= 2000) {
      await message.reply(reply);
    } else {
      await message.reply(reply.slice(0, 1997) + "...");
    }
  } catch (err) {
    console.error(err);
    await message.reply("Something went wrong. Try again!");
  }
});

initDB().then(() => discord.login(process.env.DISCORD_TOKEN));