const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')
const { withUniwindConfig } = require('uniwind/metro')

/**
 * The app shares the game's rules and the Solana client with the rest of the monorepo, from source:
 * `@skech/core/<x>` is packages/core/src/<x>.ts, `@skech/contracts/<x>` is packages/contracts/<x>.
 * Everything they import resolves from this app's own node_modules, so there is one React Native,
 * one @solana/kit and one viem in the bundle, whatever the workspace hoisted for the web apps.
 */
const packages = path.resolve(__dirname, '..')
const own = path.resolve(__dirname, 'node_modules')

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname)
config.watchFolders = [path.join(packages, 'core'), path.join(packages, 'contracts', 'solana'), path.join(packages, 'contracts', 'deployments')]
config.resolver.nodeModulesPaths = [own]
config.resolver.assetExts.push('bin')

const uniwindConfig = withUniwindConfig(config, { cssEntryFile: './src/global.css', dtsFile: './src/uniwind-types.d.ts' })
const next = uniwindConfig.resolver.resolveRequest

uniwindConfig.resolver.resolveRequest = (context, moduleName, platform) => {
  const shared = /^@skech\/(core|contracts)\/(.+)$/.exec(moduleName)
  if (shared) {
    const file = shared[1] === 'core' ? path.join(packages, 'core', 'src', `${shared[2]}.ts`) : path.join(packages, 'contracts', shared[2].endsWith('.json') ? shared[2] : `${shared[2]}.ts`)
    return { type: 'sourceFile', filePath: file }
  }
  // A bare import from the shared code resolves as if from this app, to its one copy of each package.
  if (!moduleName.startsWith('.') && !moduleName.startsWith('/') && !context.originModulePath.startsWith(__dirname)) {
    const here = { ...context, originModulePath: path.join(__dirname, 'index.js') }
    return next ? next(here, moduleName, platform) : context.resolveRequest(here, moduleName, platform)
  }
  // Material Symbols: unused, ~3 MB of fonts; see stubs/material-symbols.js.
  if (moduleName === '@expo-google-fonts/material-symbols') return { type: 'sourceFile', filePath: path.join(__dirname, 'stubs', 'material-symbols.js') }
  if (moduleName === 'jose') return context.resolveRequest({ ...context, unstable_conditionNames: ['browser'] }, moduleName, platform)
  return next ? next(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform)
}

module.exports = uniwindConfig
