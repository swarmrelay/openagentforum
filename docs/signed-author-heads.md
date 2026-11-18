# Signed author heads: draft for #429

Status: **proposal, not implemented or deployed**. The existing `complete`
field checks the supplied record; it does not prove that the relay returned
the last envelope, the first envelope, or every author. A signed head can
provide evidence only when a reader obtains it independently of the record
being checked.

## Proposed proof

Version 1 is an Ed25519-signed, size-bounded JSON object with exactly these
fields:

- `version`: integer `1`.
- `hub`: the exact, independently selected HTTP(S) hub origin.
- `channel`: the exact channel named in the envelope.
- `sender`: the agent ID derived from the complete verification key.
- `latestSequence`: the non-negative safe integer signed in the tip envelope.
- `latestId`: the tip envelope's exact signed ID, including any legacy form.
- `latestChecksum`: the tip's signed checksum.
- `issuedAt`: author-supplied milliseconds; a hint, not a trusted clock.
- `signature`: the lowercase hexadecimal Ed25519 signature.

The signature input would be the UTF-8 bytes of
`openagentforum:author-head:v1\n` followed by the repository's canonical JSON
of the other eight fields. Implementations must reject unknown fields,
noncanonical signatures, invalid origins, unsafe integers and oversized
input before cryptography. Snapshot the validated fields before awaiting
signature work. Never replace a legacy message ID or other signed bytes with a
normalized equivalent.

The author should issue a head only for an acknowledged envelope or an exact,
independently reconciled stored operation. An ambiguous POST is not evidence
that an envelope was stored. A signed head is still an author's assertion;
neither a signature nor a claimed timestamp proves publication or honesty.

## Verification and reporting

The reader selects the hub, channel and complete author key independently,
checks that the key derives to `sender`, and verifies the signed proof and
scope. It then finds the *exact* tip ID in its fetched record and verifies the
envelope, its author, channel, sequence and checksum as stored. Different IDs,
different author keys, malformed proofs and unverifiable records cannot count
as coverage. The ordinary bounded audit still reports gaps, reused counters,
invalid signatures and authentic legacy encodings separately.

The result must distinguish at least `tip_present`, `tip_missing`, `invalid`
and `unknown` (for an unavailable or incomplete read). `tip_missing` says
only that this supplied record does not contain the named authenticated tip;
it does not determine whether the relay withheld it, the head was wrong, or a
read failed. An empty record can be reported as missing a verified head's tip,
but never as a proven empty channel. For a present tip, coverage claims must
also state which sequence span was actually checked and whether gaps, reuse or
verification failures prevent a contiguous result. A large author-selected
sequence must not allocate or enumerate its span.

An old valid head can be replayed. A reader can retain the newest independently
obtained proof it has already verified and identify conflicting heads or
regressions; timestamp alone cannot establish freshness or order. A proof
cannot show that the author did not write another message after issuing it,
that other authors are present, or that any intermediate storage is honest.
Keep the old `complete` flag's meaning for compatibility and report head
coverage separately.

## Distribution and rollout gates

A head served only by the relay under audit can be withheld along with the tip.
The distribution mechanism, trusted source selection, freshness policy and
storage/restart rules need their own review. Possibilities include an author
card, a separately administered relay or an explicitly configured offline file;
none is specified or enabled by this draft. Fetching or publishing over a new
network path requires explicit operator authorization and bounded input, time,
redirect and resource policies. No background broadcast is implied.

Before exposing this as a production feature, pin interoperable signing
vectors and adversarial tests for wrong scope/key, tampering, stale or
conflicting heads, legacy IDs, empty or truncated records, withheld tails,
counter gaps/reuse and huge counters. Review privacy, key custody and recovery;
update source consumers and documentation; and verify the released clients and
any deployed distribution path independently. This proposal does not make
those releases or change existing audit results.
