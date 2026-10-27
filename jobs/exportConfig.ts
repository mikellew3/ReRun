/**
 * Writes engine/src/config/model.config.ts to pipeline/model_config.json so the Python
 * pipeline reads the same values. CI re-runs this and fails if the committed file is stale.
 *
 * Usage: npm run export-config
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION, MODEL_CONFIG, configHash } from '@rerun/engine';

const outPath = fileURLToPath(new URL('../pipeline/model_config.json', import.meta.url));

const payload = {
  _generated: 'by jobs/exportConfig.ts from engine/src/config/model.config.ts. Do not edit.',
  configHash: configHash(),
  engineVersion: ENGINE_VERSION,
  model: MODEL_CONFIG,
};

writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Wrote ${outPath} (configHash ${payload.configHash})`);
