import { useState } from "react";
import { preloadComparison } from "./comparison-bootstrap";
import { deferredComponent } from "./deferred-component";
import {
  comparisonEntryUrl,
  documentsEntryUrl,
} from "virtual:roughdraft-deferred-entries";
import { optionalModule } from "./optional-module";

const Comparison = deferredComponent(
  async (attempt) => ({
    default: (
      await optionalModule(
        () => import("./ComparisonReview"),
        comparisonEntryUrl,
        attempt,
      )
    ).ComparisonReview,
  }),
  "review",
);
const Documents = deferredComponent(
  async (attempt) => ({
    default: (
      await optionalModule(() => import("./App"), documentsEntryUrl, attempt)
    ).App,
  }),
  "document",
);

export function Application() {
  const [route] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    const id = query.get("comparison");
    if (id) {
      const initialReview = preloadComparison(id);
      // The request runs while the route downloads. Its consumer shows errors;
      // attaching a handler now avoids an unhandled rejection during that gap.
      void initialReview.catch(() => {});
      return { id, initialReview };
    }
    const linkedPath = query.get("path");
    return linkedPath && query.get("editor") === "unified"
      ? { id: "document", linkedPath }
      : null;
  });
  return route ? <Comparison {...route} /> : <Documents />;
}
