export type Severity = "critical" | "major" | "minor";

export interface Finding {
  agent?: string;
  severity: Severity;
  file?: string;
  startLine?: number | null;
  line?: number | null;
  body: string;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  architectureReview?: string;
  runtimeEvidence?: RuntimeApiEvidence[];
}

export interface RuntimeApiEvidence {
  request: {
    method: string;
    url: string;
  };
  response?: {
    status: number;
    statusText: string;
    contentType: string | null;
    body: string;
  };
  error?: string;
}

export interface ReviewContext {
  title: string;
  body: string;
  diff: string;
  truncated: boolean;
  architectureDocuments?: Array<{ path: string; content: string }>;
}

export interface ReviewerReport {
  agent: string;
  output: string;
}

export interface FindingCandidate extends Finding {
  id: string;
}

export type FindingValidationStatus = "confirmed" | "revised" | "false_positive" | "unverified";

export interface FindingDecision {
  id: string;
  status: FindingValidationStatus;
  severity: Severity;
  rationale: string;
  body?: string;
  startLine?: number | null;
  line?: number | null;
}

export interface ValidationResult {
  summary: string;
  decisions: FindingDecision[];
  architectureReview?: string;
}

export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES";
