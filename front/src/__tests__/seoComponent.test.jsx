import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { PUBLIC_ROUTES } from "../seo/meta.js";
import Seo from "../seo/Seo.jsx";

describe("<Seo />", () => {
  it("sets the head for the current route and follows client navigation", async () => {
    const user = userEvent.setup();
    const { getByText } = render(
      <MemoryRouter initialEntries={["/pricing"]}>
        <Seo />
        <Link to="/admin?x=1">admin</Link>
        <Link to="/nowhere">nowhere</Link>
        <Link to="/team">team</Link>
      </MemoryRouter>
    );
    expect(document.title).toBe(PUBLIC_ROUTES["/pricing"].title);
    expect(document.querySelector('link[rel="canonical"]').href).toBe("https://dfwsc.com/pricing");

    await user.click(getByText("admin"));
    expect(document.title).toBe("Admin - DFW Software Consulting");
    expect(document.querySelector('meta[name="robots"]').content).toBe("noindex,nofollow");

    await user.click(getByText("nowhere"));
    expect(document.title).toBe("Page Not Found - DFW Software Consulting");
    expect(document.querySelector('meta[name="robots"]').content).toBe("noindex,nofollow");

    await user.click(getByText("team"));
    expect(document.title).toBe(PUBLIC_ROUTES["/team"].title);
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
  });
});
