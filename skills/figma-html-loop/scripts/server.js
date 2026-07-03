#!/usr/bin/env node
// Legacy entry kept for the skill's start-helper.js. The canonical local helper
// lives in packages/local-helper/src/server.js — this shim just runs it so there
// is a single source of truth (no divergent copy to keep in sync).
require("../../../packages/local-helper/src/server.js").start();
