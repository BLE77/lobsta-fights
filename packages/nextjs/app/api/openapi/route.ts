import { readFileSync } from "fs";
import { join } from "path";

export const dynamic = "force-dynamic";

/**
 * GET /api/openapi
 *
 * Serves the OpenAPI 3.0 spec (YAML) from /public/openapi.yaml.
 * Accepts `format=json` query param to return parsed JSON instead.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format");

  const yamlPath = join(process.cwd(), "public", "openapi.yaml");
  const yaml = readFileSync(yamlPath, "utf-8");

  if (format === "json") {
    // Lazy-load yaml parser only when JSON is requested
    try {
      const { parse } = await import("yaml");
      const doc = parse(yaml);
      return new Response(JSON.stringify(doc, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch {
      // If yaml package is not installed, return raw YAML with a hint
      return new Response(yaml, {
        headers: {
          "Content-Type": "text/yaml; charset=utf-8",
          "Cache-Control": "public, max-age=60",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  }

  return new Response(yaml, {
    headers: {
      "Content-Type": "text/yaml; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
