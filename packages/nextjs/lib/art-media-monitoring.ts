import { getModelInfo } from "./image-generator";
import { freshSupabase } from "./supabase";

const IMAGE_BUCKET = "images";
const FLUX_PRO_COST_PER_IMAGE = 0.04;
const LORA_COST_PER_IMAGE = 0.025;
const LORA_TRAINING_COST = 1.5;
const STORAGE_LIST_LIMIT = 1000;
const STORAGE_LIST_MAX_PAGES = 20;

type AlertSeverity = "info" | "warning" | "critical";

type FighterImageRow = {
  id: string;
  image_url: string | null;
  victory_pose_url: string | null;
};

type MatchImageRow = {
  id: string;
  result_image_url: string | null;
  result_image_prediction_id: string | null;
};

type TempReference = {
  entity: "fighter" | "match";
  id: string;
  field: "image_url" | "victory_pose_url" | "result_image_url";
  url: string;
};

type StoredObject = {
  path: string;
  name: string;
  created_at: string | null;
  updated_at: string | null;
};

type StorageAuditInternal = {
  referencedPaths: string[];
  storedObjects: StoredObject[];
  orphanedPaths: string[];
  danglingReferencedPaths: string[];
  tempReplicateReferences: TempReference[];
  truncated: boolean;
};

function isReplicateTempUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && url.includes("replicate.delivery");
}

function extractStoragePath(url: string | null | undefined): string | null {
  if (!url) return null;

  const marker = `/storage/v1/object/public/${IMAGE_BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;

  const withoutQuery = url.slice(idx + marker.length).split("?")[0];
  if (!withoutQuery) return null;

  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    return withoutQuery;
  }
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function pushAlert(
  alerts: Array<{ severity: AlertSeverity; message: string }>,
  severity: AlertSeverity,
  message: string
) {
  alerts.push({ severity, message });
}

async function listFolderObjects(folder: string): Promise<{ objects: StoredObject[]; truncated: boolean }> {
  const supabase = freshSupabase();
  const objects: StoredObject[] = [];
  let offset = 0;
  let pages = 0;

  while (pages < STORAGE_LIST_MAX_PAGES) {
    const { data, error } = await supabase.storage
      .from(IMAGE_BUCKET)
      .list(folder, {
        limit: STORAGE_LIST_LIMIT,
        offset,
        sortBy: { column: "name", order: "asc" },
      });

    if (error) {
      throw new Error(`Failed to list ${folder}: ${error.message}`);
    }

    if (!data || data.length === 0) {
      return { objects, truncated: false };
    }

    for (const item of data) {
      if (!item?.name) continue;
      objects.push({
        path: `${folder}/${item.name}`,
        name: item.name,
        created_at: (item as any).created_at ?? null,
        updated_at: (item as any).updated_at ?? null,
      });
    }

    if (data.length < STORAGE_LIST_LIMIT) {
      return { objects, truncated: false };
    }

    offset += data.length;
    pages += 1;
  }

  return { objects, truncated: true };
}

async function fetchImageRows() {
  const supabase = freshSupabase();
  const [fightersRes, matchesRes] = await Promise.all([
    supabase.from("ucf_fighters").select("id, image_url, victory_pose_url"),
    supabase.from("ucf_matches").select("id, result_image_url, result_image_prediction_id"),
  ]);

  if (fightersRes.error) {
    throw new Error(`Failed to load fighters for art audit: ${fightersRes.error.message}`);
  }
  if (matchesRes.error) {
    throw new Error(`Failed to load matches for art audit: ${matchesRes.error.message}`);
  }

  return {
    fighters: (fightersRes.data ?? []) as FighterImageRow[],
    matches: (matchesRes.data ?? []) as MatchImageRow[],
  };
}

async function countRowsSince(table: "ucf_fighters" | "ucf_matches", sinceIso: string): Promise<number> {
  const supabase = freshSupabase();
  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .gte("created_at", sinceIso);

  if (error) {
    throw new Error(`Failed counting ${table}: ${error.message}`);
  }

  return count ?? 0;
}

async function buildStorageAuditInternal(): Promise<StorageAuditInternal> {
  const [{ fighters, matches }, fighterObjects, battleObjects] = await Promise.all([
    fetchImageRows(),
    listFolderObjects("fighters"),
    listFolderObjects("battles"),
  ]);

  const referencedPaths = new Set<string>();
  const tempReplicateReferences: TempReference[] = [];

  for (const fighter of fighters) {
    const refs = [
      { field: "image_url" as const, url: fighter.image_url },
      { field: "victory_pose_url" as const, url: fighter.victory_pose_url },
    ];

    for (const ref of refs) {
      if (!ref.url) continue;
      if (isReplicateTempUrl(ref.url)) {
        tempReplicateReferences.push({
          entity: "fighter",
          id: fighter.id,
          field: ref.field,
          url: ref.url,
        });
        continue;
      }
      const path = extractStoragePath(ref.url);
      if (path) referencedPaths.add(path);
    }
  }

  for (const match of matches) {
    if (!match.result_image_url) continue;
    if (isReplicateTempUrl(match.result_image_url)) {
      tempReplicateReferences.push({
        entity: "match",
        id: match.id,
        field: "result_image_url",
        url: match.result_image_url,
      });
      continue;
    }
    const path = extractStoragePath(match.result_image_url);
    if (path) referencedPaths.add(path);
  }

  const storedObjects = [...fighterObjects.objects, ...battleObjects.objects];
  const storedPathSet = new Set(storedObjects.map((obj) => obj.path));
  const orphanedPaths = storedObjects
    .map((obj) => obj.path)
    .filter((path) => !referencedPaths.has(path));
  const danglingReferencedPaths = Array.from(referencedPaths).filter((path) => !storedPathSet.has(path));

  return {
    referencedPaths: Array.from(referencedPaths),
    storedObjects,
    orphanedPaths,
    danglingReferencedPaths,
    tempReplicateReferences,
    truncated: fighterObjects.truncated || battleObjects.truncated,
  };
}

export async function getReplicateMonitoringReport() {
  const modelInfo = getModelInfo();
  const { fighters, matches } = await fetchImageRows();

  const fighterProfileCount = fighters.filter((fighter) => !!fighter.image_url).length;
  const fighterVictoryCount = fighters.filter((fighter) => !!fighter.victory_pose_url).length;
  const fighterProfileTempCount = fighters.filter((fighter) => isReplicateTempUrl(fighter.image_url)).length;
  const fighterVictoryTempCount = fighters.filter((fighter) => isReplicateTempUrl(fighter.victory_pose_url)).length;
  const fighterMissingProfileCount = fighters.filter((fighter) => !fighter.image_url).length;
  const fighterMissingVictoryCount = fighters.filter((fighter) => !fighter.victory_pose_url).length;

  const matchResultCount = matches.filter((match) => !!match.result_image_url).length;
  const matchResultTempCount = matches.filter((match) => isReplicateTempUrl(match.result_image_url)).length;
  const matchPendingPredictionCount = matches.filter(
    (match) => !!match.result_image_prediction_id && !match.result_image_url
  ).length;

  const now = Date.now();
  const dayAgoIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const weekAgoIso = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const monthAgoIso = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [fightersLast30d, matchesLast24h, matchesLast7d, storageAudit] = await Promise.all([
    countRowsSince("ucf_fighters", monthAgoIso),
    countRowsSince("ucf_matches", dayAgoIso),
    countRowsSince("ucf_matches", weekAgoIso),
    buildStorageAuditInternal(),
  ]);

  const observedFighterImages = fighterProfileCount + fighterVictoryCount;
  const observedMatchImages = matchResultCount;
  const baselineObservedCost = (observedFighterImages + observedMatchImages) * FLUX_PRO_COST_PER_IMAGE;
  const modeledFighterCost = observedFighterImages * (modelInfo.loraConfigured ? LORA_COST_PER_IMAGE : FLUX_PRO_COST_PER_IMAGE);
  const modeledMatchCost = observedMatchImages * FLUX_PRO_COST_PER_IMAGE;
  const projectedDailyCost = matchesLast24h * FLUX_PRO_COST_PER_IMAGE;

  const alerts: Array<{ severity: AlertSeverity; message: string }> = [];
  if (!process.env.REPLICATE_API_TOKEN) {
    pushAlert(alerts, "critical", "REPLICATE_API_TOKEN is missing; image generation will fail.");
  }
  if (storageAudit.tempReplicateReferences.length > 0) {
    pushAlert(
      alerts,
      "warning",
      `${storageAudit.tempReplicateReferences.length} temp Replicate URLs still exist in the database.`
    );
  }
  if (matchPendingPredictionCount > 0) {
    pushAlert(
      alerts,
      "warning",
      `${matchPendingPredictionCount} match image predictions are pending without a finished image URL.`
    );
  }
  if (!modelInfo.loraConfigured) {
    pushAlert(alerts, "info", "LoRA is not deployed yet; fighter art still runs at Flux Pro pricing.");
  }
  if (storageAudit.orphanedPaths.length > 0) {
    pushAlert(
      alerts,
      "info",
      `${storageAudit.orphanedPaths.length} storage objects are unreferenced and can be cleaned up.`
    );
  }

  const status: AlertSeverity =
    alerts.some((alert) => alert.severity === "critical")
      ? "critical"
      : alerts.some((alert) => alert.severity === "warning")
        ? "warning"
        : "info";

  return {
    status,
    token_configured: Boolean(process.env.REPLICATE_API_TOKEN),
    current_model: {
      name: modelInfo.model,
      lora_configured: modelInfo.loraConfigured,
      fighter_image_cost_usd: modelInfo.loraConfigured ? LORA_COST_PER_IMAGE : FLUX_PRO_COST_PER_IMAGE,
      match_image_cost_usd: FLUX_PRO_COST_PER_IMAGE,
      training_cost_usd: LORA_TRAINING_COST,
    },
    asset_inventory: {
      fighters_total: fighters.length,
      fighter_profile_images: fighterProfileCount,
      fighter_victory_images: fighterVictoryCount,
      fighter_profile_temp_urls: fighterProfileTempCount,
      fighter_victory_temp_urls: fighterVictoryTempCount,
      fighters_missing_profile_images: fighterMissingProfileCount,
      fighters_missing_victory_images: fighterMissingVictoryCount,
      match_result_images: matchResultCount,
      match_result_temp_urls: matchResultTempCount,
      pending_match_result_predictions: matchPendingPredictionCount,
    },
    usage_window: {
      fighters_created_last_30d: fightersLast30d,
      matches_created_last_24h: matchesLast24h,
      matches_created_last_7d: matchesLast7d,
    },
    estimated_spend: {
      observed_baseline_flux_pro_total_usd: formatUsd(baselineObservedCost),
      observed_modeled_total_usd: formatUsd(modeledFighterCost + modeledMatchCost),
      projected_match_image_cost_24h_usd: formatUsd(projectedDailyCost),
      fighter_image_cost_per_new_fighter_usd: formatUsd(
        (modelInfo.loraConfigured ? LORA_COST_PER_IMAGE : FLUX_PRO_COST_PER_IMAGE) * 2
      ),
      training_cost_usd: formatUsd(LORA_TRAINING_COST),
    },
    storage_health: {
      referenced_storage_objects: storageAudit.referencedPaths.length,
      stored_storage_objects: storageAudit.storedObjects.length,
      orphaned_storage_objects: storageAudit.orphanedPaths.length,
      dangling_db_references: storageAudit.danglingReferencedPaths.length,
      temp_replicate_references: storageAudit.tempReplicateReferences.length,
      storage_scan_truncated: storageAudit.truncated,
    },
    alerts,
  };
}

export async function getImageStorageAudit(sampleLimit: number = 25) {
  const audit = await buildStorageAuditInternal();

  return {
    bucket: IMAGE_BUCKET,
    referenced_storage_objects: audit.referencedPaths.length,
    stored_storage_objects: audit.storedObjects.length,
    orphaned_storage_objects: audit.orphanedPaths.length,
    dangling_db_references: audit.danglingReferencedPaths.length,
    temp_replicate_references: audit.tempReplicateReferences.length,
    storage_scan_truncated: audit.truncated,
    samples: {
      orphaned_storage_paths: audit.orphanedPaths.slice(0, sampleLimit),
      dangling_db_paths: audit.danglingReferencedPaths.slice(0, sampleLimit),
      temp_replicate_references: audit.tempReplicateReferences.slice(0, sampleLimit),
    },
  };
}

export async function cleanupOrphanedStorageObjects(options?: {
  limit?: number;
  dryRun?: boolean;
}) {
  const limit = Math.max(1, Math.min(options?.limit ?? 100, 500));
  const dryRun = options?.dryRun ?? true;
  const audit = await buildStorageAuditInternal();
  const candidates = audit.orphanedPaths.slice(0, limit);

  if (dryRun || candidates.length === 0) {
    return {
      dry_run: dryRun,
      candidate_count: candidates.length,
      deleted_count: 0,
      deleted_paths: [] as string[],
      remaining_orphaned_storage_objects: audit.orphanedPaths.length,
      storage_scan_truncated: audit.truncated,
      candidates,
    };
  }

  const supabase = freshSupabase();
  const deletedPaths: string[] = [];

  for (let i = 0; i < candidates.length; i += 100) {
    const batch = candidates.slice(i, i + 100);
    const { error } = await supabase.storage.from(IMAGE_BUCKET).remove(batch);
    if (error) {
      throw new Error(`Failed deleting orphaned storage objects: ${error.message}`);
    }
    deletedPaths.push(...batch);
  }

  return {
    dry_run: false,
    candidate_count: candidates.length,
    deleted_count: deletedPaths.length,
    deleted_paths: deletedPaths,
    remaining_orphaned_storage_objects: Math.max(0, audit.orphanedPaths.length - deletedPaths.length),
    storage_scan_truncated: audit.truncated,
    candidates,
  };
}
