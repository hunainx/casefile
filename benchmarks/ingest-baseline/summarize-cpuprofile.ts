/* eslint-disable no-console */
/**
 * Summarises a V8 .cpuprofile (from --cpu-prof) for the BIGDATA-1 baseline: self time per
 * function, and time per package (the part of node_modules, or our own source, each sample was in).
 *
 *   npx tsx benchmarks/ingest-baseline/summarize-cpuprofile.ts <file.cpuprofile> [top N]
 */
import { readFileSync } from "node:fs";

interface CallFrame { functionName: string; url: string; lineNumber: number }
interface ProfileNode { id: number; callFrame: CallFrame }
interface Profile { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number }

const file = process.argv[2];
const topN = Number(process.argv[3] ?? 30);
if (!file) {
  console.error("Usage: summarize-cpuprofile.ts <file.cpuprofile> [top N]");
  process.exit(2);
}
const p = JSON.parse(readFileSync(file, "utf8")) as Profile;
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const self = new Map<number, number>();
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i]!, (self.get(p.samples[i]!) ?? 0) + (p.timeDeltas[i] ?? 0));
const totalUs = p.endTime - p.startTime;

const where = (url: string): string => {
  const u = url.replace(/\\/g, "/");
  const nm = /node_modules\/(?:\.pnpm\/)?((?:@[^/]+\/)?[^/@]+)/.exec(u);
  if (nm) return nm[1]!;
  const repo = /casefile\/((?:apps|packages|tools)\/[^/]+)/.exec(u);
  if (repo) return repo[1]!;
  if (u.startsWith("node:")) return "node internals";
  return u ? "other" : "(V8 / native)";
};

const fn = new Map<string, number>();
const pkg = new Map<string, number>();
for (const [id, us] of self) {
  const n = byId.get(id)!;
  const cf = n.callFrame;
  const short = cf.url.replace(/\\/g, "/").replace(/^.*\/(node_modules|casefile)\//, "$1/");
  const key = `${cf.functionName || "(anonymous)"}  ${short ? `${short}:${cf.lineNumber + 1}` : ""}`.trim();
  fn.set(key, (fn.get(key) ?? 0) + us);
  const k = cf.functionName.startsWith("(") && !cf.url ? cf.functionName : where(cf.url);
  pkg.set(k, (pkg.get(k) ?? 0) + us);
}
const ms = (us: number) => `${(us / 1000).toFixed(0).padStart(8)} ms`;
const pct = (us: number) => `${((100 * us) / totalUs).toFixed(1).padStart(5)}%`;
console.log(`CPU profile ${file}`);
console.log(`profiled ${(totalUs / 1e6).toFixed(1)} s of wall time; samples ${p.samples.length}`);
console.log("\nBy package (self time)");
for (const [k, v] of [...pkg].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`${ms(v)} ${pct(v)}  ${k}`);
console.log(`\nTop ${topN} functions (self time)`);
for (const [k, v] of [...fn].sort((a, b) => b[1] - a[1]).slice(0, topN)) console.log(`${ms(v)} ${pct(v)}  ${k}`);
