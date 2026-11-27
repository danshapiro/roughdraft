import fs from "node:fs";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  extractRoughdraftReviewIndex,
  type ReconcileRequest,
  reviewDraftSignature,
  type SyncResult,
} from "@roughdraft/rfm";
import type { ComparisonReviewData } from "../src/comparison-types";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const headers = { Connection: "close" };
const source = `---
title: Review the release plan together
---

# Release plan

Alpha owner: ready.

Beta owner: ready.

An existing proposal {++must survive++}{#s1} without being accepted.

Keep the {==existing context==}{>>This original comment must remain attached.<<}{#c1}.

## Validation

1. Review both independent proposals.
2. Keep the discussion attached to its original proposal.

---
comments:
  c1:
    by: AI
    at: "2026-11-22T12:00:00.000Z"
suggestions:
  s1:
    by: AI
    at: "2026-11-22T12:00:00.000Z"
`;
const alphaInitial = "Alpha-a";
const alphaComplete = "Alpha-a-continued";
const replyText = "This unfinished reply belongs to Alpha's own proposal.";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function proposals(markdown: string) {
  const byId = new Map<string, string>();
  for (const item of extractRoughdraftReviewIndex(markdown).items) {
    if (item.kind !== "suggestion") continue;
    // One logical insertion can span multiple serialized mark fragments.
    const text = (item.replacementText ?? item.text).replaceAll("\\-", "-");
    byId.set(item.id, (byId.get(item.id) ?? "") + text);
  }
  return [...byId].map(([id, text]) => ({ id, text }));
}
function matchingProposal(markdown: string, text: string) {
  return proposals(markdown).filter((item) => item.text.includes(text));
}
function onlyProposal(markdown: string, text: string) {
  const found = matchingProposal(markdown, text);
  expect(found, `one proposal for ${text}`).toHaveLength(1);
  expect(found[0].text).toBe(text);
  return found[0];
}
async function readReview(request: APIRequestContext, id: string) {
  const response = await request.get(`${api}/${id}`, { headers });
  await expect(response).toBeOK();
  return (await response.json()) as ComparisonReviewData;
}
async function saved(page: Page) {
  await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
    "aria-label",
    /^(Review saved|Saved to file)$/,
  );
}
async function suggest(page: Page) {
  await page.getByTestId("revision-mode").click();
  await page.getByTestId("revision-mode-suggest").click();
  await expect(page.getByTestId("revision-mode")).toContainText("Suggest");
}
async function append(
  page: Page,
  owner: string,
  text: string,
  continuous = false,
) {
  await richTextEditor(page)
    .getByRole("paragraph")
    .filter({ hasText: `${owner} owner:` })
    .click();
  await page.keyboard.press("End");
  if (continuous) await page.keyboard.type(text, { delay: 20 });
  else await page.keyboard.insertText(text);
}
function installBannerRecorder() {
  const scope = window as Window & { collisionBanners: string[] };
  scope.collisionBanners = [];
  Reflect.set(window, "roughdraftProfile", { entries: [] });
  new MutationObserver(() => {
    const text = document
      .querySelector('[data-testid="revision-conflict"]')
      ?.textContent?.trim();
    if (text && scope.collisionBanners.at(-1) !== text)
      scope.collisionBanners.push(text);
  }).observe(document, { childList: true, subtree: true, characterData: true });
}
async function noConflictBanners(page: Page) {
  await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(window, "collisionBanners")),
  ).toEqual([]);
}

for (const { peer, arrival } of [
  { peer: "another Suggest tab", arrival: "response" },
  { peer: "an agent's disk edit", arrival: "response" },
  { peer: "another Suggest tab", arrival: "state-before-response" },
] as const) {
  const arrivalLabel =
    arrival === "state-before-response"
      ? " with the state echo arriving first"
      : "";
  test(`a proposal ID collision with ${peer} preserves continued typing and an unfinished reply through an unacknowledged-save reload${arrivalLabel}`, async ({
    page,
    browser,
    request,
    baseURL,
  }, testInfo) => {
    test.setTimeout(45_000);
    const project = createMarkdownProject("suggestion-id-collision");
    const target = writeProjectFile(project, "release-plan.md", source);
    const peerContext = await browser.newContext();
    const second = await peerContext.newPage();
    const sendInitial = deferred();
    const releaseAcknowledgment = deferred();
    const releaseOldState = deferred();
    let reloaded = false;
    let closing = false;
    let initialRequest: ReconcileRequest | undefined;
    let savedRenumbered: SyncResult<ComparisonReviewData> | undefined;
    let committedOperation: string | undefined;
    let echoedOperation: string | undefined;
    const wire: Record<string, unknown>[] = [];
    let expectedDisk = source;
    try {
      await page.addInitScript(installBannerRecorder);
      await second.addInitScript(installBannerRecorder);
      const created = await request.post(`${api}/document`, {
        headers,
        data: {
          targetPath: target,
          autosave: "none",
          handoff: "chat",
          title: "Review two independent release proposals and their replies",
        },
      });
      await expect(created).toBeOK();
      const { id } = (await created.json()) as { id: string };
      page.on("response", async (response) => {
        if (
          !response.url().includes(`/api/comparisons/${id}/state`) ||
          response.status() !== 200
        )
          return;
        try {
          const value = await response.json();
          const state = value.state ?? value;
          if (
            committedOperation &&
            state.review?.lastOperation?.id === committedOperation
          ) {
            echoedOperation = committedOperation;
            wire.push({
              kind: "actual-state-echo",
              operationId: echoedOperation,
              revision: state.revision,
            });
          }
        } catch {
          // Reload intentionally cancels the previous page's held reads.
        }
      });
      const url = new URL(`/?comparison=${id}`, baseURL).href;
      await page.goto(url);
      if (peer === "another Suggest tab") await second.goto(url);
      await saved(page);
      await suggest(page);
      if (peer === "another Suggest tab") {
        await saved(second);
        await suggest(second);
      }
      expect(fs.readFileSync(target, "utf8")).toBe(source);

      // The guarded response introduces the initial collision. The event-first
      // case releases real live reads only after the renumbered save commits.
      await page.route(`**/api/comparisons/${id}/state**`, async (route) => {
        if (!reloaded) await releaseOldState.promise;
        try {
          await route.continue();
        } catch (error) {
          if (!reloaded && !closing) throw error;
        }
      });
      await page.route(`**/api/comparisons/${id}/reconcile`, async (route) => {
        const sent = route.request().postDataJSON() as ReconcileRequest;
        const alpha = matchingProposal(sent.draft.markdown, alphaInitial);
        if (!initialRequest && alpha.length) {
          initialRequest = sent;
          await sendInitial.promise;
        }
        const response = await route.fetch();
        const result =
          (await response.json()) as SyncResult<ComparisonReviewData>;
        // Inspect the same text the real client receives after reconstructing
        // an explicitly verified request-text reference. Fulfill the untouched
        // wire response below so the browser still exercises its own decoder.
        const returned = result.state as
          | (NonNullable<typeof result.state> & {
              draftTextFromRequest?: boolean;
            })
          | undefined;
        if (returned?.draftTextFromRequest) {
          expect(
            route.request().headers()["x-roughdraft-draft-reference"],
          ).toBe(reviewDraftSignature(sent.draft));
          returned.draft = {
            ...returned.draft,
            markdown: sent.draft.markdown,
            cleanMarkdown: sent.draft.cleanMarkdown,
          };
          expect(reviewDraftSignature(returned.draft)).toBe(returned.signature);
        }
        wire.push({
          operationId: sent.operationId,
          status: result.status,
          proposals: proposals(sent.draft.markdown).map((item) => ({
            id: item.id,
            text: item.text,
          })),
        });
        const own = result.state
          ? matchingProposal(result.state.draft.markdown, alphaComplete)
          : [];
        const originalId = initialRequest
          ? onlyProposal(initialRequest.draft.markdown, alphaInitial).id
          : null;
        if (
          !savedRenumbered &&
          result.status === "committed" &&
          own.length === 1 &&
          own[0].id !== originalId
        ) {
          savedRenumbered = result;
          committedOperation = sent.operationId;
          await releaseAcknowledgment.promise;
        }
        try {
          await route.fulfill({ response });
        } catch (error) {
          if (!reloaded && !closing) throw error;
        }
      });

      await append(page, "Alpha", ` ${alphaInitial}`);
      await expect.poll(() => Boolean(initialRequest)).toBe(true);
      if (!initialRequest) throw new Error("Alpha's first save was not held");
      const originalId = onlyProposal(
        initialRequest.draft.markdown,
        alphaInitial,
      ).id;
      await page.getByTestId(`comment-rail-${originalId}-action-reply`).click();
      const reply = page.getByTestId(/^comment-rail-.+-editor$/);
      await expect(reply).toHaveCount(1);
      await reply.fill(replyText);
      await append(page, "Alpha", "-continued", true);
      await expect(reply).toHaveValue(replyText);
      await expect(page.getByTestId("revision-pending")).toHaveText("2");

      const peerText = peer === "another Suggest tab" ? "Beta-b" : "Agent-b";
      if (peer === "another Suggest tab") {
        await append(second, "Beta", ` ${peerText}`);
        await expect
          .poll(async () => {
            const review = await readReview(request, id);
            return matchingProposal(review.draft?.markdown ?? "", peerText).map(
              (item) => item.id,
            );
          })
          .toEqual([originalId]);
      } else {
        expectedDisk = source
          .replace(
            "Beta owner: ready.",
            `Beta owner: ready. {++${peerText}++}{#${originalId}}`,
          )
          .replace(
            "suggestions:\n",
            `suggestions:\n  ${originalId}:\n    by: AI\n    at: "2026-11-22T12:05:00.000Z"\n`,
          );
        fs.renameSync(
          writeProjectFile(project, "agent-proposal-next.md", expectedDisk),
          target,
        );
        await expect
          .poll(async () => {
            const state = await (
              await request.get(`${api}/${id}/state`, { headers })
            ).json();
            return state.disk?.text;
          })
          .toBe(expectedDisk);
        expect(onlyProposal(expectedDisk, peerText).id).toBe(originalId);
      }
      sendInitial.resolve();
      await expect.poll(() => Boolean(savedRenumbered)).toBe(true);
      const committed = savedRenumbered?.state;
      if (!committed) throw new Error("The renumbered save never committed");
      const alphaId = onlyProposal(committed.draft.markdown, alphaComplete).id;
      const peerId = onlyProposal(committed.draft.markdown, peerText).id;
      expect(alphaId).not.toBe(originalId);
      expect(peerId).toBe(originalId);
      expect(alphaId).not.toBe(peerId);
      await noConflictBanners(page);

      if (arrival === "state-before-response") {
        releaseOldState.resolve();
        // A real foreground event makes the live transport read the actual
        // committed server state while the original response is still held.
        await page.evaluate(() =>
          document.dispatchEvent(new Event("visibilitychange")),
        );
        await expect.poll(() => echoedOperation).toBe(committedOperation);
        await saved(page);
        await expect(page.getByTestId(/^comment-rail-.+-editor$/)).toHaveValue(
          replyText,
        );
        await noConflictBanners(page);
      }

      // The server has the renumbered item, but the page has not received that
      // acknowledgement. Recovery must retain the same item and reply target.
      reloaded = true;
      await page.reload();
      await saved(page);
      await expect(richTextEditor(page)).toContainText(alphaComplete);
      await expect(richTextEditor(page)).toContainText(peerText);
      const restoredReply = page.getByTestId(/^comment-rail-.+-editor$/);
      await expect(restoredReply).toHaveCount(1);
      await expect(restoredReply).toHaveValue(replyText);
      const beforeSubmit = await readReview(request, id);
      expect(
        beforeSubmit.reviewComments.some((item) => item.content === replyText),
      ).toBe(false);
      await restoredReply.press("Control+Enter");
      await expect
        .poll(async () =>
          (await readReview(request, id)).reviewComments
            .filter((item) => item.content === replyText)
            .map((item) => ({
              parent: item.parentCommentId,
              target: item.changeId,
            })),
        )
        .toEqual([{ parent: alphaId, target: alphaId }]);
      const recovered = await readReview(request, id);
      expect(proposals(recovered.draft?.markdown ?? "")).toHaveLength(3);
      expect(
        onlyProposal(recovered.draft?.markdown ?? "", alphaComplete).id,
      ).toBe(alphaId);
      expect(onlyProposal(recovered.draft?.markdown ?? "", peerText).id).toBe(
        peerId,
      );
      expect(
        onlyProposal(recovered.draft?.markdown ?? "", "must survive").id,
      ).toBe("s1");
      expect(
        recovered.reviewComments.find((item) => item.id === "c1")?.content,
      ).toBe("This original comment must remain attached.");
      expect(fs.readFileSync(target, "utf8")).toBe(expectedDisk);
      await noConflictBanners(page);
      if (peer === "another Suggest tab") await noConflictBanners(second);
      const outcome = await request.get(
        `${api}/operations/${committedOperation}`,
        { headers },
      );
      expect((await outcome.json()).status).toBe("committed");
      fs.writeFileSync(
        testInfo.outputPath("collision-recovery.json"),
        JSON.stringify(
          {
            peer,
            arrival,
            originalId,
            alphaId,
            peerId,
            committedOperation,
            echoedOperation,
            wire,
          },
          null,
          2,
        ),
      );
    } finally {
      const views = await Promise.allSettled(
        [page, second].map((view) =>
          view.evaluate(() => ({
            text: document.querySelector(".ProseMirror")?.textContent,
            banner: document.querySelector('[data-testid="revision-conflict"]')
              ?.textContent,
            banners: Reflect.get(window, "collisionBanners"),
            profile: Reflect.get(window, "roughdraftProfile"),
            editors: [
              ...document.querySelectorAll<HTMLTextAreaElement>(
                '[data-testid^="comment-rail-"][data-testid$="-editor"]',
              ),
            ].map((node) => ({
              id: node.getAttribute("data-testid"),
              value: node.value,
            })),
            recovery: Object.fromEntries(
              Object.entries(localStorage).filter(([key]) =>
                /roughdraft|revision/i.test(key),
              ),
            ),
          })),
        ),
      );
      fs.writeFileSync(
        testInfo.outputPath("collision-ui-before-cleanup.json"),
        JSON.stringify(views, null, 2),
      );
      fs.writeFileSync(
        testInfo.outputPath("collision-wire.json"),
        JSON.stringify(
          {
            peer,
            arrival,
            initialRequest,
            savedRenumbered,
            committedOperation,
            reloaded,
            wire,
          },
          null,
          2,
        ),
      );
      closing = true;
      sendInitial.resolve();
      releaseAcknowledgment.resolve();
      releaseOldState.resolve();
      await page.close();
      await peerContext.close();
      removeMarkdownProject(project);
    }
  });
}
