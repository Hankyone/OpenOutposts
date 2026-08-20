// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it } from "vitest";
import { SessionReadiness, type ReadinessItem } from "./session-readiness";

expect.extend(matchers);

afterEach(cleanup);

const items: ReadinessItem[] = [
  { label: "Homestead", value: "Connected", tone: "ready" },
  { label: "Machine", value: "MacBook offline", tone: "blocked", href: "/machines" },
  { label: "Provider key", value: "Connected", tone: "ready" },
  { label: "Model", value: "Ready", tone: "ready" },
  { label: "Repository", value: "acme/web", tone: "neutral" },
];

describe("SessionReadiness", () => {
  it("renders the five preflight answers as one compact list", () => {
    render(<SessionReadiness items={items} />);

    const list = screen.getByRole("list", { name: "Session readiness" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(within(list).getByText("Homestead")).toBeInTheDocument();
    expect(within(list).getByText("acme/web")).toBeInTheDocument();
  });

  it("uses the existing repair surface for a failed check", () => {
    render(<SessionReadiness items={items} />);

    expect(screen.getByRole("link", { name: "MacBook offline" })).toHaveAttribute(
      "href",
      "/machines"
    );
  });
});
