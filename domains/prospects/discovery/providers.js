import { coldwellBankerHomesProvider } from "./coldwellBankerHomes.provider.js";

const providers = [coldwellBankerHomesProvider];

export function getDiscoveryProvider(url) {
  return providers.find((provider) => provider.supports(url)) || null;
}

export function listDiscoveryProviders() {
  return providers.map(({ key, label }) => ({ key, label }));
}
