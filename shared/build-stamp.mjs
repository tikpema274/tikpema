// build-stamp.mjs — read the baked-in provenance, or say plainly that there is none.
//
// Same discipline as resolveBuildId in ./dd-canary/health.mjs, and for the same reason: there is
// NO placeholder and NO sentinel string. An unstamped or malformed stamp resolves to
// {resolved:false, commit:null, tree:null} — never to a constant, because any constant compares
// equal to itself and that is precisely how the canary's version binding was silently a no-op
// until 1dd8f75.
//
// ⚠️ `dirty:true` means the deployed surface had uncommitted edits when it was stamped. The commit
// then NAMES a starting point but does not IDENTIFY the artifact. Only `tree` identifies it.

import { RAW_BUILD_STAMP } from "./build-stamp.generated.mjs";

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Values that must never be accepted as a real identifier, mirroring resolveBuildId's rejection
 *  of "unknown". A build that labels itself "unknown" is an unresolved build wearing a name. */
const NOT_AN_ID = new Set(["", "unknown", "none", "null", "undefined", "head", "dirty"]);

const usableHex = (v, re) =>
  typeof v === "string" && re.test(v.trim().toLowerCase()) && !NOT_AN_ID.has(v.trim().toLowerCase());

/**
 * @returns {{resolved:boolean, commit:string|null, dirty:boolean|null, tree:string|null,
 *            fileCount:number|null, generatedAt:string|null, detail:string}}
 */
export function buildStamp(raw = RAW_BUILD_STAMP) {
  const unresolved = (detail) => ({
    resolved: false, commit: null, dirty: null, tree: null, fileCount: null, generatedAt: null, detail,
  });

  if (raw === null || raw === undefined) {
    return unresolved(
      "no build stamp was baked into this artifact — it was deployed without running " +
        "scripts/stamp-build.mjs, so it cannot say which source produced it. This is reported as " +
        "UNRESOLVED rather than guessed: Netlify records commit_ref:null on CLI deploys, so there " +
        "is no other provenance to fall back to."
    );
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return unresolved("build stamp is malformed (not an object)");

  // The TREE is the identity — without it nothing else is trustworthy, so it gates the whole stamp.
  if (!usableHex(raw.tree, HEX64)) return unresolved("build stamp carries no usable tree hash");

  // A commit is optional (git may be unavailable) but must be a real SHA if present. A dirty tree
  // does NOT invalidate the stamp — it is reported, so the reader can weigh it.
  const commit = usableHex(raw.commit, HEX40) ? raw.commit.trim().toLowerCase() : null;
  const generatedAt =
    typeof raw.generatedAt === "string" && Number.isFinite(Date.parse(raw.generatedAt)) ? raw.generatedAt : null;

  return {
    resolved: true,
    commit,
    dirty: typeof raw.dirty === "boolean" ? raw.dirty : null,
    tree: raw.tree.trim().toLowerCase(),
    fileCount: Number.isInteger(raw.fileCount) ? raw.fileCount : null,
    generatedAt,
    detail:
      commit === null
        ? "tree hash resolved; no commit recorded (git unavailable at stamp time) — compare on tree"
        : raw.dirty === true
          ? "tree hash resolved; the deployed surface was DIRTY at stamp time, so the commit names a " +
            "starting point and does not identify this artifact — compare on tree"
          : "tree hash and commit both resolved; the deployed surface was clean at stamp time",
  };
}

/** True only when this artifact can name the source that produced it, with no uncommitted drift. */
export const provenanceIsBound = (s = buildStamp()) => s.resolved === true && s.commit !== null && s.dirty === false;
