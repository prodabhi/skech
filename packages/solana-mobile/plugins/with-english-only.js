/*
  Only English resources in the app: skech is in English, and the libraries brought translations for 87 languages
  that nothing shows.
*/
const { withAppBuildGradle } = require("expo/config-plugins");

const MARK = "// skech: English resources only";

module.exports = (config) =>
  withAppBuildGradle(config, (c) => {
    if (c.modResults.contents.includes(MARK)) return c;
    c.modResults.contents = c.modResults.contents.replace(/(\n {4}defaultConfig \{\n)/, `$1        ${MARK}\n        resourceConfigurations += ["en"]\n`);
    if (!c.modResults.contents.includes(MARK)) throw new Error("with-english-only: no defaultConfig in build.gradle");
    return c;
  });
