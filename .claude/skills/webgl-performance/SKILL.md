---
name: webgl-performance
description: Keeping the browser fast and inside GPU memory limits with real-scale ocean data — texture budgets, typed arrays, half-float, level of detail, decimation, instancing, Web Workers, OffscreenCanvas, progressive and chunked streaming, avoiding GPU stalls and shader recompiles. Use this before writing any rendering or data-loading code that will eventually see full-resolution data, and whenever anything is slow, stuttering, crashing the tab, or "works with the sample file". This is the difference between a demo and something that survives real INCOIS volumes.
---

# WebGL Performance for Large Ocean Fields

A grid of Nx × Ny × Nz × Nt is easy to write and easy to underestimate. 512 × 512 ×
50 × 24 float32 is roughly 1.2 GB — far past what a browser tab will hold. Assume the
real dataset is 100–1000× the sample being developed against, and design for that
from the first commit.

## Budget first, code second

Before implementing a layer, compute its cost explicitly and write the number in a
comment:

```
bytes = Nx * Ny * Nz * channels * bytesPerChannel
```

Practical ceilings to design under:

- Total GPU texture memory in use: keep below ~500 MB; many integrated GPUs and most
  phones have far less.
- `MAX_3D_TEXTURE_SIZE` is commonly 2048 and can be as low as 256 on mobile. Query it
  (`gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)`) rather than assuming, and fall back to
  a decimated volume when the requested size does not fit.
- Draw calls: a few hundred per frame is comfortable, thousands is not.
- Time budget: 16.6 ms per frame at 60 fps, of which JavaScript should use ~4 ms.

## Reduce data before it reaches the GPU

In order of effectiveness:

1. **Subset server-side.** Never ship the whole dataset and slice in the browser. The
   API returns exactly the requested bbox, depth range, and timestep — see the
   `fastapi-ocean-api` skill.
2. **Decimate to screen resolution.** A field displayed across 1000 screen pixels
   gains nothing from 4000 grid columns. Choose the resolution level from the current
   camera distance and viewport size.
3. **Use half-float.** `HalfFloatType` halves memory versus float32 and its ~3 decimal
   digits of precision are more than display needs. For fields with a known range,
   8-bit normalized with min/max uniforms is another 2× saving and is often visually
   indistinguishable.
4. **Drop unused channels.** `RedFormat` for a single scalar, `RGFormat` for value
   plus mask. Uploading RGBA when only `.r` is read wastes 4×.

## Level of detail

Build a small pyramid of resolutions at ingest (full, ½, ¼) and swap the bound
texture based on camera distance. Swapping bindings is cheap; reallocating textures is
not — allocate each level once and keep it.

Apply the same idea temporally: while the time slider is being dragged, render a
coarse level and only load full resolution when it settles.

## Streaming and progressive loading

Load coarse first, refine after. A viewer that shows a blurry field in 200 ms and
sharpens over the next two seconds is judged much faster than one that shows nothing
for 1.5 s and then appears complete.

For large domains, chunk into tiles and load only tiles intersecting the frustum,
outward from the view centre. Cancel in-flight requests for tiles that have left the
view (`AbortController`) — otherwise fast panning queues dozens of downloads that
arrive after they are needed.

## Keep work off the main thread

Parsing, decompression, resampling, and marching cubes go in a Web Worker. Move
results with transferable `ArrayBuffer`s (`postMessage(buf, [buf])`) so nothing is
copied. For heavy off-screen rendering, `OffscreenCanvas` allows the whole renderer to
live in a worker, though it complicates event handling — adopt it only when the main
thread is measurably the bottleneck.

## Things that stall the GPU pipeline

- `gl.readPixels` / `renderer.readRenderTargetPixels` forces a full sync. If GPU
  results must come back for picking, use a 1×1 read, do it rarely, and prefer
  ray-based CPU picking or an ID buffer read on click only — never per frame.
- Changing `material.defines` or anything that triggers `needsUpdate` on the program
  recompiles the shader, costing tens of milliseconds. Vary behaviour with uniforms.
- Allocating typed arrays inside the render loop causes GC pauses. Preallocate and
  reuse scratch buffers.
- `texSubImage3D` of a large volume mid-frame blocks. Upload on a load event, not on
  a frame boundary, and consider uploading in slices across several frames.

## Adaptive quality

Wire a single quality level (ray-march step count, LOD index, particle count, device
pixel ratio) to a measured frame time with hysteresis. Drop quality during camera
movement, restore when idle. Clamp `renderer.setPixelRatio` to at most 2 — rendering
at 3× on a phone quadruples fragment cost for no visible gain on a volume render.

## Measuring rather than guessing

- `EXT_disjoint_timer_query_webgl2` for real GPU timings where available.
- `renderer.info` for draw calls, triangles, textures, programs — check it after any
  change that "shouldn't" affect performance.
- Chrome DevTools Performance panel for main-thread stalls; the Memory panel for
  leaks.
- Test on a mid-range Android device, not only a development laptop. Judges and
  reviewers will not all be on discrete GPUs.

## Cleanup

Every texture, render target, geometry, and material gets `.dispose()`d when its
dataset is replaced. Track allocations in one registry per layer so teardown is a
single call. Volumetric leaks are not slow degradation — they are a tab crash after
the third dataset switch.
