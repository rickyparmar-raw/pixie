# Pixie runs on Bun (it uses bun:sqlite and runs TypeScript directly), so the
# runtime is pinned here rather than left to Railway's builder detection.
FROM oven/bun:1

# Railway volumes mount owned by root, so the bot runs as root to be able to
# create pixie.db on it.
USER root

WORKDIR /app

# Dependencies in their own layer so editing lib/ doesn't re-resolve them.
COPY package.json ./
RUN bun install

COPY . .

# Slack connects over Socket Mode, so no port or healthcheck is needed for it.
CMD ["bun", "index.ts"]
