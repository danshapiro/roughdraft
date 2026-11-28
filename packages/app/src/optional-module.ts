/**
 * A failed module fetch stays rejected in the browser's module map. An explicit
 * retry therefore needs a fresh entry URL. Rollup supplies that exact compiled
 * URL; relative dependencies retain their identity, including the shared React.
 */
export function optionalModule<Module>(
  firstLoad: () => Promise<Module>,
  entryUrl: string,
  attempt: number,
): Promise<Module> {
  if (attempt === 0) return firstLoad();
  const url = new URL(entryUrl, document.baseURI);
  url.searchParams.set("roughdraft-retry", String(attempt));
  return import(/* @vite-ignore */ url.href) as Promise<Module>;
}
