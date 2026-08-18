import { json } from "./_arc.mjs";

// dd-identity — THE MUTABLE COMPANION to the frozen ERC-8004 identity document.
//
// ═══ ⭐⭐ WHY THIS EXISTS: v1.0.0 NAMED A COMPANION THAT DID NOT RESOLVE ═════════════════════════
// The frozen document (CID bafkreigton…o2af4, agentId 851891) described its companion in PROSE — "a
// README in the public mirror" — with NO ADDRESS ANYWHERE IN THE DOCUMENT. The whole 28KB file
// contained exactly two URLs and both were RPC endpoints. So a verifier who followed tokenURI had no
// path to corrections at all: the companion existed in principle and was unreachable in practice.
// This route is that address.
//
// ═══ ⭐ TWO JOBS, AND THE SECOND IS THE ONE NOBODY PLANNED FOR ══════════════════════════════════
// 1. CORRECTIONS — anything that must change after the bytes are frozen: the current CID, the live
//    commit, errata. Supersession fixes the DOCUMENT; this reports the state between supersessions.
// 2. AVAILABILITY — public IPFS gateways are not uniformly reliable. Measured 2026-08-18: a COLD
//    fetch of the CID returned HTTP 504 from ipfs.io and dweb.link before succeeding; once warm all
//    three tested gateways served correct bytes in under 3.2s. A reviewer's FIRST fetch may fail, and
//    until now they had nowhere to go.
//
// ═══ 🚨 THIS ROUTE IS NOT AN AUTHORITY, AND SAYS SO IN ITS OWN PAYLOAD ══════════════════════════
// It is operator-controlled: DNS, TLS, contents and availability can all change with no on-chain
// record and no notice. THE CID CANNOT. So the trust ordering is immutable bytes → on-chain pointer
// (mutable, but movement is observable) → this (mutable, and its change is NOT observable).
// ⚠️ The service's product is flagging exactly this class of trusted-mutable-surface in other
// people's contracts. Shipping one without disclosing it would violate the document's own
// "does not exempt itself from its own findings" — so the disclosure is IN the response, not just in
// this comment, because a reader of the JSON is who needs it.
//
// ⚠️ READ-ONLY, UNAUTHENTICATED, AND HOLDS NO SECRETS — it is metadata about a public identity.
// ⚠️ NO CHAIN CALL: this route must answer even when an RPC is down, since being reachable when other
// things are not is its entire purpose. It reports what it was DEPLOYED with, and says so, rather
// than pretending to be a live oracle. A verifier who wants the live pointer reads tokenURI itself —
// which is exactly what the response tells them to do.

const AGENT_ID = "851891";
const OWNER = "0xc54D47211997aCA90Ef4fCfBc742a3b511B4e621";
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const CHAIN_ID = 5042002;

// ⭐ THE VERSION CHAIN, OLDEST FIRST. Every CID this identity has ever pointed at, PERMANENTLY —
// prior CIDs are never unpinned, because a report relied upon under an older document must stay
// checkable against the claims that were live when it was produced.
const VERSIONS = [
  {
    version: "1.0.0",
    cid: "bafkreigtonfmznrzbi3b34w27b5utra5jjcngc74skc7i67dymue3o2af4",
    sha256: "d3734accb6390a361df2daf87b49c41d4a44d30bfc9285f47be3c3284dbb402f",
    bytes: 28628,
    pinned: "permanently — two paid reports were produced under this document",
    superseded_by: "1.1.0",
    known_errata: [
      "Says NO WALLET EXISTS / NOTHING IS REGISTERED / NO agentId EXISTS. It was registered 2026-07-26 as agentId 851891.",
      "Says reports are NOT signed or attested by any identity. ERC-1271 report attestation is live.",
      "Leaves open whether this service registers under the same wallet as agentId 851823. It did — owner " + OWNER + ".",
    ],
  },
  {
    version: "1.1.0",
    cid: "bafkreib6viz4fqa4oqrrgxfecwcttxyda6ilm5nmzr7yplznqeahqmomla",
    sha256: "3eaa33c2c01c7423135ca4158539df030790b675accc7f87af2d81007831cc58",
    bytes: 18756,
    pinned: "permanently — every CID this identity has ever pointed at stays pinned, and the set only grows",
    superseded_by: null,
    known_errata: [],
    // 🚨 AN EMPTY ARRAY IS AN ABSENCE, AND ABSENCE MUST NOT READ AS SAFETY. Rendered bare, `[]` invites
    // "audited clean". It means nothing has been FOUND yet — which is a statement about how long this
    // document has existed, not about its accuracy.
    errata_note:
      "None recorded as of this deploy. That means nothing has been FOUND yet, NOT that this document " +
      "has been audited clean — v1.0.0 also carried none on the day it was frozen, and carries three now.",
  },
];

export async function handler(event) {
  if (event.httpMethod !== "GET" && event.httpMethod !== "HEAD") {
    return json(405, { error: "GET only", detail: "this is a read-only companion document" });
  }

  const current = VERSIONS.find((v) => !v.superseded_by) || VERSIONS[VERSIONS.length - 1];

  return json(200, {
    what_this_is:
      "The mutable companion to the frozen ERC-8004 identity document for agentId " + AGENT_ID + ". " +
      "It carries corrections that cannot go into frozen bytes, and serves as a fallback way to reach " +
      "those bytes when IPFS gateways do not.",

    // 🚨 FIRST FIELD ON PURPOSE. A reader must meet the limits of this surface before its contents.
    trust_ordering: {
      "1_immutable": "The document bytes. Content-addressed: hash them, compare to the CID. Cannot change.",
      "2_on_chain_pointer": "tokenURI(" + AGENT_ID + ") on " + REGISTRY + ". The operator can re-point it (setAgentURI, selector 0x0af28bd3) — but the move is an observable on-chain event.",
      "3_this_endpoint": "Operator-controlled. Its DNS, TLS, contents and availability can change with NO on-chain record and NO notice. Trust it LAST.",
      if_they_disagree: "The CID wins. Always. This endpoint being wrong is a possibility the design accounts for; the CID being wrong is not possible.",
      why_stated_here:
        "This service's product is flagging trusted-mutable-surfaces in other people's contracts. It does not exempt itself, and a disclosure only a source-code reader would see is not a disclosure.",
    },

    identity: {
      agent_id: AGENT_ID,
      owner: OWNER,
      registry: REGISTRY,
      chain_id: CHAIN_ID,
      network: "Arc Testnet",
      how_to_verify_independently: [
        "ownerOf(" + AGENT_ID + ") on " + REGISTRY + " should equal " + OWNER,
        "tokenURI(" + AGENT_ID + ") should equal ipfs://<the current CID below>",
        "Fetch that CID from any gateway and sha256 it — it should equal the sha256 recorded for that version.",
        "None of these steps requires trusting this endpoint.",
      ],
    },

    current_document: {
      version: current.version,
      cid: current.cid,
      sha256: current.sha256,
      bytes: current.bytes,
      ipfs_uri: "ipfs://" + current.cid,
      // ⚠️ SAID PLAINLY: this is what the route was DEPLOYED knowing, not a live chain read.
      caveat:
        "This is the CID this endpoint was deployed with. It is NOT a live read of tokenURI. It can " +
        "disagree with the chain in EITHER direction, and the chain wins both times: if the pointer has " +
        "already moved past this, this is STALE; if the pointer has not moved yet, this is AHEAD (see " +
        "pointer_expectation). Read tokenURI(" + AGENT_ID + ") yourself — that is the only authority here.",

      // ⭐ THE UPDATE ORDER IS DELIBERATE, AND A READER CAN LAND MID-SEQUENCE. Publishing a new version
      // is two operator actions that cannot be atomic: deploying this route, and sending setAgentURI.
      // Whichever goes first, there is a window where the two surfaces disagree — so the window is
      // spent in the direction that misleads least, and is described here rather than left to be
      // inferred by whoever happens to arrive during it.
      pointer_expectation:
        "This route is deployed BEFORE setAgentURI is sent, so during the changeover it runs AHEAD of the " +
        "chain rather than behind it. If tokenURI(" + AGENT_ID + ") still returns an earlier CID than the " +
        "one above, the move has not happened yet and THAT earlier document is still the authoritative one " +
        "— its entry below, errata included, describes it correctly. The reverse order was rejected: it " +
        "would hand a reader the NEW document off the chain while this endpoint still called it superseded, " +
        "which is the contradiction this companion exists to prevent.",
    },

    // ⭐ THE AVAILABILITY PATH. Gateways first, because a verifier should prefer a source that is not us.
    where_to_fetch_the_bytes: {
      prefer_a_gateway:
        "Fetch the CID from any IPFS gateway and verify the hash. Prefer this over asking us — a copy " +
        "you obtain independently and verify yourself is worth more than one we hand you.",
      gateways_tested_2026_08_18: [
        "https://gateway.pinata.cloud/ipfs/<cid> — served correct bytes",
        "https://ipfs.io/ipfs/<cid> — HTTP 504 on a COLD fetch, correct bytes once warm",
        "https://dweb.link/ipfs/<cid> — HTTP 504 on a COLD fetch, correct bytes once warm",
      ],
      follow_redirects: "Use curl -L. Gateways redirect to a subdomain form, and without -L you capture a 301 body and may mistake it for the document.",
      if_every_gateway_fails:
        "Then the document is unreachable, and content addressing does not fix that. Content addressing " +
        "guarantees any copy you DO obtain is the right one; it guarantees nothing about a copy existing " +
        "where you can reach it. That is a real limit and is stated rather than papered over.",
    },

    versions: VERSIONS.map((v) => ({
      version: v.version,
      cid: v.cid,
      sha256: v.sha256,
      pinned: v.pinned,
      superseded_by: v.superseded_by,
      known_errata: v.known_errata,
    })),

    pinning_obligation:
      "Every CID this identity has ever pointed at stays pinned FOREVER. Unpinning is not cleanup — it " +
      "retroactively destroys the verifiability of reports that were sold under that document. The set " +
      "only grows, one entry per supersession.",

    generated_by: "netlify/functions/dd-identity.mjs — static, no chain call, no secrets",
  });
}
