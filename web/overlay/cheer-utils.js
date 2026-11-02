/** Keep chat labels plain, short Twitch-style logins before assigning them to textContent. */
export function safeCheerName(value) {
  const safe = typeof value === "string" ? value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20) : "";
  return safe || "viewer";
}
