---
name: threejs-ocean
description: Building or editing the 3D ocean rendering layer with Three.js — volumetric temperature/salinity fields, depth slices, isosurfaces, clipping planes, current-vector glyphs, GPU particle advection, colormaps, vertical exaggeration, and time interpolation. Use this whenever the work touches Three.js, WebGL, GLSL, shaders, Data3DTexture, InstancedMesh, volume rendering, ray marching, or drawing ocean fields on screen — even if the request just says "show the temperature field" or "make the currents animate" without naming a library.
---

# Three.js Ocean Rendering

The renderer draws 4D gridded ocean fields (lat × lon × depth × time) plus sparse
in-situ observations. Everything below assumes WebGL2 through `THREE.WebGLRenderer`
unless the project has explicitly migrated to WebGPU.

## The one rule that matters most

**Never regenerate geometry on the CPU per frame.** No rebuilding `BufferGeometry`,
no `new Mesh()` in the render loop, no looping over grid cells in JavaScript to move
things. Data lives in GPU textures and buffers; frames change *uniforms*. If a change
seems to require new geometry, first ask whether it can be a uniform, an attribute
update, or a shader branch.

A useful test: if the code has `for` over anything close to grid size inside
`requestAnimationFrame`, it is wrong for this project's data volumes.

## Representing the scalar field

Upload a 3D scalar field (temperature, salinity, chlorophyll) as a `Data3DTexture`:

```js
const tex = new THREE.Data3DTexture(data, nx, ny, nz); // Float32Array or Uint16 half-float
tex.format = THREE.RedFormat;
tex.type = THREE.FloatType;          // HalfFloatType halves memory, usually enough
tex.minFilter = tex.magFilter = THREE.LinearFilter;
tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
tex.unpackAlignment = 1;
tex.colorSpace = THREE.NoColorSpace;  // data, not color — never sRGB
tex.needsUpdate = true;
```

Notes that cause real bugs:

- Linear filtering of full `FloatType` textures needs `OES_texture_float_linear`.
  `HalfFloatType` filters natively in WebGL2 — prefer it and check the extension
  before assuming float-linear works.
- Setting `colorSpace` to sRGB on a data texture silently corrupts values. Only
  colormap LUTs get sRGB.
- Normalize the physical value range on the CPU and pass `uDataMin`/`uDataMax`
  uniforms, or keep raw values and pass the range. Pick one and be consistent —
  mixing the two is a common source of "the colors look wrong" reports.

### Missing data

Ocean grids are mostly land and below-bathymetry cells. NaN propagates through
hardware linear filtering and poisons neighbouring texels, so **do not** leave NaN
in a filtered texture. Instead:

- Replace fill values with a neutral in-range value, and
- upload a separate mask channel (or use `RGFormat`, `.r` = value, `.g` = validity)
  that the shader tests before shading, discarding or making transparent where the
  interpolated mask drops below ~0.5.

## Volume rendering by ray marching

Standard setup: a `BoxGeometry` covering the data domain, `THREE.BackSide`, so the
fragment shader runs on back faces and marches from the camera toward them.

In the fragment shader:

1. Compute ray origin/direction in the box's local space.
2. Intersect with the unit box (slab method) for `tNear`/`tFar`.
3. March with a fixed step count uniform (`uSteps`, typically 64–256).
4. Sample `texture(uVolume, p)`, map through the colormap, composite front-to-back.
5. Early-terminate when accumulated alpha exceeds ~0.99.
6. Jitter the start offset per fragment (`fract(sin(dot(gl_FragCoord.xy, ...)))` or a
   small blue-noise texture) to break up slice banding.

Expose `uSteps` as an adaptive quality knob: drop it while the camera moves, raise it
when idle. That single control is usually the difference between 15 fps and 60 fps.

## Isosurfaces

Two valid approaches; choose deliberately:

- **Ray-marched isosurface** — march until the field crosses the threshold, refine
  with a few bisection steps, shade using a gradient computed from central
  differences of the volume texture. No geometry, instant threshold changes, and it
  composites with the volume. Prefer this for an interactive threshold slider.
- **Marching cubes on the CPU/worker** — produces real geometry that can be picked,
  exported, and lit conventionally, but costs a rebuild on every threshold change.
  Only use it when the mesh itself is a deliverable, and always build it in a Web
  Worker with transferable buffers.

## Depth slicing and clipping

Use Three's clipping planes rather than rebuilding meshes:

```js
renderer.localClippingEnabled = true;
material.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), depthPlaneY)];
material.clipShadows = false;
```

For an arbitrary depth slice, render a single quad and sample the volume at the
constant depth coordinate — much cheaper than clipping the whole volume.

## Colormaps

Store each colormap as a 256×1 `DataTexture` (RGBA8, `LinearFilter`,
`ClampToEdgeWrapping`, `SRGBColorSpace`). Look it up with the normalized value:

```glsl
float t = clamp((value - uMin) / (uMax - uMin), 0.0, 1.0);
vec3 rgb = texture(uColormap, vec2(t, 0.5)).rgb;
```

Swapping colormaps is then a texture swap, not a shader recompile. Changing
`#define`s or `defines` on a material **does** trigger recompilation and a frame
hitch — keep variation in uniforms where possible.

See the `scientific-visualization` skill for which colormaps are appropriate.

## Current vectors

Use one `InstancedMesh` of arrow/cone geometry, sized to the glyph budget (not the
grid size — decimate). Update `instanceMatrix` only when the sampling grid changes;
per-frame orientation from `u`/`v` belongs in a vertex shader reading an instanced
attribute or a data texture.

Scale glyph length by speed with a nonlinear (e.g. sqrt) mapping so slow regions stay
visible, and always render a scale reference in the UI.

## Particle advection

Do it as GPGPU ping-pong on the GPU, never in JavaScript:

- Positions live in a float render target (`WebGLRenderTarget`, `HalfFloatType`).
- Each step, a fragment shader reads position, samples the velocity 3D texture,
  integrates (RK2 is a good accuracy/cost balance; Euler drifts visibly in eddies),
  writes the new position.
- Particles that leave the domain or land on invalid cells get respawned from a
  seed texture; keep a per-particle age so trails fade instead of popping.
- Render with `Points` or an `InstancedMesh` whose vertex shader reads the position
  texture.

`examples/jsm/misc/GPUComputationRenderer.js` handles the ping-pong plumbing and is
worth using rather than reimplementing.

Velocities are in m/s while positions are in scene units — do the unit conversion
once in a uniform (`uMetersToScene`, `uDtSeconds`), and remember the `u`/`v` to
degrees conversion depends on latitude (see the `geospatial-ocean` skill).

## Vertical exaggeration

Depth ranges over ~5 km while horizontal extent is often thousands of km, so an
exaggeration factor of 50–500× is normal. Apply it in exactly one place — a
`uVerticalExaggeration` uniform used when mapping depth to scene Y — and never by
scaling the object, which breaks lighting normals and ray-march step lengths.

When exaggeration changes, isosurface normals must be re-derived with the same
factor or the shading tilts incorrectly. Always display the current factor on screen.

## Time interpolation

Bind two 3D textures (`uVolumeA`, `uVolumeB`) and a `uMix` uniform, and `mix()` the
sampled values. Prefetch the next timestep during idle frames so scrubbing doesn't
stall. Only swap texture bindings when crossing a step boundary — that is a cheap
operation; reallocating the texture is not.

## Version hygiene

Three.js renames things often. Confirm against the installed version before using
API names from memory. Recent renames worth knowing: `DataTexture3D` → `Data3DTexture`,
`outputEncoding` → `outputColorSpace`, `sRGBEncoding` → `SRGBColorSpace`,
`WebGLRenderer.useLegacyLights` removed. If the code and the docs disagree, trust
`node_modules/three/build/three.module.js`.

## Disposal

Every `Data3DTexture`, render target, geometry, and material must be `.dispose()`d
when a dataset is swapped. Volumetric textures are tens to hundreds of MB; leaking
two or three of them crashes the tab. Centralize this in one teardown function per
layer rather than scattering dispose calls.
