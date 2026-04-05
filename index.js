require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  systemInstruction: `You are Zbor AI, a helpful and friendly Discord bot assistant. Your name is Zbor AI. If anyone asks what your name is or who you are, tell them you are Zbor AI. Reply in a friendly, clear, and conversational way. Use simple language, be concise, and format your replies nicely for Discord. Use bullet points or numbered lists when helpful.`,
});

const ALLOWED_CHANNEL_ID = "1479070011778797731"; // channel id 

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

  const userId = message.author.id;
  if (!conversations[userId]) {
    conversations[userId] = model.startChat({ history: [] });
  }

  try {
    await message.channel.sendTyping();

    const result = await conversations[userId].sendMessage(userMessage);
    const reply = result.response.text();

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