// Google Drive adapter — media import integration.
//
// Drive is a file-source integration (not event-driven), so handleEvent
// returns [] (no-op). The adapter exists so the type is recognized by
// the adapter registry and CRUD routes.

import { BaseAdapter } from "./base.adapter.js";

export class DriveAdapter extends BaseAdapter {
  name = "google_drive";

  async handleEvent(_userId, _eventType, _payload) {
    // Drive is not event-driven — files are imported on demand.
    return [];
  }
}
