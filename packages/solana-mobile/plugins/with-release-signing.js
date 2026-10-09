/*
  Signs release builds with skech's own key, kept outside the repo at ~/.config/skech/android-signing.properties.
  Wallets check that key against skech.trade's assetlinks.json, and Play knows it as the upload key, so every
  release build has to carry it. android/ is generated (expo prebuild), so the signing lives here, not in it.
  Without the file the release is signed with the debug key, as before.
*/
const { withAppBuildGradle } = require("expo/config-plugins");

const MARK = "// skech release signing";
const BLOCK = `
        ${MARK}: the key lives outside the repo; wallets check it against skech.trade's assetlinks.json.
        def skechSigning = new File(System.getProperty('user.home'), '.config/skech/android-signing.properties')
        if (skechSigning.exists()) {
            def p = new Properties(); skechSigning.withInputStream { p.load(it) }
            release {
                storeFile file(p['SKECH_UPLOAD_STORE_FILE'])
                storePassword p['SKECH_UPLOAD_STORE_PASSWORD']
                keyAlias p['SKECH_UPLOAD_KEY_ALIAS']
                keyPassword p['SKECH_UPLOAD_KEY_PASSWORD']
            }
        }`;

module.exports = (config) =>
  withAppBuildGradle(config, (c) => {
    let g = c.modResults.contents;
    if (g.includes(MARK)) return c;
    // After the debug signing config, inside signingConfigs.
    g = g.replace(/(signingConfigs \{\s*debug \{[\s\S]*?\n {8}\})/, `$1${BLOCK}`);
    // The release build type: skech's key when it is there, the debug key when it is not.
    g = g.replace(/(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/, "$1signingConfig signingConfigs.findByName('release') ?: signingConfigs.debug");
    if (!g.includes(MARK) || !g.includes("findByName('release')")) throw new Error("with-release-signing: build.gradle did not look as expected");
    c.modResults.contents = g;
    return c;
  });
