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

// CHANNEL ID
const ALLOWED_CHANNEL_ID = "1479070011778797731";

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

  try {
    await message.channel.sendTyping();

    const response = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: `You are Zbor AI, a helpful and friendly Discord bot assistant. Your name is Zbor AI. If anyone asks what your name is or who you are, tell them you are Zbor AI. Reply in a friendly, clear, and conversational way. Use simple language, be concise, and format your replies nicely for Discord. Use bullet points or numbered lists when helpful.`,
      messages: [{ role: "user", content: userMessage }],
    });

    const reply = response.content[0].text;

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