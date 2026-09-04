---
name: Public Solana RPC limits
description: Provider-specific limitation affecting top-holder evidence collection.
---

The public Solana mainnet RPC used by the radar rejects `getTokenLargestAccounts` with a method-specific throttling/unavailability response. The radar must not convert a missing top-holder response into a safe value.

**Why:** Repeated retries produced provider noise and could obscure whether the live scan itself was healthy.

**How to apply:** Treat top-holder coverage as unavailable unless RugCheck or an indexed provider supplies it. Keep the security/holder gates at `unknown` until a supported source provides the evidence.