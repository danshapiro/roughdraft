// The serving application or reverse proxy supplies a <base> element. Document
// paths never determine the deployment prefix.
export function browserBasePath(): string {
  const href =
    typeof document === "undefined"
      ? null
      : document.querySelector("base")?.getAttribute("href");
  return href ? new URL(href, document.URL).pathname : "/";
}

export function browserPath(
  route: string,
  base: string = browserBasePath(),
): string {
  return route.startsWith(base) ? route : base + route.replace(/^\/+/, "");
}

export function browserRoutePath(
  pathname: string = window.location.pathname,
  base: string = browserBasePath(),
): string {
  return base === "/" || !pathname.startsWith(base)
    ? pathname
    : `/${pathname.slice(base.length)}`;
}

export function browserNavigationUrl(
  value: string,
  location: Pick<Location, "origin" | "pathname"> = window.location,
): string {
  const requested = new URL(value, location.origin);
  // Open requests may originate at a private backend. Keep this tab's public
  // origin and deployment prefix when opening another document.
  return new URL(
    browserPath(
      requested.pathname + requested.search + requested.hash,
      browserBasePath(),
    ),
    location.origin,
  ).href;
}

export function browserAnchorPath(href: string): string {
  if (
    typeof window !== "undefined" &&
    href.startsWith("#") &&
    (window.location.pathname !== "/" || window.location.search !== "")
  ) {
    // The asset base must not send an in-document anchor to a different file.
    return window.location.pathname + window.location.search + href;
  }
  return href;
}
