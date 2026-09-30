import type { Rng } from "./prng.js";

/**
 * Invented content for the fake corpus. Person and company names are assembled from syllables,
 * so they belong to nobody; email domains use the reserved `.example` top-level domain
 * (RFC 2606); places and topics are generic. Nothing here comes from a real case.
 */

const FIRST_A = ["Kel", "Mor", "Tal", "Ves", "Bran", "Quil", "Dar", "Ise", "Oro", "Fen", "Zan", "Hol", "Nyr", "Cae", "Pell", "Rho"];
const FIRST_B = ["dra", "wyn", "ric", "sa", "ton", "lie", "mar", "ven", "a", "ius", "ette", "oa", "bec", "lin"];
const LAST_A = ["Mox", "Tol", "Brin", "Quar", "Hask", "Vell", "Dorn", "Pax", "Wim", "Gral", "Sten", "Ulv", "Crand", "Fetter"];
const LAST_B = ["on", "liver", "dale", "worth", "by", "ington", "ster", "ley", "mere", "cott", "haven", "ridge"];
const CO_A = ["Brindle", "Quarrow", "Veldt", "Hollin", "Marrow", "Tessel", "Corvane", "Ashgrove", "Pemberly", "Stoat", "Wrenfield", "Galloway"];
const CO_B = ["wick", "stone", "gate", "field", "moor", "brook", "crest", "lane"];
const CO_SUFFIX = ["Holdings Ltd", "Trading LLC", "Partners LLP", "Logistics Inc", "Capital SA", "Group plc", "Ventures GmbH", "Services Pty"];
const PLACES = ["Harbour Street", "North Quay", "Old Mill Road", "Kestrel Park", "the Eastern Depot", "Unit 14B", "the Riverside site", "Lantern Square"];
const TOPICS = [
  "the supply agreement", "the escrow release", "the warehouse lease", "invoice reconciliation", "the board minutes",
  "the freight schedule", "the loan facility", "the audit adjustments", "the shipment delay", "the settlement draft",
  "the pricing schedule", "the site inspection", "the customs declaration", "the licence renewal", "the insurance claim",
];
const VERBS = ["transferred", "invoiced", "approved", "disputed", "withheld", "confirmed", "queried", "signed", "returned", "forwarded"];
const OBJECTS = ["the revised figures", "a copy of the contract", "the payment instruction", "the delivery note", "the signed minutes", "the updated forecast"];
const CURRENCIES = ["USD", "EUR", "GBP", "CHF"];

export interface Person {
  first: string;
  last: string;
  company: Company;
  email: string;
}

export interface Company {
  name: string;
  domain: string;
}

export function makeCompany(rng: Rng): Company {
  const stem = rng.pick(CO_A) + rng.pick(CO_B);
  return { name: `${stem} ${rng.pick(CO_SUFFIX)}`, domain: `${stem.toLowerCase()}.example` };
}

export function makePerson(rng: Rng, company: Company): Person {
  const first = rng.pick(FIRST_A) + rng.pick(FIRST_B);
  const last = rng.pick(LAST_A) + rng.pick(LAST_B);
  return { first, last, company, email: `${first.toLowerCase()}.${last.toLowerCase()}@${company.domain}` };
}

/** A fixed epoch for every date in the corpus: 2019-01-01T00:00:00Z. */
export const BASE_TIME = Date.UTC(2019, 0, 1);

/** A date between 2019 and 2023, as a Date and as dd Month yyyy. */
export function makeDate(rng: Rng): Date {
  return new Date(BASE_TIME + rng.int(0, 5 * 365) * 86_400_000 + rng.int(0, 86_399) * 1000);
}

export function formatDate(d: Date): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function amount(rng: Rng): string {
  return `${rng.int(1, 950).toLocaleString("en-US")},${String(rng.int(0, 999)).padStart(3, "0")} ${rng.pick(CURRENCIES)}`;
}

/** One sentence of invented business prose. */
export function sentence(rng: Rng, people: Person[]): string {
  const a = rng.pick(people);
  const b = rng.pick(people);
  switch (rng.int(0, 4)) {
    case 0:
      return `On ${formatDate(makeDate(rng))}, ${a.first} ${a.last} of ${a.company.name} ${rng.pick(VERBS)} ${amount(rng)} to ${b.company.name} regarding ${rng.pick(TOPICS)}.`;
    case 1:
      return `${a.first} ${a.last} asked ${b.first} ${b.last} to send ${rng.pick(OBJECTS)} before the meeting at ${rng.pick(PLACES)}.`;
    case 2:
      return `The team at ${a.company.name} ${rng.pick(VERBS)} ${rng.pick(OBJECTS)} after reviewing ${rng.pick(TOPICS)}.`;
    case 3:
      return `Reference ${rng.int(1000, 9999)}-${rng.int(10, 99)}: ${rng.pick(TOPICS)} remains open pending ${rng.pick(OBJECTS)}.`;
    default:
      return `Please note that ${b.first} ${b.last} ${rng.pick(VERBS)} the figures on ${formatDate(makeDate(rng))} and copied ${a.email}.`;
  }
}

export function paragraph(rng: Rng, people: Person[], sentences = rng.int(3, 7)): string {
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) out.push(sentence(rng, people));
  return out.join(" ");
}

export function title(rng: Rng): string {
  const t = rng.pick(TOPICS).replace(/^the /, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** A long, realistic folder name (the sort that produces very long paths). */
export function longFolderName(rng: Rng, company: Company): string {
  const y = 2019 + rng.int(0, 3);
  return `${y}-${y + rng.int(1, 2)} Correspondence with ${company.name} regarding ${title(rng)} at ${rng.pick(PLACES)} (Final Versions and Drafts)`;
}

export const FOLDER_NAMES = ["Finance", "Legal", "Operations", "Board", "Email Exports", "Scans", "Contracts", "Invoices", "Shared", "Archive", "Old", "Misc", "HR", "Projects"];

export function safeFileStem(s: string): string {
  return s.replace(/[^A-Za-z0-9 ._-]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}
