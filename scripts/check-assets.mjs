#!/usr/bin/env node

import { validateAssetProvenance } from "./lib/asset-provenance.mjs";

const result = validateAssetProvenance(process.cwd());
console.log(`asset checks: ok (${result.mediaCount} files)`);
