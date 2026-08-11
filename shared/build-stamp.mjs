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

/**
 * ⭐⭐ THE DD HEALTH IDENTITY — a content hash of the DD surface, NOT the deploy id.
 *
 * The health artifact must be keyed by "which DD code is this", and the deploy id answered a
 * different question: "which deployment event was this". Those differ on every redeploy of identical
 * code (measured 2026-08-11: tree 931f6666… shipped twice under two deploy ids), and — the reason
 * this changed — they differ on every UNRELATED deploy. Over the last 40 commits, 20 touched the
 * stamped surface and only 2 touched DD; **18 were stamp-dirty but DD-clean**, and each of those
 * caused a DD refusal window once the service was public.
 *
 * 🚨 UNAVAILABLE ⇒ UNBOUND. `null`, never a fallback and NEVER the deploy id. A fallback both sides
 * compute identically is `unknown === unknown` wearing a new name — the exact fail-open the version
 * binding exists to close, and one this codebase has already shipped once (fixed in 1dd8f75).
 *
 * ⚠️ THIS IS A BUILD-TIME VALUE, WHICH MAKES THE STAMP SAFETY-CRITICAL. esbuild inlines shared/ into
 * each function, so the source files do not exist at runtime and cannot be re-hashed there. A deploy
 * that SKIPS stamping therefore carries a stale ddTree that both sides read identically — they would
 * match, and old canary evidence would vouch for new code. What contains it: `prebuild` regenerates
 * on every `npm run build`; `deploy:draft`/`deploy:prod` both run it; the COMMITTED value is `null`
 * (suite-asserted), so a skipped stamp yields UNBOUND rather than stale. A bare `netlify deploy`
 * that skips the build still bypasses this — the same bound as `--no-verify` on the pre-commit hook.
 *
 * @returns {{resolved:boolean, id:string|null, source:string|null, detail:string}}
 */
export function ddCodeIdentity(raw = RAW_BUILD_STAMP) {
  const unbound = (detail) => ({ resolved: false, id: null, source: null, detail });

  if (raw === null || raw === undefined) {
    return unbound(
      "no build stamp was baked into this artifact, so the DD surface cannot be identified. The " +
        "health record cannot be bound to code and MUST NOT be written or trusted. Run " +
        "`npm run build` (which stamps) before deploying."
    );
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return unbound("build stamp is malformed (not an object) — DD identity is UNBOUND");
  }
  if (!usableHex(raw.ddTree, HEX64)) {
    return unbound(
      "the build stamp carries no usable ddTree. Either it predates the DD-surface hash, or the " +
        "surface could not be fully read at stamp time (a missing file makes ddTree null on " +
        "purpose — a surface we cannot fully read is one we cannot claim to have hashed). " +
        "UNBOUND: the canary must refuse to write and dd-analyze must refuse to serve."
    );
  }
  return {
    resolved: true,
    id: raw.ddTree.trim().toLowerCase(),
    source: "build-stamp:ddTree",
    detail: `DD surface identified by content hash over ${
      Number.isInteger(raw.ddFileCount) ? raw.ddFileCount : "?"
    } files — a redeploy of identical DD code keeps the same identity, and any DD byte change mints a new one`,
  };
}
