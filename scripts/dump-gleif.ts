/**
 * Check the GLEIF API from your machine (no TinyFish key or credit needed).
 * TinyVerify was built where api.gleif.org could not be reached, so its
 * parser was written from GLEIF's documentation. This saves the real
 * responses and prints what TinyVerify reads from them.
 *
 *   npm run dump:gleif
 *
 * Saves raw JSON to samples/raw/gleif-<date>/ (git-ignored).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpGleif } from "../src/gleif/client.js";
import { hostOf } from "../src/util/text.js";

const dir = join("samples", "raw", `gleif-${new Date().toISOString().slice(0, 10)}`);
await mkdir(dir, { recursive: true });
let n = 0;
const saved: Promise<void>[] = [];
const g = new HttpGleif({
  onResponse: (url, body) => {
    n += 1;
    const slug = url.replace(/^https?:\/\/[^/]+\/api\/v1\//, "").replace(/[^A-Za-z0-9]+/g, "-").slice(0, 90);
    saved.push(writeFile(join(dir, `${String(n).padStart(2, "0")}-${slug}.json`), JSON.stringify(body, null, 2)));
  },
});

const ras = await g.authorities();
const withSite = ras.filter((r) => r.website).length;
const withJur = ras.filter((r) => r.jurisdictions.length).length;
console.log(JSON.stringify({ registers: ras.length, with_website: withSite, with_jurisdictions: withJur, example: ras.find((r) => r.website) ?? null }));
const byCode = new Map(ras.map((r) => [r.code, r]));

for (const name of ["Siemens Aktiengesellschaft", "Toyota Motor Corporation", "ING Groep N.V.", "Pfizer Inc."]) {
  const { entities, method } = await g.searchByName(name);
  console.log(
    JSON.stringify({
      search: name,
      method,
      found: entities.length,
      top: entities.slice(0, 3).map((e) => ({
        lei: e.lei,
        name: e.legal_name,
        other_names: e.other_names.slice(0, 2),
        jurisdiction: e.jurisdiction,
        category: e.category,
        status: e.entity_status,
        lei_status: e.registration_status,
        register: e.registered_at ? `${e.registered_at} ${byCode.get(e.registered_at)?.name ?? "(not in list)"}` : null,
        number: e.registered_as,
      })),
    }),
  );
}

for (const j of ["DE", "NL", "US-NY", "JP"]) {
  const sample = await g.sampleJurisdiction(j);
  const hosts = new Map<string, number>();
  for (const e of sample) {
    const w = e.registered_at ? byCode.get(e.registered_at)?.website : null;
    const h = w ? hostOf(w) : `(${e.registered_at ?? "none"})`;
    if (h) hosts.set(h, (hosts.get(h) ?? 0) + 1);
  }
  console.log(JSON.stringify({ jurisdiction: j, sampled: sample.length, registers: [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4) }));
}

await Promise.all(saved);
console.log(`\nSaved ${n} raw responses to ${dir}. ${g.calls.filter((c) => !c.ok).length} calls failed.`);
