require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const Anthropic = require("@anthropic-ai/sdk");

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ALLOWED_CHANNEL_ID = "1479070011778797731"; //channel id 

// Stores conversation history per user
const conversations = {};

discord.on("ready", () => {
  console.log(`✅ Bot is online as ${discord.user.tag}`);
});

discord.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== ALLOWED_CHANNEL_ID) return;
  if (!message.mentions.has(discord.user)) return;

  const userMessage = message.content
    .replace(`<@${discord.user.id}>`, "")
    .trim();

  if (!userMessage) return;

  // Get or create conversation history for this user
  const userId = message.author.id;
  if (!conversations[userId]) {
    conversations[userId] = [];
  }

  // Add user message to history
  conversations[userId].push({
    role: "user",
    content: userMessage,
  });

  // Keep only last 20 messages to avoid hitting limits
  if (conversations[userId].length > 20) {
    conversations[userId] = conversations[userId].slice(-20);
  }

  try {
    await message.channel.sendTyping();

    const response = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: `You are Zbor AI, a helpful and friendly Discord bot assistant. Your name is Zbor AI. If anyone asks what your name is or who you are, tell them you are Zbor AI. Reply in a friendly, clear, and conversational way. Use simple language, be concise, and format your replies nicely for Discord. Use bullet points or numbered lists when helpful.`,
      messages: conversations[userId],
    });

    const reply = response.content[0].text;

    // Add bot reply to history
    conversations[userId].push({
      role: "assistant",
      content: reply,
    });

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

discord.login(process.env.DISCORD_TOKEN);