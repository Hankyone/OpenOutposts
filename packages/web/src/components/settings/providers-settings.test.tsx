// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import { MODEL_CATALOG_KEY, type ModelCatalogView } from "@/hooks/use-model-catalog";
import {
  PROVIDER_CREDENTIALS_KEY,
  PROVIDER_OAUTH_METHODS_KEY,
  type ProviderCredential,
  type ProviderOAuthMethod,
} from "@/hooks/use-provider-credentials";
import { ProvidersSettings } from "./providers-settings";

expect.extend(matchers);

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({
    data: { user: { name: "test" } },
    status: "authenticated",
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const CATALOG: ModelCatalogView = {
  source: "homestead",
  reportedAt: "2026-07-27T00:00:00.000Z",
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      models: [
        {
          id: "anthropic/claude-sonnet-5",
          providerId: "anthropic",
          modelId: "claude-sonnet-5",
          name: "Sonnet 5",
          description: null,
          reasoning: null,
          contextWindow: null,
          maxTokens: null,
          inProductCatalog: false,
        },
      ],
    },
  ],
  unconnectedProviders: [{ id: "openai", name: "OpenAI", modelCount: 4 }],
};

const CREDENTIAL: ProviderCredential = {
  id: "cred-1",
  provider: "anthropic",
  label: "Personal key",
  kind: "api_key",
  createdAt: Date.now() - 3 * 60 * 60 * 1000,
  updatedAt: Date.now() - 3 * 60 * 60 * 1000,
  lastUsedAt: null,
  expiresAt: null,
};

const METHODS: ProviderOAuthMethod[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude Pro/Max)",
    loginLabel: "Sign in with Claude Pro/Max",
    flow: "authorization_code",
  },
  {
    id: "xai",
    name: "xAI (Grok/X subscription)",
    loginLabel: "Sign in with SuperGrok or X Premium",
    flow: "device_code",
  },
];

function renderSettings(options?: {
  catalog?: ModelCatalogView;
  credentials?: ProviderCredential[];
  methods?: ProviderOAuthMethod[];
}) {
  return render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        fallback: {
          [MODEL_CATALOG_KEY]: options?.catalog ?? CATALOG,
          [PROVIDER_CREDENTIALS_KEY]: { credentials: options?.credentials ?? [CREDENTIAL] },
          [PROVIDER_OAUTH_METHODS_KEY]: { methods: options?.methods ?? METHODS },
        },
        dedupingInterval: Infinity,
        revalidateOnFocus: false,
        revalidateIfStale: false,
        revalidateOnReconnect: false,
      }}
    >
      <ProvidersSettings />
    </SWRConfig>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProvidersSettings", () => {
  it("shows a connected provider as metadata only, with no secret anywhere", () => {
    const { container } = renderSettings();

    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText(/Personal key/)).toBeInTheDocument();
    expect(screen.getByText(/never used/)).toBeInTheDocument();
    // Nothing resembling key material, masked or otherwise, reaches the page:
    // the response the page reads has no field for one.
    expect(container.textContent).not.toMatch(/sk-|•{3}|\*{3}/);
  });

  it("offers to connect a provider the harness supports but the user has not", () => {
    renderSettings();

    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText(/Not connected • 4 models/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect OpenAI" })).toBeInTheDocument();
  });

  it("writes a key through the credential route and never reads it back", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: "created" })));
    vi.stubGlobal("fetch", fetchMock);

    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Connect OpenAI" }));

    const keyInput = screen.getByLabelText("API key");
    expect(keyInput).toHaveAttribute("type", "password");
    fireEvent.change(keyInput, { target: { value: "test-key-value" } });
    // The row's own button now reads "Cancel", so this is the form's submit.
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/provider-credentials/openai");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ apiKey: "test-key-value", label: null });

    // The form closes on success, so the entered key is not left in the DOM.
    await waitFor(() => expect(screen.queryByLabelText("API key")).not.toBeInTheDocument());
  });

  it("removes a key after confirmation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: "deleted" })));
    vi.stubGlobal("fetch", fetchMock);

    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Remove Anthropic key" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/provider-credentials/anthropic");
    expect(init.method).toBe("DELETE");
  });

  it("says so when no homestead has reported which providers exist", () => {
    renderSettings({
      catalog: { source: "unavailable", reportedAt: null, providers: [], unconnectedProviders: [] },
      credentials: [],
    });

    expect(screen.getByText(/No homestead has reported/)).toBeInTheDocument();
    // The bundled list still gives the user something to connect.
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
  });

  it("starts paste-code subscription sign-in without putting the verifier on the page", async () => {
    window.open = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          flow: "authorization_code",
          provider: "anthropic",
          authorizeUrl: "https://claude.ai/oauth/authorize?code_challenge=abc",
          instructions: "Complete sign-in in the browser, then paste the redirected localhost URL.",
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Claude Pro/Max" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/provider-credentials/anthropic/oauth/start");
    expect(init.method).toBe("POST");
    expect(window.open).toHaveBeenCalledWith(
      "https://claude.ai/oauth/authorize?code_challenge=abc",
      "_blank",
      "noopener,noreferrer"
    );

    expect(await screen.findByLabelText("Authorization code or redirect URL")).toBeInTheDocument();
    expect(screen.getByText(/Complete sign-in in the browser/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("verifier");
  });

  it("completes a pasted authorization code through the credential route", async () => {
    window.open = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            flow: "authorization_code",
            provider: "anthropic",
            authorizeUrl: "https://claude.ai/oauth/authorize?x=1",
            instructions: "paste",
          })
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "created" })));
    vi.stubGlobal("fetch", fetchMock);

    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Claude Pro/Max" }));
    const paste = await screen.findByLabelText("Authorization code or redirect URL");
    fireEvent.change(paste, {
      target: { value: "http://localhost:53692/callback?code=the-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete sign-in" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/provider-credentials/anthropic/oauth/complete");
    expect(JSON.parse(init.body)).toEqual({
      code: "http://localhost:53692/callback?code=the-code",
    });
  });

  it("shows a device code for headless subscription sign-in", async () => {
    window.open = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          flow: "device_code",
          provider: "xai",
          userCode: "ABCD-EFGH",
          verificationUri: "https://auth.x.ai/device",
          intervalSeconds: 60,
          expiresInSeconds: 900,
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with SuperGrok or X Premium" }));

    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /device sign-in/i })).toHaveAttribute(
      "href",
      "https://auth.x.ai/device"
    );
  });

  it("describes an OAuth grant as signed in, still without the secret", () => {
    const { container } = renderSettings({
      credentials: [
        {
          ...CREDENTIAL,
          kind: "oauth_grant",
          label: "Sign in with Claude Pro/Max",
          expiresAt: Date.now() + 3600_000,
        },
      ],
    });
    expect(screen.getByText(/Signed in/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/sk-|oauth-access|refresh/);
  });

  it("keeps API key connect working next to subscription sign-in", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: "created" })));
    vi.stubGlobal("fetch", fetchMock);

    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Connect OpenAI" }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "test-key-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/provider-credentials/openai");
  });
});
