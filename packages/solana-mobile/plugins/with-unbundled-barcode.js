/*
  The QR scanner without ML Kit's bundled barcode model (about 5.5 MB of native code and model in the app). The
  unbundled artifact has the same classes; Google Play services keeps the model and fetches it once, at install.
  expo-camera's own scanner then works unchanged.
*/
const { withAppBuildGradle, withAndroidManifest, AndroidConfig } = require("expo/config-plugins");

const MARK = "// skech: unbundled barcode scanning";
const BLOCK = `
${MARK}
configurations.all {
    exclude group: 'com.google.mlkit', module: 'barcode-scanning'
}
dependencies {
    implementation 'com.google.android.gms:play-services-mlkit-barcode-scanning:18.3.1'
}
`;

module.exports = (config) => {
  config = withAppBuildGradle(config, (c) => {
    if (!c.modResults.contents.includes(MARK)) c.modResults.contents += BLOCK;
    return c;
  });
  return withAndroidManifest(config, (c) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(c.modResults);
    // Ask Play services for the model when the app is installed, not at the first scan. expo-camera already asks
    // for its scanner UI's ("barcode_ui"); this one replaces it with both.
    c.modResults.manifest.$["xmlns:tools"] ??= "http://schemas.android.com/tools";
    app["meta-data"] = (app["meta-data"] ?? []).filter((m) => m.$["android:name"] !== "com.google.mlkit.vision.DEPENDENCIES");
    app["meta-data"].push({ $: { "android:name": "com.google.mlkit.vision.DEPENDENCIES", "android:value": "barcode_ui,barcode", "tools:replace": "android:value" } });
    return c;
  });
};
