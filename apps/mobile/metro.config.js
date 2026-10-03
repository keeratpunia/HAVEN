const { getDefaultConfig } = require('expo/metro-config');

/**
 * The rest of this monorepo (apps/api, packages/shared, packages/ui) writes relative
 * imports with an explicit `.js` extension pointing at `.ts`/`.tsx` source files — the
 * standard TypeScript "NodeNext" convention `tsc`/`tsx`/Node's ESM loader all resolve
 * correctly. Metro (this bundler) has no equivalent "strip `.js`, try `.ts`/`.tsx`"
 * fallback built in, so without this resolver every such import fails to bundle.
 * Rather than keep two incompatible import-extension conventions in the monorepo
 * (apps/mobile without, everything else with), this resolver makes Metro understand
 * the one the rest of the codebase already uses.
 */
const config = getDefaultConfig(__dirname);

const upstreamResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    const withoutExt = moduleName.slice(0, -3);
    for (const ext of ['.ts', '.tsx']) {
      try {
        return context.resolveRequest(context, `${withoutExt}${ext}`, platform);
      } catch {
        // try the next extension
      }
    }
  }
  if (upstreamResolveRequest) {
    return upstreamResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
