// Factory for stub channel adapters.
//
// All three non-Instagram channels share the same behavior in Phase 2:
// throw 501 ADAPTER_NOT_IMPLEMENTED. Rather than duplicating the same
// ~15 lines across three files, they're all minted from this factory
// in the channelAdapters index.

export function createStubAdapter(channel) {
  const notImplemented = () => {
    throw Object.assign(
      new Error(`${channel} publishing not yet implemented`),
      { status: 501, code: "ADAPTER_NOT_IMPLEMENTED" }
    );
  };
  return {
    channel,
    async validatePublishTarget() {
      notImplemented();
    },
    async publishPost() {
      notImplemented();
    },
  };
}
