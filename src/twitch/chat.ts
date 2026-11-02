export interface ParsedChatMessage {
  user: string;
  userId: string;
  login: string;
  messageId: string;
  /** Badge set IDs such as `broadcaster`, `moderator` and `subscriber`. */
  badges: string[];
  text: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/** Parse a recorded or live channel.chat.message notification without touching any network state. */
export function parseChatNotification(value: unknown): ParsedChatMessage | undefined {
  const message = record(value);
  const metadata = record(message?.metadata);
  const payload = record(message?.payload);
  const subscription = record(payload?.subscription);
  const event = record(payload?.event);
  if (metadata?.message_type !== "notification" || subscription?.type !== "channel.chat.message" || !event) return undefined;

  const user = typeof event.chatter_user_name === "string" ? event.chatter_user_name
    : typeof event.chatter_user_login === "string" ? event.chatter_user_login
      : typeof event.chatter_user_id === "string" ? event.chatter_user_id : "unknown";
  const rawBadges = Array.isArray(event.badges) ? event.badges : [];
  const badges = rawBadges.flatMap((item) => {
    const badge = record(item);
    return typeof badge?.set_id === "string" ? [badge.set_id] : [];
  });
  const chatMessage = record(event.message);
  const fragments = Array.isArray(chatMessage?.fragments) ? chatMessage.fragments : [];
  const text = typeof chatMessage?.text === "string" ? chatMessage.text : fragments.flatMap((item) => {
    const fragment = record(item);
    return typeof fragment?.text === "string" ? [fragment.text] : [];
  }).join("");
  return {
    user,
    userId: typeof event.chatter_user_id === "string" ? event.chatter_user_id : "",
    login: typeof event.chatter_user_login === "string" ? event.chatter_user_login : user,
    messageId: typeof metadata.message_id === "string" ? metadata.message_id : "",
    badges,
    text,
  };
}
