// Meta (Instagram + Facebook) token refresh adapter.
// Meta long-lived tokens last ~60 days and have no refresh token.
// When they expire, the user must re-authenticate via OAuth.

export const metaRefresh = {
  async refresh() {
    return { canRefresh: false };
  },
};
