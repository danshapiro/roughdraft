import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  extractRoughdraftReviewIndex,
  type ReconcileRequest,
} from "@roughdraft/rfm";
import type { ComparisonReviewData } from "../src/comparison-types";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const headers = { Connection: "close" };
const fixtureDirectory = fileURLToPath(
  new URL("../../../docs/spec/fixtures/", import.meta.url),
);
const original = fs.readFileSync(
  path.join(fixtureDirectory, "editing-review.md"),
  "utf8",
);
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function withOwners(source: string, beforeHistory = false) {
  const endmatter = source.lastIndexOf("\n---\n");
  expect(endmatter).toBeGreaterThan(0);
  const owners = "Live owner A: unchanged.\n\nLive owner B: unchanged.";
  if (beforeHistory) {
    const heading = source.search(/^# /m);
    expect(heading).toBeGreaterThanOrEqual(0);
    return `${source.slice(0, heading)}${owners}\n\n${source.slice(heading)}`;
  }
  return `${source.slice(0, endmatter)}\n\n${owners}\n${source.slice(endmatter)}`;
}
async function readReview(
  request: APIRequestContext,
  id: string,
): Promise<ComparisonReviewData> {
  const response = await request.get(`${api}/${id}`, { headers });
  await expect(response).toBeOK();
  return response.json();
}
async function historyCount(request: APIRequestContext, id: string) {
  const review = await readReview(request, id);
  if (!review.draft)
    throw new Error("Expected the saved review's actual draft");
  // The shared merge omits the optional field when no History entries remain.
  return (review.draft.reviewed ?? []).length;
}
async function createReview(
  request: APIRequestContext,
  project: string,
  source: string,
) {
  const target = writeProjectFile(project, "review.md", source);
  fs.cpSync(
    path.join(fixtureDirectory, "editing-review-assets"),
    path.join(project, "editing-review-assets"),
    { recursive: true },
  );
  fs.copyFileSync(
    path.join(fixtureDirectory, "editing-review-linked.md"),
    path.join(project, "editing-review-linked.md"),
  );
  const response = await request.post(`${api}/document`, {
    headers,
    data: {
      targetPath: target,
      autosave: target,
      handoff: "button",
      title: "Review release-plan history and feedback across two pages",
    },
  });
  await expect(response).toBeOK();
  const { id } = await response.json();
  return { target, id: id as string };
}
async function ready(page: Page) {
  await expect(richTextEditor(page)).toBeVisible();
  await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
    "aria-label",
    /^(Review saved|Saved to file)$/,
  );
}
function owner(page: Page, name: string) {
  return richTextEditor(page)
    .getByRole("paragraph")
    .filter({ hasText: `Live owner ${name}:` });
}
async function append(page: Page, name: string, text: string) {
  await owner(page, name).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(text);
}
async function openHistory(page: Page) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  const button = page.getByTestId("revision-reviewed");
  if (!(await button.isVisible()))
    await page.getByTestId("revision-more").click();
  await button.click();
  const history = page.getByTestId("revision-reviewed-dialog");
  await expect(history).toBeVisible();
  return history;
}
function comments(markdown: string) {
  return extractRoughdraftReviewIndex(markdown)
    .items.filter((item) => item.kind !== "suggestion")
    .map((item) => ({ id: item.id, text: item.text, parentId: item.parentId }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

test("two pages editing above History reopen the actual passages when identical text exists nearby", async ({
  page,
  browser,
  request,
}, testInfo) => {
  const project = createMarkdownProject("live-history-peer");
  const peerContext = await browser.newContext();
  const peer = await peerContext.newPage();
  const held = deferred();
  let captured = false;
  const keepDecoy =
    "History Keep example: the release notes are deliberately clear.";
  const revertDecoy =
    "History Revert example: we keep the comment history alongside the document.";
  const source = withOwners(
    original
      .replace("History Keep example:", `${keepDecoy}\n\nHistory Keep example:`)
      .replace(
        "History Revert example:",
        `${revertDecoy}\n\nHistory Revert example:`,
      ),
    true,
  );
  try {
    const { id, target } = await createReview(request, project, source);
    const url = new URL(`/?comparison=${id}`, testInfo.project.use.baseURL)
      .href;
    await Promise.all([page.goto(url), peer.goto(url)]);
    await Promise.all([ready(page), ready(peer)]);
    for (const [suggestion, decision] of [
      ["s10", "accept"],
      ["s11", "reject"],
    ] as const) {
      await page
        .getByTestId(`comment-rail-${suggestion}-action-${decision}`)
        .click();
      await expect
        .poll(
          async () => (await readReview(request, id)).draft?.reviewed?.length,
        )
        .toBe(suggestion === "s10" ? 1 : 2);
    }
    const initialHistory = await openHistory(peer);
    await expect(
      initialHistory.getByTestId("revision-reopen-change"),
    ).toHaveCount(2);
    await peer.keyboard.press("Escape");

    await page.route(`**/api/comparisons/${id}/reconcile`, async (route) => {
      const body = route.request().postDataJSON() as ReconcileRequest;
      if (!captured && body.draft.markdown.includes("LocalA-history")) {
        captured = true;
        await held.promise;
      }
      await route.continue();
    });
    await append(page, "A", " LocalA-history");
    await expect.poll(() => captured).toBe(true);
    await selectRichText(peer, "Try Roughdraft's editing and comment fixes");
    await peer.keyboard.press("ArrowLeft");
    await peer.keyboard.insertText("Peer inserted above History. ");
    await expect
      .poll(() => fs.readFileSync(target, "utf8"))
      .toContain("Peer inserted above History.");
    expect(fs.readFileSync(target, "utf8")).not.toContain("LocalA-history");
    held.resolve();
    await expect
      .poll(async () => {
        const draft = (await readReview(request, id)).draft;
        return (
          draft?.cleanMarkdown?.includes("Peer inserted above History.") &&
          draft.cleanMarkdown.includes("LocalA-history")
        );
      })
      .toBe(true);
    for (const view of [page, peer])
      await expect(view.getByTestId("revision-conflict")).toHaveCount(0);

    for (const [id, phrase, prefix] of [
      ["s10", "deliberately clear", "History Keep example:"],
      ["s11", "keep the comment history", "History Revert example:"],
    ] as const) {
      const history = await openHistory(page);
      const reopen = history
        .getByTestId("revision-reviewed-entry")
        .filter({ hasText: phrase })
        .getByTestId("revision-reopen-change");
      await expect(reopen).toBeEnabled();
      await reopen.click();
      await expect(history).toBeHidden();
      const repeated = richTextEditor(page)
        .getByRole("paragraph")
        .filter({ hasText: prefix });
      await expect(repeated).toHaveCount(2);
      await expect(
        repeated.nth(0).locator(`[data-critic-change-id="${id}"]`),
      ).toHaveCount(0);
      await expect(
        repeated.nth(1).locator(`[data-critic-change-id="${id}"]`),
      ).toHaveCount(1);
      await expect(
        peer.getByTestId(`comment-rail-${id}-action-accept`),
      ).toBeVisible();
    }
    const file = fs.readFileSync(target, "utf8");
    expect(file).toContain(keepDecoy);
    expect(file).toContain(revertDecoy);
    expect(file).toContain("Peer inserted above History.");
    expect(file).toContain("LocalA-history");
    await expect.poll(() => historyCount(request, id)).toBe(0);
  } finally {
    held.resolve();
    await peerContext.close();
    removeMarkdownProject(project);
  }
});

for (const sameProposal of [false, true]) {
  test(
    sameProposal
      ? "two pages making the same proposal decision keep one reopenable History event"
      : "two pages keep independent new decisions and can reopen both History entries",
    async ({ page, browser, request }, testInfo) => {
      test.setTimeout(45_000);
      const project = createMarkdownProject("live-independent-history");
      const peerContext = await browser.newContext();
      const peer = await peerContext.newPage();
      const held = deferred();
      let captured = false;
      let ownCommitted = false;
      try {
        const { id, target } = await createReview(request, project, original);
        const url = new URL(`/?comparison=${id}`, testInfo.project.use.baseURL)
          .href;
        await Promise.all([page.goto(url), peer.goto(url)]);
        await Promise.all([ready(page), ready(peer)]);
        page.on("response", async (response) => {
          if (!response.url().endsWith(`/${id}/reconcile`)) return;
          try {
            const result = await response.json();
            if (
              captured &&
              result.status === "committed" &&
              result.state?.draft.reviewed?.some(
                (entry: { keptIds?: string[] }) =>
                  entry.keptIds?.includes("s10"),
              )
            )
              ownCommitted = true;
          } catch {
            // Fixture cleanup can cancel an already-observed response body.
          }
        });
        await page.route(
          `**/api/comparisons/${id}/reconcile`,
          async (route) => {
            const body = route.request().postDataJSON() as ReconcileRequest;
            if (
              !captured &&
              body.draft.reviewed?.some((entry) => entry.decision === "accept")
            ) {
              captured = true;
              await held.promise;
            }
            await route.continue();
          },
        );
        await page.getByTestId("comment-rail-s10-action-accept").click();
        await expect.poll(() => captured).toBe(true);
        await peer
          .getByTestId(
            sameProposal
              ? "comment-rail-s10-action-accept"
              : "comment-rail-s11-action-reject",
          )
          .click();
        await expect
          .poll(
            async () => (await readReview(request, id)).draft?.reviewed?.length,
          )
          .toBe(1);
        held.resolve();
        await expect.poll(() => ownCommitted).toBe(true);
        await expect
          .poll(
            async () => (await readReview(request, id)).draft?.reviewed?.length,
          )
          .toBe(sameProposal ? 1 : 2);
        const committed = await readReview(request, id);
        expect(
          new Set(committed.draft?.reviewed?.map((entry) => entry.id)).size,
        ).toBe(sameProposal ? 1 : 2);
        expect(
          committed.draft?.reviewed?.map((entry) => entry.decision).sort(),
        ).toEqual(sameProposal ? ["accept"] : ["accept", "reject"]);

        for (const [view, other, id, phrase] of [
          [page, peer, "s10", "deliberately clear"],
          [peer, page, "s11", "keep the comment history"],
        ] as const) {
          if (sameProposal && id === "s11") continue;
          const history = await openHistory(view);
          const reopen = history
            .getByTestId("revision-reviewed-entry")
            .filter({ hasText: phrase })
            .getByTestId("revision-reopen-change");
          await expect(reopen).toBeEnabled();
          await reopen.click();
          await expect(
            other.getByTestId(`comment-rail-${id}-action-accept`),
          ).toBeVisible();
        }
        await expect.poll(() => historyCount(request, id)).toBe(0);
        const final = await readReview(request, id);
        expect(comments(final.draft?.markdown ?? "")).toEqual(
          comments(original),
        );
        for (const view of [page, peer])
          await expect(view.getByTestId("revision-conflict")).toHaveCount(0);
        await expect
          .poll(() => fs.readFileSync(target, "utf8"))
          .toBe(final.draft?.cleanMarkdown);
        fs.writeFileSync(
          testInfo.outputPath("independent-history-decisions.json"),
          JSON.stringify(
            {
              sameProposal,
              committed: committed.draft?.reviewed?.map((entry) => ({
                id: entry.id,
                decision: entry.decision,
                oldText: entry.oldText,
                newText: entry.newText,
              })),
              finalHistory: final.draft?.reviewed,
              comments: final.reviewComments.length,
            },
            null,
            2,
          ),
        );
      } finally {
        held.resolve();
        await peerContext.close();
        removeMarkdownProject(project);
      }
    },
  );
}

test("Send feedback commits within two seconds while the other page keeps typing", async ({
  page,
  browser,
  request,
}, testInfo) => {
  const project = createMarkdownProject("live-send-peer");
  const peerContext = await browser.newContext();
  const peer = await peerContext.newPage();
  const held = deferred();
  let captured: ReconcileRequest | null = null;
  let typing: Promise<void> | null = null;
  let typingFinished = false;
  const peerText = ` LocalB-${"abcdefghij".repeat(9)}`;
  const message = "Please review the terminology and retained comment threads.";
  try {
    const { id, target } = await createReview(
      request,
      project,
      withOwners(original),
    );
    const url = new URL(`/?comparison=${id}`, testInfo.project.use.baseURL)
      .href;
    await Promise.all([page.goto(url), peer.goto(url)]);
    await Promise.all([ready(page), ready(peer)]);
    await page.route(`**/api/comparisons/${id}/send`, async (route) => {
      if (!captured) {
        captured = route.request().postDataJSON() as ReconcileRequest;
        await held.promise;
      }
      await route.continue();
    });
    await append(page, "A", " LocalA-send");
    const send = page.getByTestId("revision-send");
    if (!(await send.isVisible()))
      await page.getByTestId("revision-more").click();
    await send.click();
    await page.getByTestId("revision-feedback").fill(message);
    await page.getByTestId("revision-send-confirm").click();
    await expect.poll(() => captured !== null).toBe(true);
    await owner(peer, "B").click();
    await peer.keyboard.press("End");
    typing = peer.keyboard.type(peerText, { delay: 60 }).then(() => {
      typingFinished = true;
    });
    await expect
      .poll(async () => (await readReview(request, id)).draft?.cleanMarkdown)
      .toContain("LocalB-");
    expect(typingFinished).toBe(false);
    held.resolve();
    await expect
      .poll(async () => (await readReview(request, id)).feedback?.comment, {
        timeout: 2000,
      })
      .toBe(message);
    expect(typingFinished).toBe(false);
    const sent = (await readReview(request, id)).feedback;
    expect(sent?.draft.cleanMarkdown).toContain("LocalA-send");
    expect(sent?.draft.cleanMarkdown).toContain("LocalB-");
    expect(comments(sent?.draft.markdown ?? "")).toEqual(comments(original));
    expect((captured as ReconcileRequest | null)?.writeFile).toBe(false);
    await typing;
    await expect
      .poll(() => fs.readFileSync(target, "utf8"))
      .toContain(peerText);
    await expect(owner(peer, "B")).toContainText(peerText);
    for (const view of [page, peer])
      await expect(view.getByTestId("revision-conflict")).toHaveCount(0);
  } finally {
    held.resolve();
    await typing?.catch(() => {});
    await peerContext.close();
    removeMarkdownProject(project);
  }
});
