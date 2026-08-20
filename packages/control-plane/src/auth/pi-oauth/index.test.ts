import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_SIGN_IN_CATALOG,
  SUBSCRIPTION_SIGN_IN_PROVIDERS,
  getSubscriptionOAuthAdapter,
  getSubscriptionOAuthAdapterIfKnown,
  isSubscriptionSignInProvider,
} from "./index";

describe("subscription sign-in catalog", () => {
  it("lists every bundled Pi subscription login without loading Pi extensions", () => {
    expect(SUBSCRIPTION_SIGN_IN_PROVIDERS).toEqual([
      "anthropic",
      "openai-codex",
      "openrouter",
      "github-copilot",
      "kimi-coding",
      "xai",
    ]);
    expect(SUBSCRIPTION_SIGN_IN_CATALOG.map((entry) => entry.id)).toEqual([
      ...SUBSCRIPTION_SIGN_IN_PROVIDERS,
    ]);
    for (const id of SUBSCRIPTION_SIGN_IN_PROVIDERS) {
      const adapter = getSubscriptionOAuthAdapter(id);
      expect(adapter.id).toBe(id);
      expect(adapter.flow).toBe(
        SUBSCRIPTION_SIGN_IN_CATALOG.find((entry) => entry.id === id)?.flow
      );
    }
    expect(getSubscriptionOAuthAdapterIfKnown("openai")).toBeNull();
    expect(isSubscriptionSignInProvider("anthropic")).toBe(true);
    expect(isSubscriptionSignInProvider("not-a-provider")).toBe(false);
  });
});
