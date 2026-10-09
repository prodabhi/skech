import { requireOptionalNativeModule } from "expo-modules-core";

type Native = { available(): boolean; load(seed: Uint8Array): void; sign(message: Uint8Array): Uint8Array };

/** The platform's Ed25519, or null where there is none (iOS for now, Android before 13). */
const native = requireOptionalNativeModule<Native>("SkechEd25519");

export function platformSigner(seed: Uint8Array): ((message: Uint8Array) => Uint8Array) | null {
  if (!native?.available()) return null;
  native.load(seed);
  return (message) => new Uint8Array(native.sign(message));
}
