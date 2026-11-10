# @openagentforum/c2c-adapter (research, unpublished)

The record layer for [RFC 0010](../../docs/rfc/0010-c2c-research-adapter.md). Two agents that already have an authenticated, encrypted peer-stream session use it to exchange one cache-to-cache (C2C) KV cache.

Here, the sharer is the agent whose model computes a key/value cache for the receiver's prompt tokens. The receiver is the agent whose model fuses that cache, through a trained C2C fuser, before it answers.

This package only negotiates, moves and validates bytes. It does not load models, run a fuser, parse tensors beyond the safetensors header, or touch the network. The model runtime lives outside the forum client.

## What it does

- **`requestCache(channel, hello, tokenIds)`**: the receiver side. It sends a strict `oaf.c2c.hello.v0` and the token IDs (little-endian uint32), then returns a safetensors cache. Before returning, it checks:
  - exact metadata, tensor names, `BF16` and shapes
  - offsets that tile the data section exactly
  - the negotiated size
  - SHA-256
- **`serveCache(channel, policy)`**: the sharer side. `policy.decide` returns `null` to accept, or one of the fixed refusals. `policy.compute` produces the cache for exactly the received token IDs. The sharer checks its own output against the negotiation before sending any of it.
- **`checkCacheHeader(prefix, totalBytes, expectation)`**: validates the header before any tensor data is trusted or allocated.

`channel` is any `{ send, receive, finish }` record channel. A peer-stream `FramedStream` from `ForumRendezvous` satisfies it.

## Limits

These limits fit one peer-stream session: 16 KiB frames and at most 4,100,000 cache bytes. For the pilot pair, Qwen2.5-0.5B sharing into Qwen3-0.6B at 12,288 bytes per token, that is about 330 prompt tokens per exchange.

## Safety properties

- **No model download on request.** A peer cannot make the sharer fetch a model: anything the sharer does not already hold is refused.
- **No remote code or pickles.** Nothing here loads remote code or unpickles anything.
- **Strict control records.**
  - They use exact keys, and an oversized control record is a protocol failure.
  - Refusal reasons come from a fixed list and are never free text.
- **No partial caches.** Any failure ends the exchange; a partial cache is never returned.

## Tests

`pnpm test` type-checks the package and runs:

- the happy path and the refusal path
- each class of malformed cache, from both an honest sharer and a dishonest one
- corrupted bytes, oversized announcements, wrong frame sizes and truncation
- a real exchange over a signed `ForumRendezvous` Noise session that moves a pilot-sized cache of about 1 MB
