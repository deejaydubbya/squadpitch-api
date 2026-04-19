-- Analytics Scoring Model Refactor
-- Split performanceScore into qualityScore, observedScore, compositeScore

-- PostInsight: rename performanceScore → compositeScore, add qualityScore + observedScore
ALTER TABLE "post_insights" RENAME COLUMN "performanceScore" TO "compositeScore";
ALTER TABLE "post_insights" ADD COLUMN "qualityScore" DOUBLE PRECISION;
ALTER TABLE "post_insights" ADD COLUMN "observedScore" DOUBLE PRECISION;

-- WorkspaceAnalytics: rename avgPerformanceScore → avgCompositeScore, add avgQualityScore + avgObservedScore
ALTER TABLE "workspace_analytics" RENAME COLUMN "avgPerformanceScore" TO "avgCompositeScore";
ALTER TABLE "workspace_analytics" ADD COLUMN "avgQualityScore" DOUBLE PRECISION;
ALTER TABLE "workspace_analytics" ADD COLUMN "avgObservedScore" DOUBLE PRECISION;

-- AnalyticsSnapshot: rename avgPerformanceScore → avgCompositeScore, add avgQualityScore + avgObservedScore
ALTER TABLE "analytics_snapshots" RENAME COLUMN "avgPerformanceScore" TO "avgCompositeScore";
ALTER TABLE "analytics_snapshots" ADD COLUMN "avgQualityScore" DOUBLE PRECISION;
ALTER TABLE "analytics_snapshots" ADD COLUMN "avgObservedScore" DOUBLE PRECISION;

-- DataItemPerformance: rename avgPerformanceScore → avgCompositeScore, add avgQualityScore + avgObservedScore
ALTER TABLE "data_item_performance" RENAME COLUMN "avgPerformanceScore" TO "avgCompositeScore";
ALTER TABLE "data_item_performance" ADD COLUMN "avgQualityScore" DOUBLE PRECISION;
ALTER TABLE "data_item_performance" ADD COLUMN "avgObservedScore" DOUBLE PRECISION;

-- BlueprintPerformance: rename avgPerformanceScore → avgCompositeScore, add avgQualityScore + avgObservedScore
ALTER TABLE "blueprint_performance" RENAME COLUMN "avgPerformanceScore" TO "avgCompositeScore";
ALTER TABLE "blueprint_performance" ADD COLUMN "avgQualityScore" DOUBLE PRECISION;
ALTER TABLE "blueprint_performance" ADD COLUMN "avgObservedScore" DOUBLE PRECISION;
