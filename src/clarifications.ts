import { Severity } from "./model";

export const clarificationSpec: { key: string; prompt: string; suggestion: string; severity: Severity }[] = [
  { key: "intent", prompt: "Summarize the solution intent and each linked document. If none exist, explicitly confirm that.", suggestion: "Paste authoritative excerpts locally; URLs are references only and are never fetched.", severity: "high" },
  { key: "actors", prompt: "Who are the users, roles and permission boundaries?", suggestion: "List authorized roles and actions; include unauthenticated or restricted actors.", severity: "high" },
  { key: "capabilities", prompt: "List the independently reviewable capabilities, one per line.", suggestion: "Each line should state a concrete actor action and business value. These become feature drafts.", severity: "high" },
  { key: "scope", prompt: "What is in scope and explicitly out of scope?", suggestion: "State release boundaries and exclusions.", severity: "high" },
  { key: "rules", prompt: "What business rules, validation rules and state transitions apply?", suggestion: "Describe permitted and rejected inputs, decisions and transitions with observable outcomes.", severity: "high" },
  { key: "boundaries", prompt: "What are the exact input limits and behavior at, below and above each limit?", suggestion: "Specify numeric limits, inclusivity, units and expected rejection behavior; explicitly justify any non-applicability.", severity: "high" },
  { key: "data", prompt: "What data, retention rules and representative test datasets are required?", suggestion: "Use synthetic examples only, with valid and invalid partitions. Do not paste secrets or personal data.", severity: "high" },
  { key: "dependencies", prompt: "What constraints, integrations and dependencies exist?", suggestion: "List providers, contracts and limitations, or explicitly state none.", severity: "medium" },
  { key: "operations", prompt: "What failures, recovery, availability and observability behavior are required?", suggestion: "Define timeout/retry rules, recovery outcomes and diagnostic evidence.", severity: "high" },
  { key: "security", prompt: "What security controls and safe test boundaries apply?", suggestion: "Specify authorization denial, data protection, audit behavior and an isolated authorized test environment.", severity: "critical" },
  { key: "performance", prompt: "What are the measurable performance budgets and workload?", suggestion: "Include latency percentile, threshold, units, duration, concurrency and throughput, or a justified non-applicability.", severity: "high" },
  { key: "environment", prompt: "What supported environments and test prerequisites apply?", suggestion: "Specify versions, platforms, configuration, fixtures and dependency simulators.", severity: "medium" },
  { key: "success", prompt: "What observable, measurable business outcomes define success?", suggestion: "State exact expected outcomes, a measure and a verification time or condition; avoid 'works correctly'.", severity: "high" }
];

export const clarificationKeys = clarificationSpec.map(question => question.key);
