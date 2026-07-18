// Injected SKU catalog provider for the live-cache safety subsystem.
//
// There is no real "/catalog/skus" endpoint on the local RP (or on Azure
// Resource Manager generally) -- SKU/capacity data comes from a runtime
// control-plane catalog that must be supplied by the caller/environment.
// This module is the single, fail-closed seam for that: it never invents
// live SKU data, and it refuses (rather than guessing) when no provider is
// configured or the provider returns something unusable.

import { classifySkuRequest } from './sku-catalog.mjs';

export class CatalogUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CatalogUnavailableError';
  }
}

/**
 * Resolves the runtime SKU catalog from an injected provider. `catalogProvider`
 * may be a plain catalog object, a function returning one (sync or async), or
 * omitted entirely -- in which case this fails closed.
 *
 * @param {object|(() => object|Promise<object>)|null|undefined} catalogProvider
 * @returns {Promise<{skus: object[]}>}
 */
export async function resolveSkuCatalog(catalogProvider) {
  if (!catalogProvider) {
    throw new CatalogUnavailableError(
      'No SKU catalog provider is configured; refusing to invent live SKU data. Inject a runtime control-plane catalog provider.'
    );
  }
  const catalog = typeof catalogProvider === 'function' ? await catalogProvider() : await catalogProvider;
  if (!catalog || !Array.isArray(catalog.skus)) {
    throw new CatalogUnavailableError('The configured SKU catalog provider returned no usable catalog (missing skus array).');
  }
  return catalog;
}

/**
 * Convenience composition: resolve the catalog (fail-closed) then classify a
 * requested SKU against it via sku-catalog.mjs's classifySkuRequest.
 *
 * @param {object|(() => object|Promise<object>)} catalogProvider
 * @param {string} requestedSkuName
 * @param {string} requestedFamily
 */
export async function classifySkuViaProvider(catalogProvider, requestedSkuName, requestedFamily) {
  const catalog = await resolveSkuCatalog(catalogProvider);
  return classifySkuRequest(catalog, requestedSkuName, requestedFamily);
}
