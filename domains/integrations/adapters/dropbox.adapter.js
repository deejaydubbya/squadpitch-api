// Dropbox adapter — media import integration.
//
// Dropbox is a file-source integration (not event-driven), so handleEvent
// returns [] (no-op). The adapter exists so the type is recognized by
// the adapter registry and CRUD routes.

import { BaseAdapter } from "./base.adapter.js";

export class DropboxAdapter extends BaseAdapter {
  name = "dropbox";

  async handleEvent(_userId, _eventType, _payload) {
    // Dropbox is not event-driven — files are imported on demand.
    return [];
  }
}
