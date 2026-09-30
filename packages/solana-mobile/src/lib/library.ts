import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { type Library, readLibrary } from "@skech/core/dots";

/**
 * The paths every chance is measured on: sixteen thousand real stretches of Bitcoin, 2 MB, bundled with the app
 * (the web fetches the same file, /dots-lib.bin). Read once.
 */
let once: Promise<{ lib: Library; bytes: Uint8Array }> | null = null;
export function library() {
  once ??= (async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const asset = Asset.fromModule(require("../../assets/dots-lib.bin"));
    await asset.downloadAsync();
    const bytes = await new File(asset.localUri!).bytes();
    return { lib: readLibrary(bytes), bytes };
  })();
  once.catch(() => (once = null));
  return once;
}
