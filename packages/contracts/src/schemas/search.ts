import { z } from "zod";
import { UuidSchema, IsoDateTimeSchema } from "./common.js";

export const SearchModeSchema = z.enum([
  "exact",
  "keyword",
  "semantic",
  "hybrid",
  "entity",
  "relationship",
  "temporal",
  "structural",
  "natural_language",
]);
export type SearchMode = z.infer<typeof SearchModeSchema>;

export const SearchFiltersSchema = z.object({
  source_id: UuidSchema.optional(),
  document_type: z.string().optional(),
  custodian: z.string().optional(),
  language: z.string().optional(),
  entity_id: UuidSchema.optional(),
  epistemic_state: z.string().optional(),
  has_contradiction: z.boolean().optional(),
  unreviewed: z.boolean().optional(),
  before: IsoDateTimeSchema.optional(),
  after: IsoDateTimeSchema.optional(),
  doc_date_before: IsoDateTimeSchema.optional(),
  doc_date_after: IsoDateTimeSchema.optional(),
  event_date_before: IsoDateTimeSchema.optional(),
  event_date_after: IsoDateTimeSchema.optional(),
  min_confidence: z.number().min(0).max(1).optional(),
});
export type SearchFilters = z.infer<typeof SearchFiltersSchema>;

export const SearchRequestSchema = z.object({
  query: z.string().min(1),
  mode: SearchModeSchema.default("hybrid"),
  filters: SearchFiltersSchema.optional().default({}),
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().min(0).default(0),
  weights_version: z.string().default("v1.0"),
  index_generation: z.string().default("gen-1"),
  collapse_near_duplicates: z.boolean().default(true),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const SearchSignalBreakdownSchema = z.object({
  signal: z.string(),
  weight: z.number(),
  score: z.number(),
  contribution: z.number(),
});
export type SearchSignalBreakdown = z.infer<typeof SearchSignalBreakdownSchema>;

export const SearchExplanationSchema = z.object({
  retrieval_path: z.enum(["exact", "lexical", "entity"]),
  requested_mode: z.string().optional(),
  matched_terms: z.array(z.string()),
  matched_alias: z.string().nullable().optional(),
  signals: z.array(SearchSignalBreakdownSchema),
  signals_not_computed: z.array(z.string()),
  raw_lexical_rank: z.number().int().positive(),
  score_basis: z.string().default("lexical_match + source_quality"),
});
export type SearchExplanation = z.infer<typeof SearchExplanationSchema>;

export const SearchResultItemSchema = z.object({
  chunk_id: UuidSchema,
  source_id: UuidSchema,
  source_filename: z.string(),
  source_class: z.string().nullable().optional(),
  document_type: z.string().nullable().optional(),
  custodian: z.string().nullable().optional(),
  text: z.string(),
  contextual_header: z.string().nullable().optional(),
  document_date: IsoDateTimeSchema.nullable().optional(),
  event_date: IsoDateTimeSchema.nullable().optional(),
  score: z.number(),
  explanation: SearchExplanationSchema,
});
export type SearchResultItem = z.infer<typeof SearchResultItemSchema>;

export const CoverageReportSchema = z.object({
  total_chunks_indexed: z.number(),
  total_sources_indexed: z.number(),
  unindexed_sources_count: z.number(),
  unindexed_breakdown: z.record(z.string(), z.number()),
  temporal_filter_excluded_count: z.number(),
  coverage_percentage: z.number(),
});
export type CoverageReport = z.infer<typeof CoverageReportSchema>;

export const FacetBucketSchema = z.object({
  value: z.string(),
  count: z.number(),
});
export type FacetBucket = z.infer<typeof FacetBucketSchema>;

export const SearchFacetsSchema = z.object({
  document_types: z.array(FacetBucketSchema),
  sources: z.array(FacetBucketSchema),
  custodians: z.array(FacetBucketSchema),
  languages: z.array(FacetBucketSchema),
  entities: z.array(FacetBucketSchema),
});
export type SearchFacets = z.infer<typeof SearchFacetsSchema>;

export const SearchResponseSchema = z.object({
  query: z.string(),
  mode: SearchModeSchema,
  total_hits: z.number(),
  limit: z.number(),
  offset: z.number(),
  weights_version: z.string(),
  score_basis: z.string().default("lexical_match + source_quality"),
  index_generation: z.string(),
  items: z.array(SearchResultItemSchema),
  coverage: CoverageReportSchema,
  facets: SearchFacetsSchema,
  suggested_refinements: z.array(z.string()),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const SavedSearchSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  name: z.string(),
  description: z.string().nullable().optional(),
  query: z.string(),
  search_mode: SearchModeSchema,
  filters: SearchFiltersSchema,
  weights_version: z.string(),
  created_by: UuidSchema,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type SavedSearch = z.infer<typeof SavedSearchSchema>;

export const CreateSavedSearchRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  query: z.string().min(1),
  search_mode: SearchModeSchema.default("hybrid"),
  filters: SearchFiltersSchema.optional().default({}),
  weights_version: z.string().default("v1.0"),
});
export type CreateSavedSearchRequest = z.infer<typeof CreateSavedSearchRequestSchema>;

export const SearchMonitorSchema = z.object({
  id: UuidSchema,
  tenant_id: UuidSchema,
  investigation_id: UuidSchema,
  saved_search_id: UuidSchema.nullable().optional(),
  name: z.string(),
  query: z.string(),
  filters: SearchFiltersSchema,
  is_active: z.boolean(),
  last_run_at: IsoDateTimeSchema.nullable().optional(),
  hit_count: z.number(),
  created_by: UuidSchema,
  created_at: IsoDateTimeSchema,
});
export type SearchMonitor = z.infer<typeof SearchMonitorSchema>;

export const CreateSearchMonitorRequestSchema = z.object({
  name: z.string().min(1),
  query: z.string().min(1),
  saved_search_id: UuidSchema.optional(),
  filters: SearchFiltersSchema.optional().default({}),
});
export type CreateSearchMonitorRequest = z.infer<typeof CreateSearchMonitorRequestSchema>;

export const SearchRelevanceFeedbackRequestSchema = z.object({
  query: z.string().min(1),
  chunk_id: UuidSchema.optional(),
  source_id: UuidSchema,
  is_relevant: z.boolean(),
  notes: z.string().optional(),
});
export type SearchRelevanceFeedbackRequest = z.infer<typeof SearchRelevanceFeedbackRequestSchema>;
