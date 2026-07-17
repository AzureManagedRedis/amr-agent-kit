// Runtime SKU catalog and live-ceiling derivation for the live-cache safety
// subsystem.
//
// The live ceiling is *never* a hard-coded number. It is always derived, at
// run time, from a runtime-supplied SKU catalog's Balanced B5 entry -- so it
// automatically tracks whatever the local RP catalog actually reports.

export class CatalogError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CatalogError';
  }
}

const RECOGNIZED_FAMILIES = new Set(['Balanced', 'MemoryOptimized', 'ComputeOptimized']);
const CEILING_FAMILY = 'Balanced';
const CEILING_SIZE_NAME = 'B5';

function findSku(catalog, family, name) {
  return catalog.skus.find((s) => s.family === family && s.name === name);
}

/**
 * Derives the live-soak SKU ceiling from a runtime-supplied SKU catalog: the
 * memory (and, when present, capacity) of the catalog's Balanced B5 entry.
 */
export function deriveLiveCeiling(catalog) {
  if (!catalog || !Array.isArray(catalog.skus)) {
    throw new CatalogError('Runtime SKU catalog is missing or malformed.');
  }
  const b5 = findSku(catalog, CEILING_FAMILY, CEILING_SIZE_NAME);
  if (!b5) {
    throw new CatalogError(
      `Runtime SKU catalog does not contain ${CEILING_FAMILY} ${CEILING_SIZE_NAME}; cannot derive live ceiling.`
    );
  }
  if (typeof b5.memoryGb !== 'number') {
    throw new CatalogError(`${CEILING_FAMILY} ${CEILING_SIZE_NAME} entry is missing memoryGb.`);
  }
  return {
    memoryGb: b5.memoryGb,
    capacityGb: typeof b5.capacityGb === 'number' ? b5.capacityGb : null,
    sourceSku: `${CEILING_FAMILY} ${CEILING_SIZE_NAME}`,
  };
}

/**
 * Determines whether a requested SKU is at or below the live ceiling.
 *
 * - Any recognized family (Balanced/MemoryOptimized/ComputeOptimized, i.e.
 *   B/M/X) is eligible, provided memory (and capacity, when the SKU reports
 *   one) are at or below the ceiling.
 * - B0-style SKUs omit capacity entirely in the catalog; for those, only
 *   memory is compared.
 * - SKUs above the ceiling are not rejected here -- callers (see
 *   classifySkuRequest) must force dry-run-only execution for them instead.
 */
export function isSkuWithinLiveCeiling(sku, ceiling) {
  if (!RECOGNIZED_FAMILIES.has(sku.family)) {
    throw new CatalogError(
      `Unrecognized SKU family "${sku.family}". Expected one of: Balanced, MemoryOptimized, ComputeOptimized.`
    );
  }
  if (typeof sku.memoryGb !== 'number') {
    throw new CatalogError(`SKU "${sku.family} ${sku.name}" is missing memoryGb.`);
  }
  if (sku.memoryGb > ceiling.memoryGb) return false;

  const skuHasCapacity = typeof sku.capacityGb === 'number';
  if (!skuHasCapacity) {
    // B0 omits capacity entirely: memory alone determines eligibility.
    return true;
  }
  if (ceiling.capacityGb == null) return true;
  return sku.capacityGb <= ceiling.capacityGb;
}

/**
 * Classifies a requested SKU against a runtime catalog: looks it up, derives
 * the ceiling, and reports whether it is within budget. Out-of-budget SKUs
 * are marked dryRunOnly rather than rejected outright.
 */
export function classifySkuRequest(catalog, requestedSkuName, requestedFamily) {
  const sku = findSku(catalog, requestedFamily, requestedSkuName);
  if (!sku) {
    throw new CatalogError(`Requested SKU "${requestedFamily} ${requestedSkuName}" was not found in the runtime catalog.`);
  }
  const ceiling = deriveLiveCeiling(catalog);
  const withinCeiling = isSkuWithinLiveCeiling(sku, ceiling);
  return {
    sku,
    ceiling,
    withinCeiling,
    dryRunOnly: !withinCeiling,
  };
}
