/**
 * Who publishes skech, and the few facts the legal pages quote.
 *
 * One file so the privacy policy, the terms and the account deletion page
 * cannot drift apart.
 */

/** Where privacy, deletion and support requests go. The pages name no person or company: skech's team signs them. */
export const CONTACT_EMAIL = "team@skech.trade";

/** When the current versions of the pages took effect. */
export const EFFECTIVE_DATE = "October 2026";

/**
 * The game's fees, as set on chain today. The stake fee is the admin's to set (4% on the Solana devnet game), so
 * check it against the deployed config whenever it changes.
 */
export const STAKE_FEE = "4%";
export const PROFIT_FEE = "10%";

/** What an IOU grows by, at the game's current rate (`iou_rate` on the pool). */
export const IOU_GROWTH = "about 0.1% a day";

/** The subject line a deletion request is matched on. */
export const DELETE_SUBJECT = "Delete my skech account";

/** How long we take to confirm a deletion. */
export const DELETE_DAYS = 30;

/** A mailto link with the subject filled in, and a body asking for the address. */
export function mailto(subject?: string, body?: string): string {
  const params = new URLSearchParams();
  if (subject) params.set("subject", subject);
  if (body) params.set("body", body);
  const query = params.toString().replace(/\+/g, "%20");
  return `mailto:${CONTACT_EMAIL}${query ? `?${query}` : ""}`;
}
