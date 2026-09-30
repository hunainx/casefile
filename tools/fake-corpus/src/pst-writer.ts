import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeDataBase, isInsideRepo } from "./marker.js";

/**
 * Writes FAKE .pst files for tests and measurements (BIGDATA-3B). There is no free PST writer for
 * Node, so a small C# program (../pst-writer/PstWriter.cs) does it, on top of:
 *   - PSTFileFormat (ROM Knowledgeware, LGPL-3.0-or-later): reads and writes PST structures;
 *   - Empty.pst from microsoft/outlook-pst-rs (MIT): an empty Unicode PST made by Outlook, the
 *     starting file (the library can add to a PST but not create one).
 * Both are fetched at pinned commits into a cache folder OUTSIDE the repository (Empty.pst is
 * checked against its SHA-256), and compiled with the C# compiler of the .NET Framework that ships
 * with Windows (csc.exe, C# 5). So PST writing needs Windows and network access once; reading PSTs
 * (the ingest) needs neither. Nothing here is used by Casefile at run time.
 *
 * The library writes random GUIDs and the current time into some structures, so the same spec
 * gives the same folders, messages and attachments but not the same bytes.
 */
export const PST_LIBRARY = {
  repo: "https://github.com/ROM-Knowledgeware/PSTFileFormat.git",
  commit: "fd08511c39123d646467cb4b82b0fdc848ceb179", // "PSTFileFormat v1.3.1", 19 Jul 2019
  licence: "LGPL-3.0-or-later",
};
export const EMPTY_PST = {
  url: "https://raw.githubusercontent.com/microsoft/outlook-pst-rs/cfb721daee538acc50d2bad6faac5ce724f6037d/crates/pst/examples/Empty.pst",
  sha256: "c16ae985d12011ad510ccb3b10f19d61b0c3b3311fa4696fb56b87812bd8d5c5",
  licence: "MIT",
};
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const WRITER_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "pst-writer", "PstWriter.cs");

export interface PstRecipient {
  n: string;
  e: string;
}
export interface PstAttachmentSpec {
  name: string;
  mime: string;
  /** The content, base64; or, for an attachment by reference (attach method 2), none and the file's path. */
  b64?: string;
  reference?: string;
}
export interface PstEmbeddedSpec {
  subject: string;
  body: string;
  from: PstRecipient;
  to: PstRecipient[];
  date: string;
  messageId: string | null;
}
export interface PstMessageSpec {
  t: "msg";
  key: string;
  folder: string[];
  subject: string;
  body: string;
  from: PstRecipient;
  to: PstRecipient[];
  cc: PstRecipient[];
  bcc: PstRecipient[];
  date: string;
  messageId: string | null;
  headers: string | null;
  atts: PstAttachmentSpec[];
  emb: PstEmbeddedSpec[];
}
export interface PstStoreSpec {
  t: "store";
  name: string;
  passwordCrc: number;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Builds the writer once (cached by the library commit and the writer source's hash). Returns PstWriter.exe and Empty.pst. */
export async function ensurePstWriter(log: (s: string) => void = () => {}): Promise<{ exe: string; template: string }> {
  if (process.platform !== "win32" || !existsSync(CSC)) {
    throw new Error(`Writing a .pst needs Windows and the .NET Framework C# compiler (${CSC}). Reading PSTs does not.`);
  }
  const writerHash = sha256(readFileSync(WRITER_SOURCE)).slice(0, 12);
  const cache = join(fakeDataBase(), ".pst-writer", `${PST_LIBRARY.commit.slice(0, 12)}-${writerHash}`);
  if (isInsideRepo(cache)) throw new Error(`Refusing to build the PST writer inside the repository (${cache}).`);
  const exe = join(cache, "PstWriter.exe");
  const template = join(cache, "Empty.pst");
  if (existsSync(exe) && existsSync(template) && sha256(readFileSync(template)) === EMPTY_PST.sha256) return { exe, template };

  mkdirSync(cache, { recursive: true });
  const lib = join(cache, "PSTFileFormat");
  if (!existsSync(lib)) {
    log(`fetching ${PST_LIBRARY.repo} at ${PST_LIBRARY.commit} (${PST_LIBRARY.licence})`);
    execFileSync("git", ["clone", "--quiet", PST_LIBRARY.repo, lib], { stdio: "inherit" });
  }
  execFileSync("git", ["-C", lib, "checkout", "--quiet", PST_LIBRARY.commit], { stdio: "inherit" });

  log(`fetching Empty.pst (${EMPTY_PST.licence}) and checking its SHA-256`);
  const res = await fetch(EMPTY_PST.url);
  if (!res.ok) throw new Error(`Empty.pst: HTTP ${res.status} from ${EMPTY_PST.url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (sha256(bytes) !== EMPTY_PST.sha256) throw new Error(`Empty.pst SHA-256 is ${sha256(bytes)}, expected ${EMPTY_PST.sha256}: not used`);
  writeFileSync(`${template}.part`, bytes);
  renameSync(`${template}.part`, template);

  log("compiling the PST writer with csc.exe");
  const out = (name: string) => `/out:${join(cache, name)}`;
  execFileSync(CSC, ["/nologo", "/target:library", "/optimize+", out("Utilities.dll"), "/recurse:Utilities\\*.cs"], { cwd: lib, stdio: "inherit" });
  execFileSync(CSC, ["/nologo", "/target:library", "/optimize+", out("PSTFileFormat.dll"), `/r:${join(cache, "Utilities.dll")}`, "/r:System.ServiceProcess.dll", "/recurse:PSTFileFormat\\*.cs"], { cwd: lib, stdio: "inherit" });
  execFileSync(CSC, ["/nologo", "/optimize+", out("PstWriter.exe"), `/r:${join(cache, "PSTFileFormat.dll")}`, `/r:${join(cache, "Utilities.dll")}`, "/r:System.Web.Extensions.dll", WRITER_SOURCE], { stdio: "inherit" });
  return { exe, template };
}

/**
 * Writes `outPst` from a spec file (JSON lines, see PstWriter.cs) and returns, per message key,
 * its node id and folder path as the writer recorded them.
 */
export async function writePst(specPath: string, outPst: string, log?: (s: string) => void): Promise<Map<string, { nid: number; folder: string }>> {
  const { exe, template } = await ensurePstWriter(log);
  // Next to the spec (the work folder), never next to the PST: the corpus folder holds only mailboxes.
  const mapPath = specPath.replace(/\.spec\.jsonl$/, "") + `.${basename(outPst)}.nodes.tsv`;
  execFileSync(exe, [template, specPath, outPst, mapPath], { stdio: ["ignore", "inherit", "inherit"], maxBuffer: 1 << 20 });
  const map = new Map<string, { nid: number; folder: string }>();
  for (const line of readFileSync(mapPath, "utf8").split("\n")) {
    if (!line) continue;
    const [key, nid, folder] = line.split("\t");
    map.set(key!, { nid: parseInt(nid!, 16), folder: folder ?? "" });
  }
  return map;
}
