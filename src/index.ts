import { run } from "@grammyjs/runner";
import { Bot } from "grammy";
import { commandHandler, commands } from "./bot/commands";
import {
  handleGuestMessage,
  handleMessage,
  inChatOrder,
} from "./bot/conversation";
import { config } from "./config";
import { logger } from "./logger";

const bot = new Bot(config.TELEGRAM_API_KEY);

bot.on("guest_message", handleGuestMessage);

const messages = bot.on("message");
messages.use(inChatOrder);
for (const [name, command] of commands) {
  messages.command(name, commandHandler(command));
}
messages.on(["message:text", "message:photo"], handleMessage);

bot.catch(({ error, ctx }) => {
  logger.error("bot.unhandled_error", error, { update: ctx.update });
});

await bot.init();
const runner = run(bot, {
  runner: { fetch: { allowed_updates: ["message", "guest_message"] } },
});
logger.info("bot.started", { username: bot.botInfo.username });

const stop = () => runner.stop();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
