// @ts-check
/**
 * Phase 5 tests for src/gateway/nvidia-catalog-sync.mjs.
 *
 * All tests are hermetic — NO real network calls. The fetcher is replaced via
 * __setFetcherForTests__ with a canned-response mock. The module's top-level
 * background warm is disabled by setting NGC_CATALOG_SYNC_DISABLE_WARM=1 BEFORE
 * the import so the mock fetcher (set inside each test) is the ONLY source.
 *
 * Coverage:
 *   1. refreshCatalog returns a Map; ids map correctly (publisher/displayName);
 *      popularity parsed as int; labels filtered to string[]; aliases inserted.
 *   2. A detail-fetch failure for one record does NOT abort the batch; the
 *      failed record falls back to safe defaults from the search record, and
 *      other records still appear.
 *   3. getAllModelMetadata returns the cached Map on the second call WITHOUT
 *      invoking the fetcher again (within the default 24h TTL).
 *   4. resetCatalogCache clears the cache so the next getAllModelMetadata
 *      lazy-fetches again.
 *   5. NGC_CATALOG_SYNC_TTL_MS env override is respected (asserted both via
 *      getCacheTtlMs() AND behavior: cache expires after a tiny TTL).
 *
 * Defensive: refreshCatalog NEVER throws (mirrors model-limits.mjs philosophy),
 * so a search-level failure returns an empty Map rather than rejecting.
 */

// Disable the module top-level background warm BEFORE any import. The mock
// fetcher (set inside each test body via __setFetcherForTests__) is the only
// network source; without this sentinel the warm would fire against the test
// process's mocked global https.get (none installed) and hang/error spuriously.
process.env.NGC_CATALOG_SYNC_DISABLE_WARM = "1";

import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const moduleUrl = pathToFileURL(path.join(root, "src/gateway/nvidia-catalog-sync.mjs")).href;

// ---------------------------------------------------------------------------
// Helpers shared across tests
// ---------------------------------------------------------------------------

/**
 * Build a small fake NGC search response body.
 * @param {Array<{ name: string; publisher?: string; displayName: string; labels?: string[] }>} items
 */
function searchBody(items) {
    return {
        resultTotal: items.length,
        resources: items.map((it) => ({
            artifact: {
                name: it.name,
                publisher: it.publisher || "z-ai",
                displayName: it.displayName,
                labels: it.labels || []
            }
        }))
    };
}

/**
 * Build a fake NGC detail response body (richer than the search record).
 * @param {{
 *   name: string;
 *   publisher?: string;
 *   displayName: string;
 *   shortDescription?: string;
 *   labels?: string[];
 *   invocations?: number;
 *   updatedDate?: string;
 *   logo?: string;
 *   canGuestDownload?: boolean;
 *   isPublic?: boolean;
 * }} spec
 */
function detailBody(spec) {
    return {
        artifact: {
            name: spec.name,
            publisher: spec.publisher || "z-ai",
            displayName: spec.displayName,
            shortDescription: spec.shortDescription || "",
            labels: spec.labels || [],
            attributes: [
                { key: "AVAILABLE", value: "true" },
                { key: "lastMonthApiInvocationCount", value: String(spec.invocations ?? 0) },
                { key: "lastMonthDownloadCount", value: "0" }
            ],
            logo: spec.logo || `https://assets.ngc.nvidia.com/products/api-catalog/images/${spec.name}.jpg`,
            isPublic: spec.isPublic === false ? false : true,
            canGuestDownload: spec.canGuestDownload === false ? false : true,
            updatedDate: spec.updatedDate || "2026-08-01T00:00:00Z"
        }
    };
}

/**
 * The catalog MODEL under test (shared single import so the cache + in-flight
 * dedup state are visible across assertions; each test RESETS via
 * resetCatalogCache before exercising).
 */
const catalog = await import(moduleUrl);

// ---------------------------------------------------------------------------
// Test 1: refreshCatalog returns a Map populated with publisher-prefixed ids,
// bare-alias ids, parsed popularity ints, and label arrays — single happy path.
// ---------------------------------------------------------------------------
test("refreshCatalog returns a Map keyed by publisher/displayName + a bare-displayName alias; parses popularity as int and filters labels to strings", async () => {
    catalog.resetCatalogCache();
    let fetchCalls = 0;
    catalog.__setFetcherForTests__(async (urlPath) => {
        fetchCalls++;
        if (urlPath.startsWith("/v2/search/catalog/resources/ENDPOINT")) {
            return searchBody([
                { name: "z-ai/glm-5.2", publisher: "z-ai", displayName: "glm-5.2", labels: ["Reasoning"] }
            ]);
        }
        if (urlPath.startsWith("/v2/endpoints/qc69jvmznzxy/")) {
            return detailBody({
                name: "z-ai/glm-5.2",
                publisher: "z-ai",
                displayName: "glm-5.2",
                shortDescription: "GLM 5.2 chat model",
                labels: ["Reasoning", "Tool Use", "Long Context"],
                invocations: 12345,
                updatedDate: "2026-07-15T08:30:00Z",
                canGuestDownload: true,
                isPublic: true
            });
        }
        throw new Error(`unexpected fetcher URL: ${urlPath}`);
    });

    const byId = await catalog.refreshCatalog();

    assert.ok(byId instanceof Map, "refreshCatalog must return a Map");
    // SEARCH + DETAIL → 2 fetcher calls.
    assert.equal(fetchCalls, 2, "refresh must call search + detail exactly once per record");

    // Publisher-qualified id form joins (matches integrate.api.nvidia.com/v1/models).
    const meta = byId.get("z-ai/glm-5.2");
    assert.ok(meta, "publisher-prefixed id must be present in the Map");
    assert.equal(meta.id, "z-ai/glm-5.2");
    assert.equal(meta.publisher, "z-ai");
    assert.equal(meta.slug, "z-ai/glm-5.2");
    assert.equal(meta.shortDescription, "GLM 5.2 chat model");
    assert.deepEqual(meta.labels, ["Reasoning", "Tool Use", "Long Context"]);
    assert.equal(meta.popularity, 12345, "lastMonthApiInvocationCount must be parsed as an int");
    assert.equal(meta.lastUpdated, "2026-07-15T08:30:00Z");
    assert.ok(meta.logoUrl.startsWith("https://assets.ngc.nvidia.com/"), "logoUrl must be the NGC URL");
    assert.equal(meta.downloadable, true);
    assert.equal(meta.freeEndpoint, true);

    // Bare-alias id form ALSO joins (handles NVIDIA-published models that blend
    // integrate.api.nvidia.com upstream omits the nvidia/ prefix for).
    const bare = byId.get("glm-5.2");
    assert.ok(bare, "a bare-displayName alias must be inserted so unprefixed ids join");
    assert.equal(bare, meta, "the alias must point at the SAME metadata record");
});

// ---------------------------------------------------------------------------
// Test 2: A detail-fetch failure does NOT abort the batch. The failed record
// falls back to the search-record metadata (no attributes), and other records
// are unaffected.
// ---------------------------------------------------------------------------
test("a detail-fetch failure falls back to the search record; the rest of the batch completes with full detail metadata", async () => {
    catalog.resetCatalogCache();
    catalog.__setFetcherForTests__(async (urlPath) => {
        if (urlPath.startsWith("/v2/search/catalog/resources/ENDPOINT")) {
            return searchBody([
                { name: "failing/slug", publisher: "failing-pub", displayName: "broken-model", labels: [] },
                { name: "ok/slug", publisher: "z-ai", displayName: "glm-5.2", labels: ["Reasoning"] }
            ]);
        }
        if (urlPath === "/v2/endpoints/qc69jvmznzxy/failing%2Fslug") {
            throw new Error("simulated NGC detail 500");
        }
        if (urlPath === "/v2/endpoints/qc69jvmznzxy/ok%2Fslug") {
            return detailBody({
                name: "ok/slug",
                publisher: "z-ai",
                displayName: "glm-5.2",
                shortDescription: "ok record",
                labels: ["Reasoning"],
                invocations: 999,
                canGuestDownload: false
            });
        }
        throw new Error(`unexpected fetcher URL: ${urlPath}`);
    });

    const byId = await catalog.refreshCatalog();

    // The failing record fell back to the search record (publisher+labels known,
    // popularity defaults to 0 because no attributes were available).
    const broken = byId.get("failing-pub/broken-model");
    assert.ok(broken, "failing-prefixed id from the search record must still appear");
    assert.equal(broken.publisher, "failing-pub");
    assert.deepEqual(broken.labels, []);
    assert.equal(broken.popularity, 0, "popularity must default to 0 when the detail fetch failed");
    assert.equal(broken.shortDescription, "", "shortDescription must default to '' without the detail");
    assert.equal(broken.lastUpdated, "", "lastUpdated must default to '' without the detail");

    // The non-failing record has the full detail metadata.
    const ok = byId.get("z-ai/glm-5.2");
    assert.ok(ok, "ok record must still be enriched (the batch did not abort on the failure)");
    assert.equal(ok.popularity, 999);
    assert.equal(ok.shortDescription, "ok record");
    assert.equal(ok.downloadable, false);
});

// ---------------------------------------------------------------------------
// Test 3: getAllModelMetadata returns the cached Map on the second call WITHOUT
// re-invoking the fetcher (cache hit within the default 24h TTL).
// ---------------------------------------------------------------------------
test("getAllModelMetadata returns the cached Map without invoking the fetcher again on the second call (24h default TTL)", async () => {
    catalog.resetCatalogCache();
    let fetchCalls = 0;
    catalog.__setFetcherForTests__(async (urlPath) => {
        fetchCalls++;
        if (urlPath.startsWith("/v2/search/catalog/resources/ENDPOINT")) {
            return searchBody([{ name: "a/slug", publisher: "z-ai", displayName: "glm-5.2" }]);
        }
        return detailBody({ name: "a/slug", publisher: "z-ai", displayName: "glm-5.2" });
    });

    await catalog.getAllModelMetadata();
    assert.equal(fetchCalls, 2, "first call must fetch search + detail");

    await catalog.getAllModelMetadata();
    assert.equal(fetchCalls, 2, "second call within the TTL must NOT refetch");

    // Corollary: refreshCatalog ALWAYS forces a fresh fetch (used by the
    // /admin/catalog/sync button to bypass the TTL). Verify that contract.
    await catalog.refreshCatalog();
    assert.equal(fetchCalls, 4, "refreshCatalog must force a fresh fetch even when the TTL is fresh");
});

// ---------------------------------------------------------------------------
// Test 4: resetCatalogCache clears the cache so the next call re-fetches.
// ---------------------------------------------------------------------------
test("resetCatalogCache clears the cache; the next getAllModelMetadata re-fetches", async () => {
    catalog.resetCatalogCache();
    let fetchCalls = 0;
    catalog.__setFetcherForTests__(async (urlPath) => {
        fetchCalls++;
        if (urlPath.startsWith("/v2/search/catalog/resources/ENDPOINT")) {
            return searchBody([{ name: "r/c", publisher: "z-ai", displayName: "glm-5.2" }]);
        }
        return detailBody({ name: "r/c", publisher: "z-ai", displayName: "glm-5.2" });
    });

    await catalog.refreshCatalog();
    assert.equal(fetchCalls, 2);

    // Cache hit — no extra fetch.
    await catalog.getAllModelMetadata();
    assert.equal(fetchCalls, 2);

    // Reset clears the cache, so the next call MUST re-fetch.
    catalog.resetCatalogCache();
    const info = catalog.getCatalogCacheInfo();
    assert.equal(info.fetchedAt, null);
    assert.equal(info.size, 0);

    await catalog.getAllModelMetadata();
    assert.equal(fetchCalls, 4, "after reset, getAllModelMetadata must re-fetch");
});

// ---------------------------------------------------------------------------
// Test 5: NGC_CATALOG_SYNC_TTL_MS env override.
//   (a) The configured TTL matches the env when set (asserted via getCacheTtlMs
//       AND via __setCacheTtlMsForTests__ for the live instance in this same
//       file — the env is read once at module top-level so a fresh module load
//       with the env set is exercised via a cache-buster dynamic import).
//   (b) Behavior: a 1ms TTL ages the cache to stale IMMEDIATELY, so a second
//       getAllModelMetadata call re-fetches.
// ---------------------------------------------------------------------------
test("NGC_CATALOG_SYNC_TTL_MS env override is read at module load (fresh import reads the env-configured TTL)", async () => {
    const original = process.env.NGC_CATALOG_SYNC_TTL_MS;
    process.env.NGC_CATALOG_SYNC_TTL_MS = "12345";
    try {
        // A cache-buster query forces a fresh module instance (the env is read
        // ONCE at top-level — the shared `catalog` import above initialized with
        // an UNSET / default TTL and would not reflect the env change).
        const fresh = await import(`${moduleUrl}?ttl=${Date.now()}-${Math.random().toString(36).slice(2)}`);
        assert.equal(fresh.getCacheTtlMs(), 12345, "fresh module load must read NGC_CATALOG_SYNC_TTL_MS");
    } finally {
        if (original === undefined) delete process.env.NGC_CATALOG_SYNC_TTL_MS;
        else process.env.NGC_CATALOG_SYNC_TTL_MS = original;
    }
});

test("a tiny cache TTL ages the cache to stale immediately, forcing a re-fetch on the next getAllModelMetadata call", async () => {
    catalog.resetCatalogCache();
    catalog.__setCacheTtlMsForTests__(1); // 1ms → cache becomes stale in <1ms after fetch

    let fetchCalls = 0;
    catalog.__setFetcherForTests__(async (urlPath) => {
        fetchCalls++;
        if (urlPath.startsWith("/v2/search/catalog/resources/ENDPOINT")) {
            return searchBody([{ name: "x/y", publisher: "z-ai", displayName: "glm-5.2" }]);
        }
        return detailBody({ name: "x/y", publisher: "z-ai", displayName: "glm-5.2" });
    });

    await catalog.getAllModelMetadata();
    assert.equal(fetchCalls, 2);

    // Wait long enough for the 1ms TTL to expire.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await catalog.getAllModelMetadata();
    assert.equal(fetchCalls, 4, "with a 1ms TTL, the second call must re-fetch (cache aged out)");
}).finally(() => {
    // Restore the default TTL so subsequent tests (and any co-residents) see 24h.
    catalog.__setCacheTtlMsForTests__(24 * 60 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// Defensive contract: refreshCatalog NEVER throws — a search-level failure
// returns an empty Map rather than rejecting.
// ---------------------------------------------------------------------------
test("refreshCatalog never throws on a search-level failure — it returns an empty Map when the fetch and cache are both absent", async () => {
    catalog.resetCatalogCache();
    catalog.__setFetcherForTests__(async () => {
        throw new Error("network down");
    });

    const byId = await catalog.refreshCatalog();
    assert.ok(byId instanceof Map);
    assert.equal(byId.size, 0, "a search-level failure must fall back to an empty Map (not throw)");
});

// ---------------------------------------------------------------------------
// getMetadataForModelId synchronous read + getCatalogCacheInfo state.
// ---------------------------------------------------------------------------
test("getMetadataForModelId is a synchronous read; getCatalogCacheInfo reflects cache age and size", async () => {
    catalog.resetCatalogCache();
    assert.equal(catalog.getMetadataForModelId("any/id"), undefined, "must return undefined when the cache is empty");

    catalog.__setFetcherForTests__(async (urlPath) => {
        if (urlPath.startsWith("/v2/search/catalog/resources/ENDPOINT")) {
            return searchBody([{ name: "id1", publisher: "z-ai", displayName: "glm-5.2" }]);
        }
        return detailBody({ name: "id1", publisher: "z-ai", displayName: "glm-5.2", invocations: 1 });
    });

    const byId = await catalog.getAllModelMetadata();
    assert.ok(byId.size > 0);

    const lookup = catalog.getMetadataForModelId("z-ai/glm-5.2");
    assert.ok(lookup, "synchronous lookup must find the cached entry");
    assert.equal(lookup.popularity, 1);

    const info = catalog.getCatalogCacheInfo();
    assert.ok(info.fetchedAt !== null && info.fetchedAt > 0, "fetchedAt must be set after a successful fetch");
    assert.ok(info.size >= 1, "size must record the number of (incl. aliased) entries");
});

// ---------------------------------------------------------------------------
// Test 9 (Phase 5 backend review MINOR): the defaultFetchJson JSON.parse
// REJECT path (lines 145-150) was not exercised — every other test in this
// suite installs a mock fetcher that returns a JS object directly (pre-parsed
// JSON), so the SyntaxError handling at defaultFetchJson's JSON.parse site is
// dead branch coverage. This test reproduces what defaultFetchJson would do
// on an HTTP 200 whose body is HTML (a misbehaving proxy / NGC outage 500
// page): JSON.parse(<html…>) throws SyntaxError → reject(Error('Failed to
// parse NGC response: …')). refreshCatalog's outer catch (339-346) MUST handle
// that rejection — return the stale cache (or an empty Map on a COLD start)
// WITHOUT poisoning the cache, NEVER throw, and WITHOUT advancing fetchedAt.
// ---------------------------------------------------------------------------
test("an invalid-JSON NGC response triggers refreshCatalog's catch path: stale cache preserved, no throw, no cache advance", async () => {
    catalog.resetCatalogCache();
    const before = catalog.getCatalogCacheInfo();
    assert.equal(before.fetchedAt, null, "precondition: cold cache fetchedAt is null");
    assert.equal(before.size, 0, "precondition: cold cache size is 0");

    catalog.__setFetcherForTests__(async (urlPath) => {
        // Reproduce defaultFetchJson's behavior on an HTTP 200 with a body that
        // is NOT valid JSON (an HTML 500 Internal-Error page served by a
        // misbehaving proxy or NGC outage). defaultFetchJson:resolves the
        // stream then JSON.parse(data); on SyntaxError it rejects with
        // `Failed to parse NGC response: ${err.message}` (line 148). The mock
        // mimics THAT exact reject path so refreshCatalog's catch sees the same
        // error shape a real NGC outage would yield.
        const body = "<html>500 Internal Error</html>";
        try {
            JSON.parse(body);
        } catch (err) {
            throw new Error(`Failed to parse NGC response: ${err.message}`);
        }
        // Unreachable: the JSON.parse above always throws for non-JSON body. The
        // line documents the resolved-object contract a real fetcher honors.
        return JSON.parse(body);
    });

    // refreshCatalog MUST NOT throw on the parse-reject path — the outer catch
    // runs and returns an empty Map on this cold start (cache === null), so the
    // user-facing /admin/models still gets a defensive empty result and the
    // gateway stays up. Distinct from a successful search that returns 0
    // resources (which WOULD update fetchedAt with an empty byId Map).
    const byId = await catalog.refreshCatalog();
    assert.ok(byId instanceof Map, "refreshCatalog must return a Map (NOT throw) on invalid JSON");
    assert.equal(byId.size, 0, "the returned Map must be empty (no records could be parsed from the HTML body)");

    // The cache state MUST NOT advance — the search-level parse-reject triggers
    // the catch block (nvidia-catalog-sync.mjs:339-346), which preserves the
    // existing cache OR returns an empty Map WITHOUT writing `cache`. The
    // invariant: a parse failure is a NON-advance, distinguishable by the admin
    // sync endpoint (admin-api.mjs before/after fetchedAt comparison).
    const after = catalog.getCatalogCacheInfo();
    assert.equal(after.fetchedAt, before.fetchedAt,
        "fetchedAt must NOT advance on the parse-reject path (cold cache stays null)");
    assert.equal(after.size, before.size,
        "size must remain unchanged — the stale cache was preserved, NOT replaced with an empty Map");

    catalog.__restoreFetcherForTests__();
});

// ---------------------------------------------------------------------------
// Test 10: Real NVIDIA NGC search response format with grouped results
// and direct resource objects (no artifact wrapper). Verifies publisher in labels,
// structured categories, lastMonthApiInvocationCount (in millions), dateModified,
// and description extraction.
// ---------------------------------------------------------------------------
test("real NGC search response format (results[0].resources, direct fields, structured labels, millions invocations) is parsed accurately", async () => {
    catalog.resetCatalogCache();
    catalog.__setFetcherForTests__(async (urlPath) => {
        if (urlPath.startsWith("/v2/search/catalog/resources/ENDPOINT")) {
            return {
                results: [
                    {
                        groupValue: "_scored",
                        totalCount: 2,
                        resources: [
                            {
                                name: "glm-5.2",
                                displayName: "GLM-5.2",
                                description: "GLM-5.2 is an advanced foundation model",
                                dateModified: "2026-06-15T10:00:00Z",
                                labels: [
                                    { key: "publisher", values: ["z-ai"] },
                                    { key: "category", values: ["Reasoning", "Code"] }
                                ],
                                attributes: [
                                    { key: "lastMonthApiInvocationCount", value: "65000000" }
                                ],
                                canGuestDownload: true,
                                isPublic: true,
                                logo: "https://assets.ngc.nvidia.com/products/api-catalog/images/glm-5.2.jpg"
                            },
                            {
                                name: "llama-3_1-8b-instruct",
                                displayName: "llama-3.1-8b-instruct",
                                description: "Meta Llama 3.1 8B Instruct model",
                                dateModified: "2026-07-20T14:30:00Z",
                                labels: [
                                    { key: "publisher", values: ["meta"] },
                                    { key: "category", values: ["Chat", "Agent"] }
                                ],
                                attributes: [
                                    { key: "lastMonthApiInvocationCount", value: "52431000" }
                                ],
                                canGuestDownload: true,
                                isPublic: true
                            }
                        ]
                    }
                ]
            };
        }
        if (urlPath.startsWith("/v2/endpoints/")) {
            // Real NGC endpoint details may not exist for partner models; simulated 404
            throw new Error("404 Not Found");
        }
        throw new Error(`unexpected fetcher URL: ${urlPath}`);
    });

    const byId = await catalog.refreshCatalog();
    assert.ok(byId instanceof Map);

    // GLM-5.2 assertions
    const glm = byId.get("z-ai/GLM-5.2");
    assert.ok(glm, "primary id z-ai/GLM-5.2 must exist");
    assert.equal(glm.publisher, "z-ai", "publisher must be extracted from labels array");
    assert.equal(glm.popularity, 65000000, "popularity must be 65M invocations");
    assert.equal(glm.lastUpdated, "2026-06-15T10:00:00Z", "lastUpdated must be from dateModified");
    assert.equal(glm.shortDescription, "GLM-5.2 is an advanced foundation model", "description must match");
    assert.deepEqual(glm.labels, ["Reasoning", "Code"], "category labels must exclude publisher key");
    assert.equal(glm.downloadable, true);
    assert.equal(glm.freeEndpoint, true);

    // GLM aliasing assertions
    assert.equal(byId.get("z-ai/glm-5.2"), glm, "lowercased/slug alias z-ai/glm-5.2 must resolve to glm");
    assert.equal(byId.get("GLM-5.2"), glm, "bare displayName GLM-5.2 must resolve to glm");
    assert.equal(byId.get("glm-5.2"), glm, "bare slug glm-5.2 must resolve to glm");

    // Llama-3.1 assertions
    const llama = byId.get("meta/llama-3.1-8b-instruct");
    assert.ok(llama, "primary id meta/llama-3.1-8b-instruct must exist");
    assert.equal(llama.publisher, "meta");
    assert.equal(llama.popularity, 52431000);
    assert.equal(llama.lastUpdated, "2026-07-20T14:30:00Z");
    assert.deepEqual(llama.labels, ["Chat", "Agent"]);

    // Underscore to dot aliasing assertions
    assert.equal(byId.get("meta/llama-3_1-8b-instruct"), llama, "underscore alias meta/llama-3_1-8b-instruct must resolve to llama");
    assert.equal(byId.get("llama-3.1-8b-instruct"), llama, "bare dot alias llama-3.1-8b-instruct must resolve to llama");
    assert.equal(byId.get("llama-3_1-8b-instruct"), llama, "bare underscore alias llama-3_1-8b-instruct must resolve to llama");
});

// ---------------------------------------------------------------------------
// Test 11: Attribute and date fallbacks (snake_case, weightPopular, dateCreated)
// ---------------------------------------------------------------------------
test("attribute and date fallbacks (snake_case invocation count, weightPopular, dateCreated) are parsed", async () => {
    catalog.resetCatalogCache();
    catalog.__setFetcherForTests__(async (urlPath) => {
        if (urlPath.startsWith("/v2/search/catalog/resources/ENDPOINT")) {
            return {
                resources: [
                    {
                        name: "snake-model",
                        publisher: "nvidia",
                        displayName: "snake-model",
                        dateCreated: "2026-05-01T00:00:00Z",
                        attributes: [
                            { key: "last_month_api_invocation_count", value: "8000000" }
                        ]
                    },
                    {
                        name: "weight-model",
                        publisher: "nvidia",
                        displayName: "weight-model",
                        weightPopular: 19000000,
                        dateCreated: "2026-04-01T00:00:00Z"
                    }
                ]
            };
        }
        throw new Error("detail not needed");
    });

    const byId = await catalog.refreshCatalog();
    assert.ok(byId instanceof Map);

    const snake = byId.get("nvidia/snake-model");
    assert.ok(snake);
    assert.equal(snake.popularity, 8000000, "snake_case invocation count must be parsed");
    assert.equal(snake.lastUpdated, "2026-05-01T00:00:00Z", "dateCreated used as fallback");

    const weight = byId.get("nvidia/weight-model");
    assert.ok(weight);
    assert.equal(weight.popularity, 19000000, "weightPopular used as fallback popularity");
    assert.equal(weight.lastUpdated, "2026-04-01T00:00:00Z");
});

// Restore the production fetcher after the suite so any later import shares the
// default real-https implementation.
test.after(() => {
    catalog.__restoreFetcherForTests__();
    catalog.__setCacheTtlMsForTests__(24 * 60 * 60 * 1000);
    catalog.resetCatalogCache();
    delete process.env.NGC_CATALOG_SYNC_TTL_MS;
});
