# Third-party notices

Pioneer Studio is licensed under AGPL-3.0-only. That license does not replace the
licenses of the following third-party software and assets.

## GNM talking-head runtime asset

`public/models/gnm-head.glb` was copied unchanged from
[`majidmanzarpour/threejs-talking-avatar`](https://github.com/majidmanzarpour/threejs-talking-avatar)
at commit `61ab8e3b1a14946b245926ac1b12e4f387b656ab`.

- Runtime SHA-256: `ef3aea507a8cc1eef24d9f9f4f5352a70a017faac5c6140f5ca8b72f94b37c81`
- Upstream project license: Apache License 2.0
- Underlying project: [Google GNM](https://github.com/google/GNM), commit
  `e26528fbf34d3fefd1a8f160d1b68641df78a586`, Apache License 2.0
- Modifications in Pioneer Studio: none to the GLB bytes; Pioneer Studio provides
  its own renderer, materials, expression controls, and speech integration.

The asset is a generic synthetic head, not an identity-specific scan. Distribution
must retain the Apache-2.0 terms and identify modifications. A copy of the Apache
License 2.0 appears in `licenses/Apache-2.0.txt`.

## Motion Previs Studio

The readiness scoring pattern, automation-control invariant, prompt-pack idea,
and browser camera-solve approach were independently reimplemented after studying
[Motion Previs Studio](https://github.com/wassermanproductions/motion-previs-studio),
licensed under Apache-2.0. Credit: Sam Wasserman / Wasserman Productions /
Wasserman.ai. No source file from that project is vendored here.

## NVIDIA ARDY skeleton definition

`src/ardySkeleton.ts` contains the CoreSkeleton27 joint hierarchy and rest-pose
coordinates derived from [`nv-tlabs/ardy`](https://github.com/nv-tlabs/ardy) at
commit `693f74d13b3d04a0a22ce127ee79c929dd89756b`.

- Upstream copyright: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
- Upstream code license: Apache License 2.0.
- Modifications in Pioneer Studio: the serialized joint data and hierarchy were
  converted into static TypeScript values and integrated with the browser stage.

The ARDY model checkpoints are separate from this source distribution and remain
subject to the terms published with those checkpoints.

## JavaScript dependencies

The resolved dependency graph and versions are recorded in `bun.lock`. Direct
runtime dependencies include React, Three.js, and `@pixiv/three-vrm`; their own
license notices remain authoritative. The Draco and Basis runtime decoders are
copied from the locked Three.js package during `bun run setup` and are not tracked
as Pioneer Studio source.

## Fonts and hosted services

The application requests Space Grotesk and JetBrains Mono from Google Fonts at
runtime. Generation, media storage, speech, and model inference use the Pioneer
API and remain subject to the user's Pioneer account and applicable service terms.
