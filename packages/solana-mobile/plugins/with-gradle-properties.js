/*
  Gradle properties for release builds. android/ is generated (expo prebuild), so they live here:
  - room for a full release build: with expo-updates' native code the default 512 MB of metaspace runs out;
  - R8 on, with resource shrinking: unused Java and resources stay out of the app (Play reported 36 MB of DEX);
  - react-native-audio-api without FFmpeg: every sound is synthesized, nothing is decoded from a file;
  - without BouncyCastle's post-quantum data files (a wallet library's dependency; nothing here signs with them).
*/
const { withGradleProperties } = require("expo/config-plugins");

const PROPS = {
  "org.gradle.jvmargs": "-Xmx4g -XX:MaxMetaspaceSize=1536m",
  "android.enableMinifyInReleaseBuilds": "true",
  "android.enableShrinkResourcesInReleaseBuilds": "true",
  disableAudioapiFFmpeg: "true",
  "android.packagingOptions.excludes": "org/bouncycastle/pqc/**",
};

module.exports = (config) =>
  withGradleProperties(config, (c) => {
    for (const [key, value] of Object.entries(PROPS)) {
      const p = c.modResults.find((i) => i.type === "property" && i.key === key);
      if (p) p.value = value;
      else c.modResults.push({ type: "property", key, value });
    }
    return c;
  });
