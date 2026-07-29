#!/usr/bin/env node
import {
  launchAlertCatalog,
  validateLaunchAlertCatalog,
} from "./alertCatalog.js";

const errors = validateLaunchAlertCatalog();
console.log(JSON.stringify({
  schemaVersion: "launch-alert-catalog.v1",
  safe: true,
  valid: errors.length === 0,
  errors,
  alerts: launchAlertCatalog.map(([id, severity, condition]) => ({
    id, severity, condition,
  })),
}, null, 2));
if (errors.length) process.exitCode = 1;
