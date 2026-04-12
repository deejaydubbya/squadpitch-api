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

const ALL_EVENTS = ["POST_PUBLISHED", "POST_FAILED", "BATCH_COMPLETE", "CONNECTION_EXPIRED"];

export class BaseAdapter {
  /** @type {string} */
  name = "base";

  /**
   * Check whether an integration should handle this event type
   * based on its subscribedEvents config. Always allows "TEST" through.
   *
   * @param {object} config — integration config JSON
   * @param {string} eventType
   * @returns {boolean}
   */
  shouldHandle(config, eventType) {
    if (eventType === "TEST") return true;
    const events = Array.isArray(config?.subscribedEvents)
      ? config.subscribedEvents
      : ALL_EVENTS;
    return events.includes(eventType);
  }

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
