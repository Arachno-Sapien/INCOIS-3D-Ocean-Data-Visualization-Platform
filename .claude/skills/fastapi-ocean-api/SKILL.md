---
name: fastapi-ocean-api
description: Building the FastAPI backend that subsets ocean datasets and serves them to the browser — async endpoints, Pydantic request validation, binary array responses, streaming, dataset handle caching, request size limits, CORS, pagination, background processing, and error handling. Use this for any route, endpoint, schema, serializer, or server-side data access code, and any time the question is "how does the frontend get this data" — including small additions like "add an endpoint for the profile list".
---

# FastAPI Ocean Data API

The backend exists so the browser never sees a whole NetCDF file. Every endpoint's
job is to return the smallest correct payload for a specific view.

```
Browser  ──►  bbox + depth range + time + variable  ──►  FastAPI
                                                            │
                                            xarray subset (lazy → compute)
                                                            │
Browser  ◄──  binary float32 array + JSON header  ◄─────────┘
```

## Validate the request with Pydantic, not with ifs

Define a request model that encodes the physical constraints, so invalid requests are
rejected with a useful 422 before any I/O happens:

```python
from pydantic import BaseModel, Field, model_validator

class SubsetQuery(BaseModel):
    variable: str
    west: float = Field(ge=-180, le=180)
    east: float = Field(ge=-180, le=180)
    south: float = Field(ge=-90, le=90)
    north: float = Field(ge=-90, le=90)
    depth_min: float = Field(0, ge=0)
    depth_max: float = Field(1000, ge=0)
    time: datetime

    @model_validator(mode="after")
    def check(self):
        if self.south >= self.north:
            raise ValueError("south must be less than north")
        if self.depth_min >= self.depth_max:
            raise ValueError("depth_min must be less than depth_max")
        return self
```

`west > east` is legal (antimeridian crossing) and must be handled, not rejected.
Whitelist `variable` against the dataset's actual variables — never interpolate a
user string into a path or a file name.

## Cap the response size

Estimate the cell count from the request before computing anything, and reject
oversized requests with 413 and a message stating the limit and the estimate:

```python
cells = nx * ny * nz
if cells > MAX_CELLS:
    raise HTTPException(413, f"Requested {cells:,} cells exceeds limit {MAX_CELLS:,}. "
                             f"Reduce the area, depth range, or request a coarser stride.")
```

Support a `stride`/`resolution` parameter so clients have an obvious way to comply.
Without this cap, one careless request pins the server and takes the whole demo down.

## Async is not automatically concurrent

xarray, netCDF4, and h5py are blocking and mostly hold the GIL. Declaring a route
`async def` and then calling `.compute()` inside it blocks the event loop and
serializes every other request.

Either define the route as plain `def` (FastAPI runs it in a threadpool automatically)
or keep it `async def` and offload explicitly:

```python
from starlette.concurrency import run_in_threadpool
arr = await run_in_threadpool(subset_and_compute, query)
```

For CPU-heavy work beyond I/O, use a process pool — threads will not help.

## Send binary, not JSON

JSON-encoding a million floats produces roughly ten times the bytes and parses
orders of magnitude slower than a typed array. Return raw little-endian float32 with
the metadata in headers or a companion JSON endpoint:

```python
return Response(
    content=arr.astype("<f4").tobytes(),
    media_type="application/octet-stream",
    headers={
        "X-Shape": json.dumps(list(arr.shape)),
        "X-Dtype": "float32",
        "X-Fill": str(FILL_SENTINEL),
        "X-Units": units,
        "Cache-Control": "public, max-age=3600",
    },
)
```

The frontend reads it with `new Float32Array(await res.arrayBuffer())` and uploads
straight to the GPU with no per-value JavaScript. Keep coordinate vectors (lat, lon,
depth arrays) in a separate small JSON response — they are needed for axes and are
tiny.

Replace NaN with an explicit sentinel before sending, and state it in the header;
NaN does not survive GPU filtering, and JSON cannot represent it at all.

## Cache dataset handles

Opening a NetCDF file costs tens to hundreds of milliseconds, and `open_mfdataset`
far more. Open once at startup or on first use and keep the handle:

```python
@lru_cache(maxsize=8)
def get_dataset(key: str) -> xr.Dataset:
    return xr.open_dataset(PATHS[key], chunks={})
```

Bound the cache — each open handle holds file descriptors and Dask graph state. Add a
warm-up on startup (`lifespan`) so the first user request is not the one paying for
the open.

Cache computed subsets keyed by the normalized query, with an ETag so repeat requests
return 304. Grid data is immutable once published, so cache aggressively.

## Streaming and long work

Use `StreamingResponse` for large exports or multi-timestep animations so the client
can begin work before the whole payload arrives. For anything taking more than a few
seconds (regridding, video export), return 202 with a job id and expose a status
endpoint; do not hold an HTTP connection open for a minute.

`BackgroundTasks` is fine for fire-and-forget side effects (logging, cache warming)
but not for work the client needs the result of.

## CORS

Configure `CORSMiddleware` with an explicit origin list from settings. Do not ship
`allow_origins=["*"]` together with `allow_credentials=True` — browsers reject that
combination, and it is a real security hole regardless. Expose the custom headers the
frontend reads:

```python
expose_headers=["X-Shape", "X-Dtype", "X-Fill", "X-Units"]
```

Custom response headers are invisible to cross-origin JavaScript unless listed here,
which produces a confusing "the header is in DevTools but undefined in code" bug.

## Errors

Map failures to the right status and a message that tells the client what to change:

- 400 / 422 — malformed or physically invalid request
- 404 — unknown variable or dataset
- 413 — request too large, include the limit
- 416 — requested region or time lies outside the dataset domain
- 503 — dataset temporarily unavailable (upstream THREDDS/ERDDAP down)

Never return a stack trace or a filesystem path to the client. Log the detail server
side with the request parameters attached so it can be reproduced.

## Structure

Keep routes thin. Put subsetting, unit handling, and coordinate logic in a service
layer that can be unit-tested without HTTP, and keep the CF/coordinate rules from the
`netcdf-xarray` skill in that layer rather than in route handlers. Version the API
(`/api/v1/...`) from the start.
