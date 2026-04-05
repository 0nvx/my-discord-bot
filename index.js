require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const ALLOWED_CHANNEL_ID = "1479070011778797731";
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
  if (!conversations[userId]) conversations[userId] = [];

  conversations[userId].push({ role: "user", content: userMessage });
  if (conversations[userId].length > 20)
    conversations[userId] = conversations[userId].slice(-20);

  try {
    await message.channel.sendTyping();

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemma-3-4b-it:free",
        messages: [
          {
            role: "system",
            content: `You are Zbor AI, a helpful and friendly Discord bot. Your name is Zbor AI. Reply in a friendly, clear, conversational way. Be concise and format replies nicely for Discord.`,
          },
          ...conversations[userId],
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

    conversations[userId].push({ role: "assistant", content: reply });

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