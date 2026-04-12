// Base adapter interface for all integration types.
//
// Every adapter must implement:
//   name        — unique string identifier (e.g. "webhook", "slack")
//   handleEvent — async (userId, eventType, payload) => { results: [] }
//
// Results array contains one entry per delivery attempted:
//   { integrationId?, status: "success"|"failed", error?, responseData? }

/**
 * @typedef {Object} AdapterResult
 * @property {string}  [integrationId]
 * @property {"success"|"failed"} status
 * @property {string}  [error]
 * @property {object}  [responseData]
 */

/**
 * @typedef {Object} IntegrationAdapter
 * @property {string} name
 * @property {(userId: string, eventType: string, payload: object) => Promise<AdapterResult[]>} handleEvent
 */

export class BaseAdapter {
  /** @type {string} */
  name = "base";

  /**
   * Dispatch an event for all active instances of this integration type.
   * Subclasses must override this.
   *
   * @param {string} userId
   * @param {string} eventType
   * @param {object} payload
   * @returns {Promise<AdapterResult[]>}
   */
  async handleEvent(userId, eventType, payload) {
    throw new Error(`${this.name}.handleEvent() not implemented`);
  }
}
