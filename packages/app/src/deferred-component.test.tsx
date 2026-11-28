import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { deferredComponent } from "./deferred-component";

it("downloads an optional editor once and applies props received during the download", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  let finish!: (module: {
    default: (props: { value: string }) => React.JSX.Element;
  }) => void;
  const load = vi.fn(
    () =>
      new Promise<{ default: (props: { value: string }) => React.JSX.Element }>(
        (resolve) => {
          finish = resolve;
        },
      ),
  );
  const Editor = deferredComponent(load, "Markdown editor");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    expect(load).not.toHaveBeenCalled();
    await act(async () => {
      root.render(<Editor value="Initial source" />);
    });
    expect(host.textContent).toContain("Loading Markdown editor");
    await act(async () => {
      root.render(<Editor value="New source received while loading" />);
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({
        default: ({ value }) => (
          <textarea data-testid="loaded-source" value={value} readOnly />
        ),
      });
    });
    expect(
      host.querySelector<HTMLTextAreaElement>('[data-testid="loaded-source"]')
        ?.value,
    ).toBe("New source received while loading");
    await act(async () => {
      root.render(
        <>
          <Editor value="Working source" />
          <Editor value="Preview source" />
        </>,
      );
    });
    expect(
      [
        ...host.querySelectorAll<HTMLTextAreaElement>(
          '[data-testid="loaded-source"]',
        ),
      ].map((element) => element.value),
    ).toEqual(["Working source", "Preview source"]);
    expect(load).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("lets a failed download be retried without losing the surrounding draft", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const load = vi
    .fn<
      () => Promise<{
        default: (props: { value: string }) => React.JSX.Element;
      }>
    >()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValue({ default: ({ value }) => <p>{value}</p> });
  const Editor = deferredComponent(load, "Markdown editor");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <>
          <textarea
            data-testid="surrounding-draft"
            defaultValue="Unsaved comment"
          />
          <Editor value="Current source" />
        </>,
      );
    });
    expect(
      host.querySelector('[data-testid="feature-download-error"]')?.textContent,
    ).toContain("could not be downloaded");
    const draft = host.querySelector<HTMLTextAreaElement>(
      '[data-testid="surrounding-draft"]',
    );
    if (!draft) throw new Error("Missing surrounding draft");
    draft.value = "Still typing while offline";
    await act(async () => {
      const retry = host.querySelector<HTMLButtonElement>(
        '[data-testid="feature-download-retry"]',
      );
      if (!retry) throw new Error("Missing download retry");
      retry.click();
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls).toEqual([[0], [1]]);
    expect(host.textContent).toContain("Current source");
    expect(host.querySelector('[data-testid="surrounding-draft"]')).toBe(draft);
    expect(draft.value).toBe("Still typing while offline");
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('"event":"feature.download_failed"'),
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    error.mockRestore();
  }
});
