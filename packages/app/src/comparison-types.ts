import type { CriticComment } from "./critic-markup";

export type ComparisonDecision = "pending" | "before" | "after";
export interface ComparisonSegment {
  id: string;
  kind: "equal" | "change";
  before: string;
  after: string;
  oldStart: number;
  newStart: number;
  decision: ComparisonDecision;
  comment: string;
}
export interface ComparisonReviewComment extends CriticComment {
  changeId: string;
}
export interface ComparisonReviewData {
  id: string;
  revision: number;
  mode: "proposal" | "applied" | "compare";
  title: string;
  beforeLabel: string;
  afterLabel: string;
  targetPath: string | null;
  beforeText: string;
  afterText: string;
  segments: ComparisonSegment[];
  comment: string;
  reviewComments?: ComparisonReviewComment[];
  status: "open" | "completed" | "applied";
  targetChanged: boolean;
  completion: {
    fileWritten: boolean;
    targetPath: string | null;
    accepted: number;
    reverted: number;
    completedAt: string;
  } | null;
}
