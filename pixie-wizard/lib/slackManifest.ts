// Assembled from apps/pixie/README.md's "Slack App Setup" section and the
// slash-command table there — not yet diffed against a real Slack-exported
// manifest (plan §2 step 4 flags this as required before trusting it blind).

const BOT_SCOPES = [
  "chat:write",
  "channels:history",
  "groups:history",
  "channels:join",
  "app_mentions:read",
  "reactions:read",
  "reactions:write",
  "commands",
  "im:history",
  "im:write",
  "channels:read",
  "groups:read",
  "files:read",
];

const BOT_EVENTS = [
  "message.channels",
  "message.groups",
  "message.im",
  "app_mention",
  "reaction_added",
  "reaction_removed",
  "app_home_opened",
  "member_joined_channel",
];

const SLASH_COMMANDS: Array<{ command: string; description: string; usage_hint?: string }> = [
  { command: "/pixie", description: "Private answer — help without cluttering the channel", usage_hint: "[question]" },
  { command: "/pixie-sources", description: "What's loaded and when it last refreshed" },
  { command: "/pixie-stats", description: "Answer rate, cache hits, feedback, latency" },
  { command: "/pixie-gaps", description: "Top questions the docs didn't cover" },
  { command: "/pixie-report", description: "The weekly report now", usage_hint: "[last]" },
  { command: "/pixie-teach", description: "Teach an answer directly", usage_hint: "<question> :: <answer>" },
  { command: "/pixie-pending", description: "Captured answers awaiting review" },
  { command: "/pixie-approve", description: "Start using a captured answer", usage_hint: "<n>" },
  { command: "/pixie-forget", description: "Drop answer(s) by id, range, pending, or all", usage_hint: "<target>" },
  { command: "/pixie-reload", description: "Re-fetch the docs and clear the cache, no restart" },
];

export function generateSlackManifest(botName: string, programName: string) {
  return {
    display_information: {
      name: botName,
      description: `Answers questions from ${programName}'s docs, right in Slack.`,
      background_color: "#ec3750",
    },
    features: {
      bot_user: {
        display_name: botName,
        always_online: true,
      },
      slash_commands: SLASH_COMMANDS.map((c) => ({ ...c, should_escape: false })),
      shortcuts: [
        {
          name: "Teach pixie from thread",
          type: "message",
          callback_id: "pixie_teach_thread",
          description: "Capture this thread as a taught answer for review",
        },
      ],
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
    },
    oauth_config: {
      scopes: {
        bot: BOT_SCOPES,
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: BOT_EVENTS,
      },
      interactivity: {
        is_enabled: true,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}
