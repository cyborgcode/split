export type Verdict = "false" | "misleading" | "unverifiable";

export interface FactCheckFinding {
  type: "fact_check";
  quote: string;
  verdict: Verdict;
  correction: string;
  source_name: string;
  source_url: string;
  /** Query the model suggests for verifying the correction via web search. */
  search_query?: string;
}

export interface FallacyFinding {
  type: "fallacy";
  fallacy_name: string;
  quote: string;
  explanation: string;
}

export type Finding = FactCheckFinding | FallacyFinding;

export interface AnalyzeRequest {
  /** Newly spoken text that has not been analyzed yet. */
  chunk: string;
  /** Recent transcript before the chunk, for context only. */
  context?: string;
  /** Audio clips to transcribe and judge instead of `chunk` (no Web Speech API). */
  audio?: Array<{ data: string; mimeType: string }>;
}

export interface AnalyzeResponse {
  findings: Finding[];
  /** Factual claims the model evaluated in this chunk, including accurate ones. */
  claims_checked?: number;
  /** Gemini model that answered. */
  model?: string;
  /** What Gemini heard, for audio requests. */
  transcript?: string;
}
