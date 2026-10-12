/* Expo 55 and Reanimated 4.2 import Worklets from a legacy AGP output path. Use the prefab
   target instead, as the other native libraries do, so debug/release and every
   ABI resolve the library produced by the current Android toolchain. */
const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

const LEGACY = /add_library\(worklets SHARED IMPORTED\)[\s\S]*?set_target_properties\(\s*worklets\s+PROPERTIES\s+IMPORTED_LOCATION\s+"\$\{REACT_NATIVE_WORKLETS_DIR\}\/android\/build\/intermediates\/cmake\/\$\{BUILD_TYPE\}\/obj\/\$\{ANDROID_ABI\}\/libworklets\.so"\s*\)/;
const MODERN = `find_package(react-native-worklets REQUIRED CONFIG)
add_library(worklets ALIAS react-native-worklets::worklets)`;

function fixWorkletsLink(source) {
  if (!source.includes("/android/build/intermediates/cmake/")) return source;
  if (!LEGACY.test(source)) throw new Error("The Worklets link changed; review with-worklets-link before building.");
  return source.replace(LEGACY, MODERN);
}

module.exports = (config) => withDangerousMod(config, ["android", (c) => {
  for (const [name, relative] of [["expo-modules-core", "android/cmake/main.cmake"], ["react-native-reanimated", "android/CMakeLists.txt"]]) {
    const pkg = require.resolve(`${name}/package.json`, { paths: [c.modRequest.projectRoot] });
    const file = path.join(path.dirname(pkg), relative);
    const source = fs.readFileSync(file, "utf8");
    const next = fixWorkletsLink(source);
    if (next !== source) fs.writeFileSync(file, next);
  }
  return c;
}]);
module.exports.fixWorkletsLink = fixWorkletsLink;
