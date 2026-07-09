"""Prompt for the LLM-as-a-judge matcher.

Follows Martian's core question: "do these describe the same underlying issue?"
Wording differences are fine; only substance matters. The judge returns a
matrix of matches so the harness can derive TP / FP / FN.
"""

JUDGE_SYSTEM = """\
You are an impartial judge evaluating an AI code reviewer against a set of
human-verified "golden" issues for one pull request.

You are given:
- GOLDEN COMMENTS: the real issues a reviewer should have caught (ground truth).
- FINDINGS: what the AI reviewer actually reported.

Your task is to decide, for each pairing, whether the FINDING and the GOLDEN
COMMENT describe THE SAME UNDERLYING ISSUE. Different wording is fine — judge on
substance, not surface text. A finding matches a golden comment if acting on the
finding would resolve the issue the golden comment is about.

Matching rules:
- Each golden comment may be matched by at most one finding (its best match).
- Each finding may match at most one golden comment.
- A finding that matches no golden comment is unmatched (a potential false positive).

For each MATCH, also record:
- `severity_match`: true if the finding severity equals the golden severity, false otherwise.
- `actionability_score` (integer 1–5): how specific and actionable is the finding's comment?
  1 = vague ("there may be an issue here", no details)
  2 = identifies the problem type but not the location
  3 = identifies file/problem but misses the fix or root cause
  4 = identifies file, root cause, and suggests a fix
  5 = precise: file, line, root cause, and concrete, correct fix

For each UNMATCHED FINDING, also record:
- `plausible`: true only if the finding is (a) a real, substantive code issue AND (b) an
  independent defect, not already fully covered by a matched golden comment. If the finding
  only becomes actionable or relevant after a fix implied by another matched golden comment
  (e.g. "add an ownership check" on an endpoint whose real problem is that it has no auth at
  all, which is already golden), mark `plausible: false` and say "conditional on <golden_id>"
  in the rationale — it is a hypothetical extension of an already-caught issue, not a new one.
  Otherwise mark `plausible: false` if the finding is wrong/hallucinated/trivial.
- `actionability_score` (integer 1–5): same scale as above.

Return VALID JSON ONLY:

{
  "matches": [
    {
      "golden_id": "<id>",
      "finding_id": "<id>",
      "rationale": "<short why>",
      "severity_match": true,
      "actionability_score": 4
    }
  ],
  "unmatched_findings": [
    {
      "finding_id": "<id>",
      "plausible": true,
      "rationale": "<short why>",
      "actionability_score": 3
    }
  ]
}

Only include a golden_id/finding_id pair in "matches" when you are confident they
are the same issue. List every finding that is not in "matches" under
"unmatched_findings".
"""


def judge_user_prompt(pr, findings) -> str:
    import json

    golden = [
        {"id": g.id, "severity": g.severity.value, "comment": g.comment}
        for g in pr.golden_comments
    ]
    found = [
        {
            "id": f.id,
            "file": f.file,
            "severity": f.severity.value,
            "category": f.category.value,
            "comment": f.comment,
        }
        for f in findings
    ]
    parts = [f"# Pull request: {pr.pr_title or pr.id}"]
    if pr.language:
        parts.append(f"Language: {pr.language}")
    parts.append("\n## GOLDEN COMMENTS\n```json\n" + json.dumps(golden, indent=2) + "\n```")
    parts.append("\n## FINDINGS\n```json\n" + json.dumps(found, indent=2) + "\n```")
    parts.append("\nMatch findings to golden comments per the rules.")
    return "\n".join(parts)
