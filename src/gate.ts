import { existsSync } from 'fs';
import { join } from 'path';
import { loadConfig } from './config.js';

/**
 * Check whether distill should run for the given project directory.
 *
 * Logic:
 *   1. If project has `.nodistill` file → disabled (always wins)
 *   2. If project has `.distill` file → enabled (always wins)
 *   3. Otherwise → use global `enabled` setting from config (default: true)
 *
 * Usage:
 *   touch .nodistill    # disable for this project
 *   touch .distill      # enable for this project (even if global default is off)
 *   rm .nodistill       # revert to global default
 */
export function isEnabled(cwd?: string): boolean {
  if (cwd) {
    if (existsSync(join(cwd, '.nodistill'))) return false;
    if (existsSync(join(cwd, '.distill'))) return true;
  }

  const config = loadConfig();
  return config.enabled !== false; // default true
}
