import { describe, expect, it } from "vitest";

import {
  getCanonicalMainnetRumbleEngineId,
  isLegacyMainnetRumbleEngineId,
  resolveMainnetRumbleEngineId,
} from "~~/lib/rumble-program-id";

describe("resolveMainnetRumbleEngineId", () => {
  it("keeps the canonical mainnet deployment unchanged", () => {
    expect(
      resolveMainnetRumbleEngineId(
        ["2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC"],
        "638DcfW6NaBweznnzmJe4PyxCw51s3CTkykUNskWnxTU",
      ),
    ).toBe(getCanonicalMainnetRumbleEngineId());
  });

  it("rewrites the retired deployment id to the canonical mainnet deployment", () => {
    expect(
      resolveMainnetRumbleEngineId(
        ["638DcfW6NaBweznnzmJe4PyxCw51s3CTkykUNskWnxTU"],
        "fallback",
      ),
    ).toBe(getCanonicalMainnetRumbleEngineId());
  });

  it("recognizes the retired deployment id", () => {
    expect(isLegacyMainnetRumbleEngineId("638DcfW6NaBweznnzmJe4PyxCw51s3CTkykUNskWnxTU")).toBe(true);
    expect(isLegacyMainnetRumbleEngineId("2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC")).toBe(false);
  });
});
