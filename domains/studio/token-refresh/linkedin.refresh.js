// LinkedIn token refresh adapter.
// LinkedIn standard OAuth v2 tokens have no refresh token.
// When they expire, the user must re-authenticate via OAuth.

export const linkedinRefresh = {
  async refresh() {
    return { canRefresh: false };
  },
};
