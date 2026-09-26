# Native capture-repair regression

The repaired path passed at source `a171d05836888c35c68bcc24564cfe1661c74231`, after the stopped campaign had fully drained. This was a **synthetic, injected known-answer regression**, excluded from benchmark results. Its supplied one-line proof is not evidence of model problem-solving ability.

One actual native Codex subscription session (`gpt-6-astra`, `xhigh`, normal tier) made two isolated Docker exec calls. The first wrote a valid canonical proof and a harmless extra JSON draft. The owner captured and strictly replayed the canonical proof while recording the ignored draft. The second exec replaced the live canonical file with an empty array. The owner retained the earlier one-line incumbent, and final strict replay passed. The extra draft was absent from owner submissions and the final archive.

The check took 13.726 seconds under a 90-second/eight-tool cap. One native session and two tools were used; no delegation, owner-dispatched retries, alternative providers or API-key inference occurred. Native process-group and stdio cleanup was confirmed. The original runtime-3 image and owner referee identities were unchanged.

The [sanitized receipt](capture-repair-canary.json) records exact source, evaluator, client, runtime, referee, proof and checkpoint hashes. It exposes no credentials, raw native events, prompts, host paths or private reasoning. Local track tests additionally cover links, special/oversized files, cutoff behavior and strict historical manual import. This regression verifies the exercised path, not universal sandbox or verifier soundness.
