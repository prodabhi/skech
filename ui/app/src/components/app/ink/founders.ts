/** The founder players are sent to, for onboarding and for feedback. One place, so the handle is never out of step. */
export const FOUNDER = { name: "Abhi", handle: "Oxabhii", url: "https://t.me/Oxabhii", photo: "/founders/abhi.jpg" } as const;

/**
 * The founder's chat with a message already typed: that they need help to play, and who they are, so the
 * first reply can be the help. Telegram's `?text=` fills the box; nothing is sent until they send it.
 * `who` is their email, or else their phone number or address; left out when there is none.
 */
export function helpLink(who: { email: string | null; phone?: string | null; address?: string | null }): string {
  const me = who.email ? `My email is ${who.email}.` : who.phone ? `I signed in with ${who.phone}.` : who.address ? `My skech address is ${who.address}.` : "";
  return `${FOUNDER.url}?text=${encodeURIComponent(`Hi ${FOUNDER.name}, I need help with playing skech. ${me}`.trim())}`;
}
