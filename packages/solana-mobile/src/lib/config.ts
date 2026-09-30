/** Where the app reaches the engine and the Solana relayer, and the Privy app it signs in with. */
export const ENGINE_URL = process.env.EXPO_PUBLIC_ENGINE_URL || "wss://api.skech.trade/engine/ws";
export const RELAYER_URL = process.env.EXPO_PUBLIC_RELAYER_URL || "wss://api.skech.trade/solana/ws";
export const PRIVY_APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID ?? "";
/** The app client for this app's id, which is what lets a phone (with no web origin) in. */
export const PRIVY_CLIENT_ID = process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID ?? "";
/** Whether this build can sign anyone in at all: without both ids the app plays for practice money. */
export const hasAuth = PRIVY_APP_ID !== "" && PRIVY_CLIENT_ID !== "";
